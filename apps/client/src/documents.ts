// Documents sent with the distilled knowledge: the files (PDF, Word, Excel…) an AI session worked on (read by Claude
// Code, opened by a Codex command, dropped in the prompt) go to the brain with the facts distilled from that session,
// filed in the same zone. Nothing else: never a folder scan, never a file outside the home folder, never a hidden one.
// Checked here (name, size, secrets and personal data for the formats readable without pdf.js), then again by the brain,
// which reads every file (PDFs included) and refuses it if needed: a file is sent as is, or not at all.

import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  AUTO_DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MAX_BYTES,
  documentBaseName,
  documentExtension,
  documentFormat,
  documentProblems,
  formatBytes,
  type AddDocumentResult,
  type BrainDocument,
  type SourceTool,
} from "@brain/core"
import { extractDocumentText } from "@brain/core/document-text"
import { ApiError, BrainApi } from "./api"
import { UserError, requireConfig, type State } from "./config"

const EXT = AUTO_DOCUMENT_EXTENSIONS.join("|")
/**
 * A path in a text: quoted ("…/Revenus T3.pdf"), or a run without blanks where `\ ` escapes a space (a file dropped in a
 * terminal), possibly an @mention (@docs/spec.pdf). Ends on a document extension.
 */
const QUOTED_RE = new RegExp(String.raw`["'\`]([^"'\`\n]{1,400}?\.(?:${EXT}))["'\`]`, "gi")
const BARE_RE = new RegExp(String.raw`(?:^|[\s=(\[{,])(@?(?:\\.|[^\s"'\`<>|()\[\]{},;\\]){1,400}?\.(?:${EXT}))(?=$|[\s"'\`)\]},;:!?]|\.(?:\s|$))`, "gim")

function expand(p: string, cwd: string | undefined, home: string): string {
  const raw = p.replace(/^@/, "").replace(/\\(.)/g, (m, c: string) => (/[\s()&'"\[\]{}]/.test(c) ? c : m))
  if (raw === "~" || raw.startsWith("~/")) return join(home, raw.slice(2))
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd ?? home, raw)
}

/** Paths of documents named in a message, absolute (relative ones against the session's folder). */
export function documentPathsInText(text: string, cwd?: string, home = homedir()): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(QUOTED_RE)) out.add(expand(m[1], cwd, home))
  // Quoted paths taken out first: "Budget 2027.xlsx" must not also give "2027.xlsx".
  for (const m of text.replace(QUOTED_RE, " ").matchAll(BARE_RE)) out.add(expand(m[1], cwd, home))
  return [...out]
}

/** Path a Claude Code tool call opens: the Read tool's `file_path`, or the files a Bash command names (`pdftotext x.pdf`). */
export function documentPathsInToolUse(b: { name?: unknown; input?: unknown }, cwd: string | undefined, home = homedir()): string[] {
  const input = (b.input ?? {}) as { file_path?: unknown; command?: unknown }
  if (b.name === "Read" && typeof input.file_path === "string")
    return AUTO_DOCUMENT_EXTENSIONS.includes(documentExtension(input.file_path)) ? [expand(input.file_path, cwd, home)] : []
  if (b.name === "Bash" && typeof input.command === "string") return documentPathsInText(input.command, cwd, home)
  return []
}

/** Codex: the files named by a command it runs (`pdftotext revenus.pdf`, `python read.py report.xlsx`) or in the prompt. */
export function documentPathsInCodexLine(j: Record<string, unknown>, home = homedir()): string[] {
  const p = (j.type === "response_item" && j.payload && typeof j.payload === "object" ? j.payload : j) as Record<string, unknown>
  const type = typeof p.type === "string" ? p.type : ""
  if (!/^(?:function_call|custom_tool_call|local_shell_call)$/.test(type)) return []
  const raw = [p.arguments, p.input, p.action].map((x) => (typeof x === "string" ? x : x ? JSON.stringify(x) : "")).join("\n")
  let args: { workdir?: unknown; cwd?: unknown } = {}
  try {
    args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : ((p.action as object) ?? {})
  } catch {
    // free-form arguments: the paths are looked for in the text as is
  }
  const cwd = typeof args.workdir === "string" ? args.workdir : typeof args.cwd === "string" ? args.cwd : undefined
  // JSON-escaped strings: a quoted path inside the command keeps its quotes once unescaped.
  return documentPathsInText(raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"), cwd, home)
}

/** Folders whose files never leave the computer, even if a session read them. */
function isPrivatePath(rel: string): boolean {
  const parts = rel.split(sep)
  if (parts.some((s) => s.startsWith(".") || s === "node_modules")) return true
  // macOS: ~/Library holds app data; only the synced drives (iCloud, Google Drive, OneDrive, Dropbox) are documents.
  if (parts[0] === "Library") return !(parts[1] === "Mobile Documents" || parts[1] === "CloudStorage")
  // Windows: AppData, same idea.
  return parts[0] === "AppData"
}

export type DocumentCandidate = { path: string; name: string; size: number; mtime: number }

/** Why a path is not a document to send (null: it is one), on a cheap check of the file (no reading). */
export function documentCandidate(path: string, opts: { home?: string; brainHome?: string } = {}): DocumentCandidate | { skipped: string } {
  const home = resolve(opts.home ?? homedir())
  const name = documentBaseName(path)
  if (!AUTO_DOCUMENT_EXTENSIONS.includes(documentExtension(name))) return { skipped: "format not sent automatically" }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return { skipped: "file not found" }
  }
  const rel = relative(home, real)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { skipped: "outside the home folder" }
  if (opts.brainHome && !relative(resolve(opts.brainHome), real).startsWith("..")) return { skipped: "brain client folder" }
  if (isPrivatePath(rel)) return { skipped: "hidden or application folder" }
  let st
  try {
    st = statSync(real)
  } catch {
    return { skipped: "file not found" }
  }
  if (!st.isFile() || st.size === 0) return { skipped: "not a file" }
  if (st.size > DOCUMENT_MAX_BYTES) return { skipped: `too large (${formatBytes(st.size)}, ${formatBytes(DOCUMENT_MAX_BYTES)} at most)` }
  return { path: real, name, size: st.size, mtime: Math.round(st.mtimeMs) }
}

