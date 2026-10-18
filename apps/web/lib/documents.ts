// Documents in the brain: the files (PDF, Word, Excel…) sent with the distilled knowledge by the sync, by
// `brain docs add` or from the dashboard. Filed in a zone, read with the same rights as its knowledge (the zone's
// readers, the admins, the author); the facts distilled from the session that read the file link to it.
//
// The brain re-reads every file (text extraction, pdf.js for PDFs) and refuses it if it holds a secret or personal
// data: a file cannot be redacted the way a knowledge item is, it is kept as is or not at all. Its text, used for the
// search and given to agents (get_document), is redacted.

import { createHash } from "node:crypto"
import {
  DOCUMENT_MAX_BYTES,
  classifyZones,
  documentBaseName,
  documentFormat,
  documentProblems,
  documentSummary,
  documentTitle,
  formatBytes,
  redactText,
  truncate,
  type AddDocumentResult,
  type AgentName,
  type BrainDocument,
  type BrainDocumentWithText,
  type DocumentRef,
  type DocumentUploadInput,
} from "@brain/core"
import { extractDocumentText, type PdfReader } from "@brain/core/document-text"
import { canRead } from "./access"
import type { Viewer } from "./auth"
import { error } from "./http"
import { getStore, isStoreSetupError } from "./store"

export class DocumentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message)
  }
}

/** Expected refusal (format, size, secret…): its status and message; any other error goes up to withViewer (500). */
export function documentErrorResponse(err: unknown): Response {
  if (err instanceof DocumentError) return error(err.status, err.message, err.details)
  throw err
}

/** pdf.js (through unpdf, its serverless build), loaded on the first PDF only. */
const readPdf: PdfReader = async (bytes) => {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const pdf = await getDocumentProxy(bytes)
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: true })
    return { text: Array.isArray(text) ? text.join("\n\n") : text, pages: totalPages }
  } finally {
    await pdf.loadingTask.destroy().catch(() => {})
  }
}

/** Same rule as knowledge: the zone's readers (admins included) and the author (right of review). */
export function canSeeDocument(viewer: Viewer, doc: Pick<BrainDocument, "zone" | "author_id">): boolean {
  return canRead(viewer.access, doc.zone) || doc.author_id === viewer.profile.id
}

/** Removing a document: its author or an admin (the person actually signed in, not the one viewed as). */
export function canDeleteDocument(viewer: Viewer, doc: Pick<BrainDocument, "author_id">): boolean {
  return viewer.real.role === "admin" || doc.author_id === viewer.real.id
}

export function documentRef(d: BrainDocument): DocumentRef {
  return { id: d.id, name: d.name, mime: d.mime, zone: d.zone, size: d.size }
}

/** Read paths (search, lists): a database not migrated yet simply has no documents. */
async function orNone<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run()
  } catch (err) {
    if (!isStoreSetupError(err)) throw err
    console.error("[documents]", err.message)
    return []
  }
}

/** Knowledge items the uploader may link a document to: theirs, or readable ones. */
async function linkableItems(viewer: Viewer, ids: string[]) {
  const store = getStore()
  const items = await Promise.all([...new Set(ids)].slice(0, 50).map((id) => store.getItem(id)))
  return items.filter((i): i is NonNullable<typeof i> => i !== null && (i.author_id === viewer.real.id || canRead(viewer.access, i.zone)))
}

/**
 * POST /api/documents — a document enters the brain, linked to knowledge items if any. The same file (same
 * fingerprint) already in the company is not stored twice: it is linked to the new items. Without `content`, `sha256`
 * names such a document (a later sync of a file already sent): 404 if the brain does not have it.
 * `auto` (sent by the sync on its own): a file without readable text cannot be checked, it is refused.
 */
