// Documents: the original files (PDF, Word, Excel, PowerPoint, CSV…) that go to the brain alongside the distilled
// knowledge. "Q3 revenue: €1.24M" is the fact; the revenue PDF it was read from travels with it, filed in the same zone
// and readable with the same rights. Browser-safe: text extraction (node:zlib) lives in ./document-text.

import { z } from "zod"
import { AGENTS, SOURCE_TOOLS } from "./types"
import { looksPersonal, redact } from "./privacy"
import { normalize, truncate } from "./text"

export type DocumentFormat = {
  ext: string
  mime: string
  label: string
  /** How its text is read: pdf (pdf.js, on the brain), zip (Office / OpenDocument XML), plain (UTF-8). */
  reader: "pdf" | "zip" | "plain"
}

export const DOCUMENT_FORMATS: DocumentFormat[] = [
  { ext: "pdf", mime: "application/pdf", label: "PDF", reader: "pdf" },
  { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word", reader: "zip" },
  { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel", reader: "zip" },
  { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint", reader: "zip" },
  { ext: "odt", mime: "application/vnd.oasis.opendocument.text", label: "OpenDocument text", reader: "zip" },
  { ext: "ods", mime: "application/vnd.oasis.opendocument.spreadsheet", label: "OpenDocument spreadsheet", reader: "zip" },
  { ext: "odp", mime: "application/vnd.oasis.opendocument.presentation", label: "OpenDocument presentation", reader: "zip" },
  { ext: "csv", mime: "text/csv", label: "CSV", reader: "plain" },
  { ext: "tsv", mime: "text/tab-separated-values", label: "TSV", reader: "plain" },
  { ext: "md", mime: "text/markdown", label: "Markdown", reader: "plain" },
  { ext: "txt", mime: "text/plain", label: "Text", reader: "plain" },
]

/**
 * Formats the sync sends on its own when an AI session worked on the file: business documents only. A README or a
 * notes.txt Claude Code reads in a repository is not a company document (`brain docs add` still sends them).
 */
export const AUTO_DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "csv"]

/** 3 MB: once in base64 in a JSON body, the upload stays under the 4.5 MB a Vercel function accepts. */
export const DOCUMENT_MAX_BYTES = 3 * 1024 * 1024
/** Extracted text kept for search and for agents (get_document). */
export const DOCUMENT_TEXT_MAX = 200_000
export const DOCUMENT_SUMMARY_MAX = 600

/** What a knowledge item or a search result shows of an attached document. */
export type DocumentRef = { id: string; name: string; mime: string; zone: string; size: number }

/** A document as stored in the brain (without its bytes nor its full text). */
export type BrainDocument = {
  id: string
  org_id: string
  name: string
  mime: string
  size: number
  sha256: string
  zone: string
  title: string
  /** Start of its text, for lists and search results. */
  summary: string
  pages?: number
  author_id: string
  source: { app: string; tool: string; at: string }
  /** Knowledge items it backs (the facts distilled from the session that read it). */
  item_ids: string[]
  created_at: string
}

export type BrainDocumentWithText = BrainDocument & { text: string }

export type ScoredDocument = BrainDocument & { score: number }

/**
 * Response of POST /api/documents. `created`: false if the brain already had this file (it was linked to the new
 * items). A file the brain already keeps in a zone the sender does not read only comes back as a DocumentRef.
 */
export type AddDocumentResult = { document: BrainDocument | DocumentRef; created: boolean; linked: number }

export function documentExtension(name: string): string {
  const m = name.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)
  return m ? m[1] : ""
}

export function documentFormat(name: string): DocumentFormat | null {
  const ext = documentExtension(name)
  return DOCUMENT_FORMATS.find((f) => f.ext === ext) ?? null
}

/** Last segment of a path, without the folders (never sent: they name the person's computer). */
export function documentBaseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim() ?? ""
}

/** "revenus-T3_2026.pdf" → "revenus T3 2026". */
export function documentTitle(name: string): string {
  const base = documentBaseName(name).replace(/\.[a-z0-9]{1,8}$/i, "")
  const t = base.replace(/[_]+/g, " ").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim()
  return truncate(t || base || "Document", 160)
}