/**
 * The file's bytes, its fingerprint, and the reasons not to send it (checked on the computer). `chosen`: the person
 * sends it themselves (`docs add`), a file without readable text is accepted.
 */
export async function readDocument(c: DocumentCandidate, opts: { chosen?: boolean } = {}): Promise<{ bytes: Buffer; sha256: string; problems: string[] }> {
  const bytes = readFileSync(c.path)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  // PDFs: no pdf.js on the computer (it would weigh more than the whole client); the brain checks them on arrival.
  const { text } = await extractDocumentText(bytes, c.name)
  const readable = documentFormat(c.name)?.reader !== "pdf"
  const problems = documentProblems(c.name, readable ? text : null, { requireText: readable && !opts.chosen })
  return { bytes, sha256, problems }
}

/** Documents remembered by the sync (fingerprint → brain id, or refusal): bounded to the most recent. */
export const DOCUMENTS_REMEMBERED = 500

function remember(state: State, sha256: string, entry: { id?: string; refused?: string }) {
  const docs = (state.documents ??= {})
  docs[sha256] = { ...entry, at: new Date().toISOString() }
  const keys = Object.keys(docs)
  if (keys.length > DOCUMENTS_REMEMBERED)
    for (const k of keys.sort((a, b) => docs[a].at.localeCompare(docs[b].at)).slice(0, keys.length - DOCUMENTS_REMEMBERED)) delete docs[k]
}

/** A document to send with the knowledge of its session. */
export type DocumentJob = { path: string; item_ids: string[]; zone?: string; source: { app: string; tool: SourceTool; at: string } }

export type DocumentOutcome =
  | { path: string; name: string; status: "sent" | "linked"; zone: string; id: string }
  | { path: string; name: string; status: "skipped" | "refused" | "failed"; reason: string }

/**
 * Sends the documents (each one once: a file already sent is only linked to the new knowledge, by its fingerprint).
 * A refusal (secret, personal data, unreadable PDF) is remembered: the same file is not offered again. A network
 * failure only loses the link: the knowledge has gone, the next session that reads the file sends it.
 */
export async function sendDocuments(
  api: Pick<BrainApi, "uploadDocument">,
  jobs: DocumentJob[],
  state: State,
  opts: { home?: string; brainHome?: string } = {},
): Promise<DocumentOutcome[]> {
  const out: DocumentOutcome[] = []
  // Same file named by several sessions: one sending, linked to all their knowledge.
  const byPath = new Map<string, DocumentJob>()
  for (const j of jobs) {
    const prev = byPath.get(j.path)
    byPath.set(j.path, prev ? { ...prev, item_ids: [...new Set([...prev.item_ids, ...j.item_ids])] } : j)
  }
  for (const job of byPath.values()) {
    const name = documentBaseName(job.path)
    const c = documentCandidate(job.path, opts)
    if ("skipped" in c) {
      out.push({ path: job.path, name, status: "skipped", reason: c.skipped })
      continue
    }
    let fingerprint: string | undefined
    try {
      const { bytes, sha256, problems } = await readDocument(c)
      fingerprint = sha256
      const known = state.documents?.[sha256]
      if (known?.refused) {
        out.push({ path: c.path, name, status: "refused", reason: known.refused })
        continue
      }
      if (problems.length) {
        remember(state, sha256, { refused: problems[0] })
        out.push({ path: c.path, name, status: "refused", reason: problems[0] })
        continue
      }
      const base = { name, sha256, item_ids: job.item_ids, zone: job.zone, source: job.source, agent: "brain-sync", auto: true } as const
      let res: AddDocumentResult | null = null
      if (known?.id) {
        try {
          res = await api.uploadDocument(base)
        } catch (err) {
          // Removed from the brain since: sent again, with its content.
          if (!(err instanceof ApiError && err.status === 404)) throw err
        }
      }
      res ??= await api.uploadDocument({ ...base, content: bytes.toString("base64") })
      remember(state, sha256, { id: res.document.id })
      out.push({ path: c.path, name, status: res.created ? "sent" : "linked", zone: res.document.zone, id: res.document.id })
    } catch (err) {
      const e = err as Error
      if (err instanceof ApiError && (err.status === 422 || err.status === 413 || err.status === 400)) {
        const reason = e.message.replace(/^The brain answered \d+: /, "")
        if (fingerprint) remember(state, fingerprint, { refused: reason })
        out.push({ path: c.path, name, status: "refused", reason })
      } else out.push({ path: c.path, name, status: "failed", reason: e.message })
    }
  }
  return out
}

