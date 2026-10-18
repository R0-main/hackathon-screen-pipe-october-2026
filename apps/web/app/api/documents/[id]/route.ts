import { AGENTS, type AgentName } from "@brain/core"
import { getStore } from "@/lib/store"
import { canDeleteDocument, documentErrorResponse, getDocumentFor, recordDocumentRead, removeDocument, withDocuments } from "@/lib/documents"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Shown in the browser rather than downloaded: PDF and plain text only (never markup). */
const INLINE = new Set(["application/pdf", "text/plain", "text/csv", "text/markdown", "text/tab-separated-values"])

/**
 * A readable document: its metadata, its text and the knowledge it backs. `?download=1`: the file itself (shown in
 * the browser for a PDF or a text, downloaded otherwise). `?agent=mcp`: read by an agent, its zone lights up.
 */
export const GET = withViewer<Ctx>(async (req, viewer, { params }) => {
  const { id } = await params
  const doc = await getDocumentFor(viewer, id)
  if (!doc) return error(404, "Document not found.")
  const url = new URL(req.url)
  if (url.searchParams.get("download") === "1") {
    const content = await getStore().getDocumentContent(id)
    if (!content) return error(404, "Document not found.")
    const inline = INLINE.has(doc.mime) && url.searchParams.get("attachment") !== "1"
    return new Response(new Uint8Array(content), {
      headers: {
        "content-type": doc.mime.startsWith("text/") ? `${inline ? "text/plain" : doc.mime}; charset=utf-8` : doc.mime,
        "content-length": String(content.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    })
  }
  const agent = url.searchParams.get("agent")
  if (agent && (AGENTS as readonly string[]).includes(agent)) await recordDocumentRead(viewer, doc, agent as AgentName)
  const store = getStore()
  const [items, profiles] = await Promise.all([Promise.all(doc.item_ids.map((i) => store.getItem(i))), store.listProfiles()])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const readable = items.filter((i): i is NonNullable<typeof i> => i !== null && !i.superseded_by && (viewer.access.readable.includes(i.zone) || i.author_id === viewer.profile.id))
  return json({
    document: { ...doc, author: names.get(doc.author_id) ?? "?", can_delete: canDeleteDocument(viewer, doc) },
    items: (await withDocuments(viewer, readable)).map((i) => ({ ...i, author: names.get(i.author_id) ?? "?" })),
  })
})

/** Removes the document (its author or an admin); the knowledge it backed stays. */
export const DELETE = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  try {
    await removeDocument(viewer, id)
    return json({ deleted: id })
  } catch (err) {
    return documentErrorResponse(err)
  }
})