/** Text squeezed onto readable lines (pdf.js and the XML readers leave runs of blanks). */
export function cleanDocumentText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .split("\n")
    .map((l) => l.replace(/[  ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The first lines of the text, cut on a word: what lists and search results show. */
export function documentSummary(text: string, max = DOCUMENT_SUMMARY_MAX): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max)
}

/**
 * File names that are a person's papers, not company documents (payslip, ID, tax notice, sick note, CV…). Not
 * "résumé" (a meeting summary in French) nor "ordonnance" (also a legal text): their content is checked anyway.
 */
const PERSONAL_DOCUMENT_RE =
  /\b(?:payslips?|pay ?slips?|pay ?stubs?|fiches? de paie|bulletins? de (?:paie|salaire)|passports?|passeports?|carte d.?identite|id ?card|identity card|carte vitale|driver.?s? licen[cs]e|permis de conduire|avis d.?imposition|tax return|tax notice|arret (?:de travail|maladie)|sick note|curriculum vitae|cv|birth certificate|acte de naissance|livret de famille)\b/

/** Redactions that are personal identifiers rather than secrets. */
const IDENTIFIERS = ["email", "phone_fr", "phone_intl", "phone_us", "iban"]
const ALWAYS_REFUSED = ["card", "nir", "ssn"]
/** Beyond this many emails, phones or IBANs, the file is a contact list or a customer file, not a document to share. */
export const DOCUMENT_MAX_IDENTIFIERS = 10

/**
 * Why a document must not go into the brain (empty if all is well). A document cannot be redacted the way a
 * knowledge item is (a PDF is not rewritten): it goes as is, or not at all.
 * `requireText`: without readable text (a scan), nothing can be checked; the sync then sends nothing.
 */
export function documentProblems(name: string, text: string | null, opts: { requireText?: boolean } = {}): string[] {
  const problems: string[] = []
  const base = documentBaseName(name)
  const plainName = normalize(base.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_\-.]+/g, " "))
  if (PERSONAL_DOCUMENT_RE.test(plainName)) problems.push("Its name says it is a personal paper (payslip, ID, tax notice, health, CV…).")
  if (!documentFormat(base)) problems.push(`Format not accepted: ${DOCUMENT_FORMATS.map((f) => `.${f.ext}`).join(", ")}.`)
  if (text === null || !text.trim()) {
    if (opts.requireText) problems.push("No readable text (scanned document?): it cannot be checked, so it is not sent.")
    return problems
  }
  const { redactions } = redact(text)
  const secrets = Object.keys(redactions).filter((k) => !IDENTIFIERS.includes(k) && !ALWAYS_REFUSED.includes(k))
  if (secrets.length) problems.push(`It contains a secret (${secrets.slice(0, 4).join(", ")}).`)
  const sensitive = ALWAYS_REFUSED.filter((k) => redactions[k])
  if (sensitive.length) problems.push(`It contains sensitive personal data (${sensitive.join(", ")}).`)
  const identifiers = IDENTIFIERS.reduce((n, k) => n + (redactions[k] ?? 0), 0)
  if (identifiers > DOCUMENT_MAX_IDENTIFIERS) problems.push(`It lists personal data (${identifiers} emails, phone numbers or IBANs): a contact list or a customer file stays on the computer.`)
  if (looksPersonal(`${base}\n${text.slice(0, 50_000)}`)) problems.push("Its content looks personal.")
  return problems
}

/** Base64 length of DOCUMENT_MAX_BYTES (4 characters per 3 bytes, padding included). */
const MAX_BASE64 = Math.ceil(DOCUMENT_MAX_BYTES / 3) * 4

/**
 * POST /api/documents: a document, linked to knowledge items if any. Without `content`, `sha256` names a document the
 * brain already has (sent by an earlier sync): it is only linked to the new items, nothing is sent again.
 */
export const DocumentUploadSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** The file, in base64. */
    content: z.string().min(1).max(MAX_BASE64 + 4).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Zone to file it in; otherwise that of its first item, otherwise classified from its text. */
    zone: z.string().min(1).max(64).optional(),
    title: z.string().max(200).optional(),
    item_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
    /** Sent by the sync on its own (not chosen by the person): a file without readable text cannot be checked, it is refused. */
    auto: z.boolean().default(false),
    source: z
      .object({
        app: z.string().max(120).default("unknown"),
        tool: z.enum(SOURCE_TOOLS).default("agent"),
        at: z.string().max(40).default(() => new Date().toISOString()),
      })
      .optional(),
    agent: z.enum(AGENTS).optional(),
  })
  .refine((d) => d.content !== undefined || d.sha256 !== undefined, { message: "content (base64) or sha256 is required" })

export type DocumentUploadInput = z.input<typeof DocumentUploadSchema>

/** Short label of a size: "820 KB", "2.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}