/** "2 documents sent (revenus-T3.pdf → finance, …), 1 refused (secret)". */
export function documentsLine(outcomes: DocumentOutcome[]): string {
  const sent = outcomes.filter((o) => o.status === "sent" || o.status === "linked")
  const refused = outcomes.filter((o) => o.status === "refused")
  const failed = outcomes.filter((o) => o.status === "failed")
  const parts: string[] = []
  if (sent.length)
    parts.push(
      `${sent.length} document${sent.length > 1 ? "s" : ""} sent with the knowledge (${sent
        .slice(0, 4)
        .map((o) => `${o.name} → ${"zone" in o ? o.zone : "?"}`)
        .join(", ")}${sent.length > 4 ? ", …" : ""})`,
    )
  if (refused.length) parts.push(`${refused.length} kept on the computer (${refused.slice(0, 2).map((o) => `${o.name}: ${"reason" in o ? o.reason : ""}`).join("; ")})`)
  if (failed.length) parts.push(`${failed.length} not sent (${"reason" in failed[0] ? failed[0].reason : "?"})`)
  return parts.join(", ")
}

/** `docs add <file…>`: the person sends documents themselves (any accepted format, wherever the file is). */
async function addFiles(api: BrainApi, files: string[], flags: Record<string, string | boolean>, log: (s: string) => void): Promise<number> {
  if (!files.length) throw new UserError("docs add: give one or more files (PDF, Word, Excel, PowerPoint, CSV, Markdown, text).")
  const zone = typeof flags.zone === "string" ? flags.zone.trim() : undefined
  const title = typeof flags.title === "string" ? flags.title.trim() : undefined
  let failures = 0
  for (const file of files) {
    const path = resolve(file)
    const name = documentBaseName(path)
    const fail = (why: string) => {
      failures++
      log(`  ✗ ${name}: ${why}`)
    }
    if (!documentFormat(name)) {
      fail(`format not accepted (${DOCUMENT_FORMATS.map((f) => `.${f.ext}`).join(", ")})`)
      continue
    }
    let st
    try {
      st = statSync(path)
    } catch {
      fail("file not found")
      continue
    }
    if (!st.isFile() || st.size === 0) {
      fail("not a file, or empty")
      continue
    }
    if (st.size > DOCUMENT_MAX_BYTES) {
      fail(`too large (${formatBytes(st.size)}, ${formatBytes(DOCUMENT_MAX_BYTES)} at most)`)
      continue
    }
    const { bytes, problems } = await readDocument({ path, name, size: st.size, mtime: st.mtimeMs }, { chosen: true })
    if (problems.length) {
      fail(`stays on the computer: ${problems.join(" ")}`)
      continue
    }
    try {
      const res = await api.uploadDocument({
        name,
        content: bytes.toString("base64"),
        zone,
        title: files.length === 1 ? title : undefined,
        source: { app: "brain docs add", tool: "agent", at: new Date().toISOString() },
        agent: "claude-code",
      })
      log(`  ✓ ${name} (${formatBytes(st.size)}) ${res.created ? "added to" : "already in"} the brain, zone ${res.document.zone} — id ${res.document.id}`)
    } catch (err) {
      fail((err as Error).message.replace(/^The brain answered \d+: /, ""))
    }
  }
  return failures ? 1 : 0
}

/** `docs [list] [--zone z] [--search q]` and `docs add <file…> [--zone z] [--title t]`. */
export async function cmdDocs(positional: string[], flags: Record<string, string | boolean>, log: (s: string) => void = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token, 30000)
  const [sub = "list", ...rest] = positional
  if (sub === "add") return addFiles(api, rest, flags, log)
  if (sub !== "list") throw new UserError(`docs: "list" or "add" (got "${sub}").`)
  const q = new URLSearchParams()
  if (typeof flags.zone === "string") q.set("zone", flags.zone.trim())
  if (typeof flags.search === "string") q.set("q", flags.search.trim())
  const { documents } = await api.request<{ documents: BrainDocument[] }>("GET", `/api/documents${q.toString() ? `?${q}` : ""}`)
  if (!documents.length) {
    log("No document in your zones yet. They come with the knowledge of the sessions that use them, or with `docs add <file>`.")
    return 0
  }
  for (const d of documents) log(`- ${d.name} (${formatBytes(d.size)}) — ${d.title} · zone ${d.zone} · ${d.created_at.slice(0, 10)} · id ${d.id}`)
  return 0
}