export async function addDocument(viewer: Viewer, input: DocumentUploadInput & { item_ids: string[]; auto?: boolean }): Promise<AddDocumentResult> {
  const store = getStore()
  const agent: AgentName = input.agent ?? "dashboard"
  const name = truncate(documentBaseName(input.name), 200)
  const format = documentFormat(name)
  if (!format) throw new DocumentError(400, `Format not accepted for "${name}".`, documentProblems(name, null))
  const items = await linkableItems(viewer, input.item_ids)
  const link = async (doc: BrainDocument): Promise<AddDocumentResult> => {
    const linked = items.length ? ((await store.linkDocument(doc.id, items.map((i) => i.id))) ?? doc) : doc
    // The same file filed in a zone the sender does not read: they have its bytes, not its metadata.
    return { document: canSeeDocument(viewer, linked) ? linked : documentRef(linked), created: false, linked: items.length }
  }

  if (input.content === undefined) {
    const existing = input.sha256 ? await store.findDocumentBySha(input.sha256) : null
    if (!existing) throw new DocumentError(404, "Unknown document: send its content.")
    return link(existing)
  }
  const bytes = Buffer.from(input.content, "base64")
  if (!bytes.length) throw new DocumentError(400, "Empty document.")
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new DocumentError(413, `Document too large (${formatBytes(bytes.length)}): ${formatBytes(DOCUMENT_MAX_BYTES)} at most.`)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (input.sha256 && input.sha256 !== sha256) throw new DocumentError(400, "The content does not match its sha256 fingerprint.")
  const existing = await store.findDocumentBySha(sha256)
  if (existing) return link(existing)

  if (format.reader === "pdf" && !bytes.subarray(0, 1024).includes("%PDF-")) throw new DocumentError(400, `"${name}" is not a PDF.`)
  const { text, pages } = await extractDocumentText(bytes, name, { pdf: readPdf })
  const problems = documentProblems(name, text, { requireText: input.auto === true })
  if (problems.length) throw new DocumentError(422, "Document refused: it stays on the computer.", problems)

  const zones = await store.listZones()
  const known = new Set(zones.map((z) => z.id))
  const title = truncate(redactText(input.title?.trim() || documentTitle(name)), 160)
  const clean = redactText(text ?? "")
  const zone =
    (input.zone && known.has(input.zone) ? input.zone : undefined) ??
    items.find((i) => known.has(i.zone))?.zone ??
    classifyZones(`${title}\n${clean.slice(0, 20_000)}`, zones, 1)[0] ??
    zones[0]?.id
  if (!zone) throw new DocumentError(400, "The brain has no zone to file this document in.")
  const document = await store.insertDocument({
    name,
    mime: format.mime,
    size: bytes.length,
    sha256,
    zone,
    title,
    summary: documentSummary(clean),
    ...(pages ? { pages } : {}),
    author_id: viewer.real.id,
    source: {
      app: truncate(input.source?.app ?? "dashboard", 120),
      tool: input.source?.tool ?? "agent",
      at: input.source?.at && Number.isFinite(Date.parse(input.source.at)) ? new Date(Math.min(Date.parse(input.source.at), Date.now())).toISOString() : new Date().toISOString(),
    },
    item_ids: items.map((i) => i.id),
    text: clean,
    content: bytes,
  })
  // Neon: the document's zone lights up, like a knowledge item.
  await store.insertEvents([
    { user_id: viewer.real.id, agent, type: "write", zones: [zone], summary: truncate(`Document added: ${name}`, 200), at: new Date().toISOString() },
  ])
  return { document, created: true, linked: items.length }
}

/** Documents attached to these knowledge items that the viewer may open, by item. */
export async function documentsForItems(viewer: Viewer, itemIds: string[]): Promise<Map<string, DocumentRef[]>> {
  const out = new Map<string, DocumentRef[]>()
  if (!itemIds.length) return out
  const wanted = new Set(itemIds)
  const docs = await orNone(() => getStore().listDocuments({ itemIds, zones: viewer.access.readable, orAuthorId: viewer.profile.id, limit: 500 }))
  for (const d of docs)
    for (const id of d.item_ids) {
      if (!wanted.has(id)) continue
      const list = out.get(id) ?? []
      if (!list.some((x) => x.id === d.id)) list.push(documentRef(d))
      out.set(id, list)
    }
  return out
}

/** Knowledge items with their readable documents (`documents` absent when there is none). */
export async function withDocuments<T extends { id: string }>(viewer: Viewer, items: T[]): Promise<(T & { documents?: DocumentRef[] })[]> {
  const by = await documentsForItems(viewer, items.map((i) => i.id))
  return items.map((i) => (by.has(i.id) ? { ...i, documents: by.get(i.id) } : i))
}

/** Documents whose name or text matches the query, in the searched zones (and the viewer's own). */
export async function searchDocumentsFor(viewer: Viewer, query: string, zones: string[], limit = 5) {
  return orNone(() => getStore().searchDocuments(query, zones, limit, { authorId: viewer.profile.id }))
}

/** Documents page: the readable ones, most recent first (optionally one zone). */
export async function listDocumentsFor(viewer: Viewer, f: { zone?: string; limit?: number } = {}) {
  return orNone(() => getStore().listDocuments({ zones: viewer.access.readable, orAuthorId: viewer.profile.id, zone: f.zone, limit: f.limit ?? 300 }))
}

/** A readable document with its text; null if it does not exist or is not readable (nothing said about it). */
export async function getDocumentFor(viewer: Viewer, id: string): Promise<BrainDocumentWithText | null> {
  const doc = await getStore().getDocument(id)
  return doc && canSeeDocument(viewer, doc) ? doc : null
}

/** An agent opens a document (MCP get_document): its zone lights up, as for a search. */
export async function recordDocumentRead(viewer: Viewer, doc: BrainDocument, agent: AgentName) {
  await getStore().insertEvents([
    { user_id: viewer.real.id, agent, type: "query", zones: [doc.zone], summary: truncate(`Reads the document ${doc.name}`, 200), at: new Date().toISOString() },
  ])
}

/** DELETE /api/documents/:id — its author or an admin. */
export async function removeDocument(viewer: Viewer, id: string): Promise<void> {
  const store = getStore()
  const doc = await store.getDocument(id)
  if (!doc || !canSeeDocument(viewer, doc)) throw new DocumentError(404, "Document not found.")
  if (!canDeleteDocument(viewer, doc)) throw new DocumentError(403, "Only the document's author or an admin can remove it.")
  await store.deleteDocument(id)
}
