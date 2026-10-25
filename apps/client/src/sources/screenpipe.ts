// "Screenpipe" source: local REST API (http://localhost:3030 by default).
// Reference: "screenpipe-api" skill shipped in screenpipe-mcp (screenpipe repo, commit 9dc0fd0) and anas.md.
// - headers: Authorization: Bearer <local token>, X-Screenpipe-Client: api, X-Screenpipe-Agent: company-brain;
// - GET /search: pages of 100 (no server cap; the skill's "limit ≤ 20" is meant for an agent's context, not for a
//   sync), filter_pii=true (native redaction on the computer), content_type "parsed" (structured messages
//   items[] + actors[]) then "accessibility" then "ocr"; browser_url is used to recognize a ChatGPT / Claude tab;
// - GET /meetings + /meetings/:id/transcript: each finished meeting becomes a "meeting" conversation;
// - GET /workflows + /workflows/:id: repetitive workflows with their real occurrences (timingRuns).
// Reading by growing time windows: the checkpoint never moves past what was read in full.

import {
  classifyZones,
  fnv1a,
  isAllowedApp,
  looksPersonal,
  normalize,
  redact,
  truncate,
  type Conversation,
  type ConversationMessage,
  type SourceTool,
} from "@brain/core"
import type { Workflow } from "../api"
import type { SeenLines, State } from "../config"
import { DEFAULT_SCREENPIPE_CONTENT_TYPES } from "../config"
import { toIso } from "./jsonl"
import type { CheckpointCommit, SourceResult } from "./types"

export type ScreenpipeItem = {
  type: string
  text: string
  app: string
  window: string
  at: string
  frameId?: string
  /** Tab URL when Screenpipe gives it (browsers): decides whether a tab is an AI assistant. */
  browserUrl?: string
  messages?: ConversationMessage[]
}

export type ScreenpipeOptions = {
  url: string
  token?: string
  since: Date
  until?: Date
  contentTypes?: string[]
  whitelist?: string[]
  pageSize?: number
  maxPages?: number
  gapMinutes?: number
  timeoutMs?: number
  /** Size of the first read window (learned on a previous pass), in ms. */
  spanMs?: number
  /** Names under which the employee appears (brain account): their messages are "user", the rest "assistant". */
  selfNames?: string[]
}

/** Smallest read window: below it, we read what we can. */
export const MIN_SPAN_MS = 60_000
/** Rows per /search page (the server imposes no cap; we paginate with `offset`). */
export const DEFAULT_PAGE_SIZE = 100
/** Maximum meetings distilled per pass; the rest goes on the next pass (checkpoint per meeting). */
export const MAX_MEETINGS_PER_PASS = 10
/** Workflows whose details (occurrences) we fetch per pass. */
export const WORKFLOW_DETAIL_MAX = 8

/** Attribution requested by the API: fixed value "api", and a fixed application id (never dynamic). */
export const CLIENT_HEADERS: Record<string, string> = { "x-screenpipe-client": "api", "x-screenpipe-agent": "company-brain" }

/** Command that shows Screenpipe's local API token (the one from the official skill). */
export const TOKEN_COMMAND = "npx -y screenpipe@latest auth token"

function headers(token?: string): Record<string, string> {
  return { accept: "application/json", ...CLIENT_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

class ScreenpipeDown extends Error {}

async function getJson(url: string, token: string | undefined, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  let res: Response
  try {
    res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new ScreenpipeDown((err as Error).name === "TimeoutError" ? "timeout" : ((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message))
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { status: res.status, data }
}

export async function screenpipeHealth(url: string, token?: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  try {
    const { status, data } = await getJson(`${url.replace(/\/+$/, "")}/health`, token, timeoutMs)
    if (status >= 400) return { ok: false, detail: `HTTP ${status}${status === 401 || status === 403 ? " (Screenpipe token required?)" : ""}` }
    const s = (data as { status?: string } | null)?.status
    return { ok: true, detail: s ? `status "${s}"` : "answers" }
  } catch (err) {
    return { ok: false, detail: `unreachable (${(err as Error).message})` }
  }
}

export type ScreenpipeProbe = {
  /** ok: /search answers; token_required: 401/403; error: other HTTP; down: unreachable. */
  auth: "ok" | "token_required" | "error" | "down"
  /** The semantic parser produces "parsed" rows (24 h); null if we could not tell. */
  parsed: boolean | null
  detail: string
}

/** /health does not need a token: only /search says whether the token is right and whether the semantic parser is on. */
export async function screenpipeProbe(url: string, token?: string, timeoutMs = 4000): Promise<ScreenpipeProbe> {
  const base = url.replace(/\/+$/, "")
  const qs = new URLSearchParams({ content_type: "parsed", start_time: "24h ago", end_time: "now", limit: "1", offset: "0", filter_pii: "true" })
  try {
    const { status, data } = await getJson(`${base}/search?${qs}`, token, timeoutMs)
    if (status === 401 || status === 403) return { auth: "token_required", parsed: null, detail: `HTTP ${status}: local API token required (${TOKEN_COMMAND})` }
    if (status >= 400) return { auth: "error", parsed: null, detail: `HTTP ${status} on /search` }
    const d = data as { data?: unknown[] } | unknown[] | null
    const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
    return {
      auth: "ok",
      parsed: list.length > 0,
      detail: list.length > 0 ? "token OK, semantic parser on (\"parsed\" data over 24 h)" : "token OK, no \"parsed\" data over 24 h (semantic parser off, or no AI app used)",
    }
  } catch (err) {
    return { auth: "down", parsed: null, detail: `unreachable (${(err as Error).message})` }
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
}

function roleOf(v: unknown): "user" | "assistant" | null {
  const r = str(v).toLowerCase()
  if (["user", "human", "me", "moi"].includes(r)) return "user"
  if (["assistant", "ai", "model", "bot", "claude", "chatgpt", "codex"].includes(r)) return "assistant"
  return null
}

const ASSISTANT_LABEL_RE = /^(assistant|ai|bot|model|chatgpt|gpt(-?[0-9a-z.]+)?|openai|claude|anthropic|codex|gemini|bard|copilot|mistral|le chat|perplexity|deepseek|llama|grok|cursor|windsurf|kimi|qwen)$/i
const SELF_LABEL_RE = /^(you|vous|moi|me|user|utilisateur|utilisatrice|human|humain)$/i

/**
 * Role of a "parsed" message: the parser's original label (`items[].actor`, e.g. "You", "ChatGPT") decides;
 * the name resolved by Screenpipe (`actors[].name`) and the employee's name settle doubts. In an AI tool, everything that
 * is not the assistant comes from the employee.
 */
export function roleOfActor(label: string, resolvedName = "", selfNames: string[] = []): "user" | "assistant" {
  const l = label.trim()
  if (ASSISTANT_LABEL_RE.test(l)) return "assistant"
  if (SELF_LABEL_RE.test(l)) return "user"
  const mine = (n: string) => n.trim() && selfNames.some((s) => s.trim().toLowerCase() === n.trim().toLowerCase())
  if (mine(l) || mine(resolvedName)) return "user"
  if (resolvedName && ASSISTANT_LABEL_RE.test(resolvedName.trim())) return "assistant"
  return "user"
}

type ParsedItem = { local_id?: unknown; parent_local_id?: unknown; kind?: unknown; title?: unknown; body?: unknown; actor?: unknown; occurred_at?: unknown }

/** Messages of a "parsed" row (items[] of kind "message", names resolved by actors[]) and the conversation's title. */
function messagesFromParsed(c: Record<string, unknown>, frameAt: string, selfNames: string[]): { messages: ConversationMessage[]; title?: string } | null {
  const items = Array.isArray(c.items) ? (c.items as ParsedItem[]) : []
  if (items.length === 0) return null
  const resolved = new Map<string, string>()
  if (Array.isArray(c.actors)) {
    for (const a of c.actors as Record<string, unknown>[]) {
      const lid = str(a?.local_id)
      const name = str(a?.name)
      if (lid && name) resolved.set(lid, name)
    }
  }
  const titles: string[] = []
  const messages: ConversationMessage[] = []
  for (const it of items) {
    if (!it || typeof it !== "object") continue
    const kind = str(it.kind)
    if (kind === "conversation") {
      const t = str(it.title).trim()
      if (t) titles.push(t)
      continue
    }
    if (kind !== "message") continue
    const text = str(it.body ?? it.title).trim()
    if (!text) continue
    const role = roleOfActor(str(it.actor), resolved.get(str(it.local_id)) ?? "", selfNames)
    messages.push({ role, text, at: toIso(it.occurred_at) ?? frameAt })
  }
  if (messages.length === 0) return null
  return { messages, title: titles.length === 1 ? titles[0] : undefined }
}

export type NormalizeOptions = { selfNames?: string[] }

/** Normalizes a /search element, whatever its exact shape (parsed, accessibility, ocr, audio, old format). */
export function normalizeScreenpipeItem(raw: unknown, opts: NormalizeOptions = {}): ScreenpipeItem | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const c = (r.content && typeof r.content === "object" ? r.content : r) as Record<string, unknown>
  const at = toIso(c.timestamp ?? r.timestamp)
  if (!at) return null
  let messages: ConversationMessage[] | undefined
  let window = str(c.window_name ?? c.windowName ?? c.window ?? c.title)
  let text = str(c.text ?? c.transcription ?? (typeof c.content === "string" ? c.content : "")).trim()
  const parsed = messagesFromParsed(c, at, opts.selfNames ?? [])
  if (parsed) {
    messages = parsed.messages
    // `text` is the compact rendering of the same messages: we do not keep it as well.
    text = ""
    if (parsed.title) window = parsed.title
  } else if (Array.isArray(c.messages)) {
    messages = []
    for (const m of c.messages as Record<string, unknown>[]) {
      const role = roleOf(m?.role ?? m?.author ?? m?.speaker)
      const mt = str(m?.text ?? m?.content).trim()
      if (role && mt) messages.push({ role, text: mt, at })
    }
    if (messages.length === 0) messages = undefined
  }
  if (!text && !messages) return null
  const frame = c.frame_id ?? c.frameId ?? c.id ?? c.chunk_id
  const browserUrl = str(c.browser_url ?? c.browserUrl ?? r.browser_url).trim()
  return {
    type: str(r.type) || "unknown",
    text,
    app: str(c.app_name ?? c.appName ?? c.app),
    window,
    at,
    frameId: frame !== undefined && frame !== null ? str(frame) : undefined,
    ...(browserUrl ? { browserUrl } : {}),
    messages,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

export function inferTool(app: string, window: string, browserUrl?: string): SourceTool {
  const host = browserUrl ? hostOf(browserUrl) : ""
  if (host.endsWith("chatgpt.com") || host.endsWith("openai.com")) return "chatgpt"
  if (host.endsWith("claude.ai") || host.endsWith("anthropic.com")) return "claude"
  const s = `${app} ${window}`.toLowerCase()
  if (s.includes("chatgpt") || s.includes("openai")) return "chatgpt"
  if (s.includes("codex")) return "codex"
  if (/(terminal|iterm|warp|ghostty|alacritty|kitty|wezterm|code|cursor|windsurf|zed)/.test(app.toLowerCase())) return "claude-code"
  return "claude"
}

const normLine = (l: string) => normalize(l).replace(/\s+/g, " ").trim()

/** Key (fingerprint) of an app + title window, to remember the rows already sent. */
export function windowKey(app: string, window: string): string {
  return fnv1a(`${app.toLowerCase()}\u0000${window.toLowerCase()}`)
}

export type GroupOptions = {
  whitelist?: string[]
  gapMinutes?: number
  maxChars?: number
  /** Rows already sent on previous passes (state.screenpipe.seen). */
  seen?: Record<string, SeenLines>
}

/** Rows of a conversation, to remember once the conversation is sent. */
export type ConversationLines = { window: string; hashes: string[]; at: string }

/**
 * Groups by app + window (10 min gap = new session) and deduplicates rows repeated from one capture to
 * the next, and from one pass to the next (`seen`). A session that is too long is split into several conversations, without loss.
 */
export function groupScreenpipeDetailed(items: ScreenpipeItem[], opts: GroupOptions = {}): { conversations: Conversation[]; lines: Map<string, ConversationLines> } {
  const gap = (opts.gapMinutes ?? 10) * 60_000
  const maxChars = opts.maxChars ?? 40000
  const allowed = items
    .filter((i) => isAllowedApp(i.app, i.window, opts.whitelist && opts.whitelist.length ? opts.whitelist : undefined, i.browserUrl))
    .sort((a, b) => a.at.localeCompare(b.at))
  type Group = { app: string; window: string; items: ScreenpipeItem[]; last: number }
  const open = new Map<string, Group>()
  const done: Group[] = []
  for (const it of allowed) {
    const key = `${it.app.toLowerCase()}\u0000${it.window.toLowerCase()}`
    const t = Date.parse(it.at)
    const g = open.get(key)
    if (g && t - g.last <= gap) {
      g.items.push(it)
      g.last = t
    } else {
      if (g) done.push(g)
      open.set(key, { app: it.app, window: it.window, items: [it], last: t })
    }
  }
  done.push(...open.values())

  const conversations: Conversation[] = []
  const lines = new Map<string, ConversationLines>()
  type Part = { lines: string[]; hashes: string[]; first: ScreenpipeItem; last: ScreenpipeItem; size: number }
  for (const g of done) {
    const wk = windowKey(g.app, g.window)
    const prior = new Set(opts.seen?.[wk]?.h ?? [])
    const inRun = new Set<string>()
    const msgs: ConversationMessage[] = []
    const msgHashes: string[] = []
    const parts: Part[] = []
    let cur: Part | null = null
    const addLine = (l: string, h: string, it: ScreenpipeItem) => {
      if (!cur || (cur.size + l.length > maxChars && cur.lines.length > 0)) {
        cur = { lines: [], hashes: [], first: it, last: it, size: 0 }
        parts.push(cur)
      }
      cur.lines.push(l)
      cur.hashes.push(h)
      cur.size += l.length + 1
      cur.last = it
    }
    for (const it of g.items) {
      if (it.messages) {
        for (const m of it.messages) {
          const k = `${m.role}:${normLine(m.text)}`
          if (inRun.has(k)) continue
          inRun.add(k)
          const h = fnv1a(k)
          if (prior.has(h)) continue
          msgs.push(m)
          msgHashes.push(h)
        }
      }
      for (const raw of it.text.split(/\r?\n/)) {
        const l = raw.trim()
        const k = normLine(l)
        if (k.length < 2 || inRun.has(k)) continue
        inRun.add(k)
        const h = fnv1a(k)
        if (prior.has(h)) continue
        addLine(l, h, it)
      }
    }
    const first = g.items[0]
    const last = g.items[g.items.length - 1]
    const label = `${g.app || "?"}${g.window ? ` — ${g.window}` : ""}`
    const browserUrl = g.items.find((i) => i.browserUrl)?.browserUrl
    const base = { tool: inferTool(g.app, g.window, browserUrl), app: g.app || "Screenpipe", title: g.window ? truncate(g.window, 120) : undefined }
    const hasBoth = msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant")
    if (hasBoth) {
      // Structured messages: the conversation as is; the OCR rows of the same window are redundant.
      const id = `screenpipe:${first.frameId ?? Date.parse(first.at)}`
      conversations.push({ id, ...base, started_at: first.at, ended_at: last.at, messages: msgs, screenpipe_ref: first.frameId })
      lines.set(id, { window: wk, hashes: [...msgHashes, ...parts.flatMap((p) => p.hashes)], at: last.at })
      continue
    }
    // Messages from a single role (the continuation of an exchange already sent): kept as captured text.
    if (msgs.length) parts.unshift({ lines: msgs.map((m) => m.text), hashes: msgHashes, first, last, size: 0 })
    parts.forEach((p, i) => {
      const id = `screenpipe:${p.first.frameId ?? Date.parse(p.first.at)}${i > 0 ? `#${i}` : ""}`
      conversations.push({
        id,
        ...base,
        started_at: p.first.at,
        ended_at: p.last.at,
        messages: [
          { role: "user", text: `Session captured on screen: ${label}`, at: p.first.at },
          { role: "assistant", text: p.lines.join("\n"), at: p.last.at },
        ],
        screenpipe_ref: p.first.frameId,
      })
      lines.set(id, { window: wk, hashes: p.hashes, at: p.last.at })
    })
  }
  return { conversations, lines }
}

export function groupScreenpipeItems(items: ScreenpipeItem[], opts: GroupOptions = {}): Conversation[] {
  return groupScreenpipeDetailed(items, opts).conversations
}

type Page = { status: number; rows: ScreenpipeItem[]; raw: number; total?: number; done: boolean }

type ReadOptions = { token?: string; pageSize: number; maxPages: number; timeoutMs: number; spanMs?: number; selfNames: string[] }

async function searchPage(base: string, type: string, a: number, b: number, offset: number, o: ReadOptions): Promise<Page> {
  const qs = new URLSearchParams({
    content_type: type,
    start_time: new Date(a).toISOString(),
    end_time: new Date(b).toISOString(),
    limit: String(o.pageSize),
    offset: String(offset),
    // Native redaction of personal data on the computer, even before our filter.
    filter_pii: "true",
  })
  const { status, data } = await getJson(`${base}/search?${qs}`, o.token, o.timeoutMs)
  if (status >= 400) return { status, rows: [], raw: 0, done: true }
  const d = data as { data?: unknown[]; pagination?: { total?: number } } | unknown[] | null
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
  const rows: ScreenpipeItem[] = []
  for (const r of list) {
    const it = normalizeScreenpipeItem(r, { selfNames: o.selfNames })
    if (it) rows.push(it)
  }
  const total = Array.isArray(d) ? undefined : typeof d?.pagination?.total === "number" ? d.pagination.total : undefined
  const done = list.length === 0 || list.length < o.pageSize || (total !== undefined && offset + list.length >= total)
  return { status, rows, raw: list.length, total, done }
}

/** Estimated number of captures over [a, b] from the first page (total if given, otherwise observed density). */
function estimateRows(p: Page, a: number, b: number): number {
  if (p.total !== undefined) return p.total
  if (p.done) return p.raw
  const times = p.rows.map((r) => Date.parse(r.at)).filter(Number.isFinite)
  if (times.length < 2) return p.raw * 4
  const covered = Math.max(Math.max(...times) - Math.min(...times), 1000)
  return Math.ceil((p.raw * (b - a)) / covered)
}

function ascending(rows: ScreenpipeItem[]): boolean {
  return rows.length >= 2 && rows[0].at < rows[rows.length - 1].at
}

type TypeRead = { ok: boolean; status?: number; items: ScreenpipeItem[]; covered: number; truncated: boolean; spanHint?: number }

/**
 * Reads a content type by growing windows from `since`: a window that is too busy is shrunk before being read,
 * and `covered` never goes past what was read in full (the rest will be read on the next pass).
 */
async function readContentType(base: string, type: string, o: ReadOptions, sinceMs: number, untilMs: number): Promise<TypeRead> {
  let cursor = sinceMs
  let pagesLeft = o.maxPages
  let span = Math.max(MIN_SPAN_MS, Math.min(o.spanMs ?? Infinity, untilMs - sinceMs))
  const items: ScreenpipeItem[] = []
  let ok = false
  let truncated = false
  let status: number | undefined
  let spanHint: number | undefined
  while (cursor < untilMs && pagesLeft > 0) {
    const end = Math.min(untilMs, cursor + span)
    const first = await searchPage(base, type, cursor, end, 0, o)
    pagesLeft--
    if (first.status >= 400) {
      status = first.status
      truncated = ok
      break
    }
    ok = true
    const capacity = (pagesLeft + 1) * o.pageSize
    const estimate = estimateRows(first, cursor, end)
    if (estimate > capacity && end - cursor > MIN_SPAN_MS) {
      // Too many captures for this pass: we shrink the window (with a margin) before reading it.
      span = Math.max(MIN_SPAN_MS, Math.floor(((end - cursor) * capacity * 0.8) / estimate))
      continue
    }
    let rows = first.rows
    let done = first.done
    for (let offset = o.pageSize; !done && pagesLeft > 0; offset += o.pageSize) {
      const p = await searchPage(base, type, cursor, end, offset, o)
      pagesLeft--
      if (p.status >= 400) {
        status = p.status
        break
      }
      rows = rows.concat(p.rows)
      done = p.done
    }
    if (done) {
      items.push(...rows)
      cursor = end
      span *= 2
      continue
    }
    // Window read in part: we only keep what is certain.
    truncated = true
    if (ascending(rows)) {
      // From oldest to most recent: [cursor, last capture[ is complete (the boundary will be read again).
      items.push(...rows)
      cursor = Math.max(cursor, Date.parse(rows[rows.length - 1].at))
    } else if (status === undefined) {
      // From most recent to oldest, without a total: we will retry with a smaller window.
      spanHint = Math.max(MIN_SPAN_MS, Math.floor((end - cursor) / 2))
    }
    break
  }
  if (ok && cursor < untilMs) truncated = true
  return { ok, status, items, covered: cursor, truncated, spanHint }
}

export type ScreenpipeFetch = {
  items: ScreenpipeItem[]
  contentType?: string
  /** Not everything could be read: the rest will be read on the next passes. */
  truncated: boolean
  tried: string[]
  /** Every capture before this date has been read. */
  coveredUntil: string
  /** Window size to remember for the next pass (Screenpipe without a total). */
  spanHint?: number
  /** HTTP error while reading (reading stopped there). */
  status?: number
  /** Screenpipe refused or failed everywhere: nothing is reliable, no checkpoint must move. */
  error?: string
}

function httpProblem(status: number): string {
  if (status === 401 || status === 403)
    return `Screenpipe refuses access (HTTP ${status}): local API token missing or invalid — show it with \`${TOKEN_COMMAND}\` then add it with \`init --screenpipe-token <token>\`.`
  return `Screenpipe answered HTTP ${status}.`
}

function readOptions(opts: ScreenpipeOptions): ReadOptions {
  return {
    token: opts.token,
    pageSize: Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE),
    maxPages: opts.maxPages ?? 20,
    timeoutMs: opts.timeoutMs ?? 10000,
    spanMs: opts.spanMs,
    selfNames: opts.selfNames ?? [],
  }
}

/** Queries /search trying the content types in order. */
export async function fetchScreenpipeItems(opts: ScreenpipeOptions): Promise<ScreenpipeFetch> {
  const base = opts.url.replace(/\/+$/, "")
  const o = readOptions(opts)
  const sinceMs = opts.since.getTime()
  const untilMs = (opts.until ?? new Date()).getTime()
  const tried: string[] = []
  const failures: number[] = []
  let emptyCovered: number | undefined
  // Empty period (sync run again within the same second): nothing to read, and above all not an error.
  if (sinceMs >= untilMs) return { items: [], truncated: false, tried, coveredUntil: opts.since.toISOString() }
  for (const type of opts.contentTypes?.length ? opts.contentTypes : DEFAULT_SCREENPIPE_CONTENT_TYPES) {
    tried.push(type)
    const r = await readContentType(base, type, o, sinceMs, untilMs)
    if (!r.ok) {
      if (r.status !== undefined) failures.push(r.status)
      continue
    }
    if (r.items.length > 0 || r.truncated) {
      return { items: r.items, contentType: type, truncated: r.truncated, tried, coveredUntil: new Date(r.covered).toISOString(), spanHint: r.spanHint, status: r.status }
    }
    emptyCovered = Math.min(emptyCovered ?? Infinity, r.covered)
  }
  // No data: it is only a really empty period if Screenpipe did answer (no 401/403/5xx).
  const blocking = failures.find((s) => s === 401 || s === 403 || s >= 500)
  if (emptyCovered === undefined || blocking !== undefined) {
    return { items: [], truncated: false, tried, coveredUntil: opts.since.toISOString(), error: httpProblem(blocking ?? failures[0] ?? 0) }
  }
  return { items: [], truncated: false, tried, coveredUntil: new Date(emptyCovered).toISOString() }
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}

// --- Meetings ----------------------------------------------------------------------------------------------------

export type MeetingRecord = { id: string; start: string; end: string | null; app: string; title: string; attendees: string; note: string }
export type MeetingSegment = { speaker: string; text: string; at: string }

/** Row of GET /meetings (snake_case on the API side; camelCase tolerated). */
export function normalizeMeeting(raw: unknown): MeetingRecord | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>
  const id = str(m.id)
  const start = toIso(m.meeting_start ?? m.meetingStart ?? m.start_time ?? m.start)
  if (!id || !start) return null
  const end = toIso(m.meeting_end ?? m.meetingEnd ?? m.end_time ?? m.end)
  return {
    id,
    start,
    end: end ?? null,
    app: str(m.meeting_app ?? m.meetingApp ?? m.app).trim(),
    title: str(m.title).trim(),
    attendees: Array.isArray(m.attendees) ? m.attendees.map(str).filter(Boolean).join(", ") : str(m.attendees).trim(),
    note: str(m.note ?? m.summary).trim(),
  }
}

/** Segment of GET /meetings/:id/transcript (camelCase on the API side; snake_case tolerated). */
export function normalizeSegment(raw: unknown): MeetingSegment | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>
  const text = str(s.transcript ?? s.text ?? s.transcription).trim()
  if (!text) return null
  const speakerRaw = s.speakerName ?? s.speaker_name ?? s.speaker
  const speaker = speakerRaw && typeof speakerRaw === "object" ? str((speakerRaw as Record<string, unknown>).name) : str(speakerRaw)
  return { speaker: speaker.trim(), text, at: toIso(s.capturedAt ?? s.captured_at ?? s.timestamp) ?? "" }
}

function longDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

/**
 * A finished meeting → a "meeting" conversation: the transcription in a single message ("Name: text"), and
 * the notes saved in Screenpipe (summary) as the answer. The distiller draws decisions and commitments from it.
 */
export function meetingConversation(m: MeetingRecord, segments: MeetingSegment[]): Conversation | null {
  const end = m.end ?? m.start
  const lines = segments.map((s) => `${s.speaker || "Someone"}: ${s.text}`)
  if (lines.length === 0 && !m.note) return null
  const header = `Meeting${m.title ? ` "${m.title}"` : ""} on ${longDateTime(m.start)}${m.app ? ` (${m.app})` : ""}${m.attendees ? `, attendees: ${m.attendees}` : ""}.`
  const messages: ConversationMessage[] = [
    { role: "user", text: `${header}\n\nTranscription:\n${lines.length ? lines.join("\n") : "(no transcription)"}`, at: m.start },
  ]
  if (m.note) messages.push({ role: "assistant", text: `Notes and summary saved in Screenpipe:\n${m.note}`, at: end })
  return {
    id: `screenpipe-meeting:${m.id}`,
    tool: "meeting",
    app: m.app || "Meeting",
    title: truncate(m.title || `Meeting ${m.app || ""}`.trim(), 120),
    started_at: m.start,
    ended_at: end,
    messages,
    screenpipe_ref: `meeting:${m.id}`,
  }
}

export type MeetingsRead = { available: boolean; conversations: Conversation[]; commits: CheckpointCommit[]; warnings: string[]; meetings: number; pending: number }

/**
 * Meetings finished since the checkpoint (`state.screenpipe.meetings_last_end`), at most MAX_MEETINGS_PER_PASS per
 * pass. A Screenpipe without /meetings (404) is not an error: the source is simply missing.
 */
export async function readScreenpipeMeetings(opts: { url: string; token?: string; state: State; since: Date; until?: Date; timeoutMs?: number; explicitSince?: boolean }): Promise<MeetingsRead> {
  const out: MeetingsRead = { available: true, conversations: [], commits: [], warnings: [], meetings: 0, pending: 0 }
  const base = opts.url.replace(/\/+$/, "")
  const timeoutMs = opts.timeoutMs ?? 10000
  const last = opts.explicitSince ? undefined : opts.state.screenpipe?.meetings_last_end
  const lastMs = last ? Date.parse(last) : opts.since.getTime()
  const untilMs = (opts.until ?? new Date()).getTime()
  // The API's filter is on the meeting start: we go back a little before the checkpoint (long meeting), then we
  // filter on the end on the client side.
  const startMs = Math.min(lastMs, opts.since.getTime()) - 6 * 3600_000
  const records: MeetingRecord[] = []
  for (let offset = 0, page = 0; page < 10; page++, offset += 50) {
    const qs = new URLSearchParams({ start_time: new Date(startMs).toISOString(), end_time: new Date(untilMs).toISOString(), limit: "50", offset: String(offset) })
    let res: { status: number; data: unknown }
    try {
      res = await getJson(`${base}/meetings?${qs}`, opts.token, timeoutMs)
    } catch (err) {
      out.available = false
      out.warnings.push(`Screenpipe meetings unreachable (${(err as Error).message}).`)
      return out
    }
    if (res.status === 404) {
      out.available = false
      return out
    }
    if (res.status >= 400) {
      out.available = false
      out.warnings.push(`Screenpipe meetings: ${httpProblem(res.status)} Source skipped for this pass.`)
      return out
    }
    const d = res.data as { data?: unknown[]; meetings?: unknown[] } | unknown[] | null
    const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.meetings) ? d.meetings : []
    for (const r of list) {
      const m = normalizeMeeting(r)
      if (m) records.push(m)
    }
    if (list.length < 50) break
  }
  const ready = records
    .filter((m): m is MeetingRecord & { end: string } => Boolean(m.end) && Date.parse(m.end as string) > lastMs && Date.parse(m.end as string) <= untilMs)
    .sort((a, b) => a.end.localeCompare(b.end))
  const batch = ready.slice(0, MAX_MEETINGS_PER_PASS)
  out.pending = ready.length - batch.length
  const ids: string[] = []
  for (const m of batch) {
    let segments: MeetingSegment[] = []
    try {
      const t = await getJson(`${base}/meetings/${encodeURIComponent(m.id)}/transcript`, opts.token, timeoutMs)
      if (t.status < 400) {
        const d = t.data as { data?: unknown[]; segments?: unknown[] } | unknown[] | null
        const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.segments) ? d.segments : []
        segments = list.map(normalizeSegment).filter((s): s is MeetingSegment => s !== null)
      } else if (t.status !== 404) {
        out.warnings.push(`Transcription of meeting ${m.id}: HTTP ${t.status}, meeting processed with its notes only.`)
      }
    } catch (err) {
      out.warnings.push(`Transcription of meeting ${m.id} unreachable (${(err as Error).message}): meeting put off to the next pass.`)
      break
    }
    const conv = meetingConversation(m, segments)
    const end = m.end
    if (conv) {
      out.conversations.push(conv)
      ids.push(conv.id)
    }
    // A meeting's checkpoint only moves once every meeting finished before it has been processed.
    const covers = [...ids]
    out.commits.push({ covers, apply: (s) => bumpMeetings(s, end) })
  }
  out.meetings = out.conversations.length
  return out
}

function bumpMeetings(state: State, iso: string) {
  state.screenpipe ??= {}
  const cur = state.screenpipe.meetings_last_end
  if (!cur || iso > cur) state.screenpipe.meetings_last_end = iso
}

// --- Full read (captures + meetings) -----------------------------------------------------------------------------

/**
 * `baseline` (set by install-schedule): nothing earlier is read without an explicit --since, even if the Screenpipe
 * checkpoint is older (captures never reviewed in a dry run).
 */
export async function readScreenpipe(
  opts: Omit<ScreenpipeOptions, "since"> & { state: State; since: Date; explicitSince?: boolean; baseline?: Date; meetings?: boolean },
): Promise<SourceResult> {
  const result: SourceResult = { source: "screenpipe", available: true, conversations: [], commits: [], warnings: [], stats: {} }
  const sp = opts.state.screenpipe
  const last = sp?.last_timestamp
  let since = last && !opts.explicitSince ? new Date(Math.max(Date.parse(last), 0)) : opts.since
  if (opts.baseline && !opts.explicitSince && opts.baseline.getTime() > since.getTime()) since = opts.baseline
  const until = opts.until ?? new Date()
  let fetched: ScreenpipeFetch
  try {
    fetched = await fetchScreenpipeItems({ ...opts, since, until, spanMs: opts.spanMs ?? sp?.span_ms })
  } catch (err) {
    result.available = false
    result.warnings.push(`Screenpipe unreachable on ${opts.url} (${(err as Error).message}): source skipped, carrying on with the others.`)
    return result
  }
  if (fetched.error) {
    // No checkpoint: the period will be read again when Screenpipe answers.
    result.available = false
    result.warnings.push(`${fetched.error} Source skipped; these captures will be read again on the next sync.`)
    return result
  }
  result.stats.items = fetched.items.length
  result.stats.content_type = fetched.contentType ?? `no data (${fetched.tried.join(", ")})`
  if (fetched.status || fetched.truncated) result.stats.truncated_until = fetched.coveredUntil
  if (fetched.status) result.warnings.push(`${httpProblem(fetched.status)} Reading stopped there; the rest will be read again on the next sync.`)
  else if (fetched.truncated)
    result.warnings.push(`Screenpipe: many captures over the period, read up to ${hhmm(fetched.coveredUntil)}; the rest will be read on the next syncs.`)
  const grouped = groupScreenpipeDetailed(fetched.items, { whitelist: opts.whitelist, gapMinutes: opts.gapMinutes, seen: sp?.seen })
  const conversations = grouped.conversations
  result.conversations = conversations

  const covered = Date.parse(fetched.coveredUntil)
  const maxSeen = fetched.items.reduce((m, i) => (i.at > m ? i.at : m), "")
  // Late captures (timestamped just before the read) are read again: we start again from the last one seen + 1 ms.
  const final = maxSeen ? new Date(Math.min(Date.parse(maxSeen) + 1, covered)).toISOString() : fetched.coveredUntil
  // One commit per conversation (chronological order): it only moves once every conversation started before has been processed.
  for (const c of [...conversations].sort((a, b) => a.ended_at.localeCompare(b.ended_at))) {
    const covers = conversations.filter((o) => o.started_at <= c.ended_at).map((o) => o.id)
    const at = c.ended_at < final ? c.ended_at : final
    result.commits.push({ covers, apply: (s) => bump(s, at) })
  }
  // The 7 days are counted from the end of the read, not from the clock: the same read keeps the same lines.
  for (const [id, l] of grouped.lines) result.commits.push({ covers: [id], apply: (s) => rememberLines(s, l, until.getTime()) })
  result.commits.push({ covers: conversations.map((c) => c.id), apply: (s) => bump(s, final) })
  result.commits.push({
    covers: [],
    apply: (s) => {
      s.screenpipe ??= {}
      if (fetched.spanHint) s.screenpipe.span_ms = fetched.spanHint
      else if (!fetched.truncated) delete s.screenpipe.span_ms
    },
  })

  // Finished meetings: the source richest in decisions, out of reach of the agents' logs.
  if (opts.meetings !== false) {
    const meetingsSince = opts.baseline && !opts.explicitSince && opts.baseline.getTime() > opts.since.getTime() ? opts.baseline : opts.since
    const m = await readScreenpipeMeetings({ url: opts.url, token: opts.token, state: opts.state, since: meetingsSince, until, timeoutMs: opts.timeoutMs, explicitSince: opts.explicitSince })
    result.conversations.push(...m.conversations)
    result.commits.push(...m.commits)
    result.warnings.push(...m.warnings)
    if (m.available) result.stats.meetings = m.meetings
    if (m.pending) result.warnings.push(`${m.pending} more meeting(s) to distill: they will go on the next syncs.`)
  }
  return result
}

function bump(state: State, iso: string) {
  state.screenpipe ??= {}
  const cur = state.screenpipe.last_timestamp
  if (!cur || iso > cur) state.screenpipe.last_timestamp = iso
}

const MAX_SEEN_PER_WINDOW = 1000
const MAX_SEEN_WINDOWS = 60
const SEEN_TTL_MS = 7 * 86_400_000

/** Remembers the rows sent from a window (bounded: 1000 per window, 60 windows, 7 days). */
export function rememberLines(state: State, l: ConversationLines, now = Date.now()) {
  state.screenpipe ??= {}
  const seen = (state.screenpipe.seen ??= {})
  const prev = seen[l.window]
  const h = [...new Set([...(prev?.h ?? []), ...l.hashes])].slice(-MAX_SEEN_PER_WINDOW)
  seen[l.window] = { at: prev && prev.at > l.at ? prev.at : l.at, h }
  const keep = Object.entries(seen)
    .filter(([, v]) => now - Date.parse(v.at) < SEEN_TTL_MS)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, MAX_SEEN_WINDOWS)
  state.screenpipe.seen = Object.fromEntries(keep)
}

// --- Repetitive workflows -----------------------------------------------------------------------------------------

function int(v: unknown, max = 1_000_000): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0
}

function appsOf(w: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const v of [w.apps, w.applications, w.app_names, w.app_name, w.app, w.application]) {
    for (const a of Array.isArray(v) ? v : [v]) {
      const name = a && typeof a === "object" ? str((a as Record<string, unknown>).name ?? (a as Record<string, unknown>).app_name) : str(a)
      if (name.trim()) out.push(name.trim())
    }
  }
  return out
}

export type WorkflowOptions = {
  whitelist?: string[]
  /** The computer's secrets (tokens, keys) to redact as is. */
  literals?: string[]
}

/**
 * "Best effort" mapping of the workflows detected by Screenpipe to POST /api/automations, with the same
 * safeguards as the rest: workflow dropped if it names an app outside the allowlist or looks personal, text redacted.
 * `ids`: original ids (for GET /workflows/:id), aligned with `workflows`.
 */
export function mapWorkflowsDetailed(
  raw: unknown,
  zones: { id: string; name: string; keywords: string[] }[] = [],
  opts: WorkflowOptions = {},
): { workflows: Workflow[]; dropped: number; ids: string[] } {
  const r = raw as { workflows?: unknown; data?: unknown } | unknown[] | null
  const list = Array.isArray(r) ? r : Array.isArray(r?.workflows) ? r.workflows : Array.isArray(r?.data) ? r.data : []
  const whitelist = opts.whitelist?.length ? opts.whitelist : undefined
  const out: Workflow[] = []
  const ids: string[] = []
  let dropped = 0
  for (const w of list as Record<string, unknown>[]) {
    if (!w || typeof w !== "object") continue
    const rawTitle = str(w.title ?? w.name ?? w.description ?? w.summary).trim()
    if (!rawTitle) continue
    const trigger = str(w.trigger).trim()
    const outcome = str(w.outcome).trim()
    const rawDescription = str(w.description ?? w.summary ?? w.details).trim() || [trigger && `Trigger: ${trigger}`, outcome && `Outcome: ${outcome}`].filter(Boolean).join(". ")
    const apps = appsOf(w)
    if (looksPersonal(`${rawTitle}\n${rawDescription}\n${apps.join(" ")}`) || apps.some((a) => !isAllowedApp(a, "", whitelist))) {
      dropped++
      continue
    }
    const red = (t: string) => redact(t, { literals: opts.literals }).text
    const title = truncate(red(rawTitle), 200)
    const description = truncate(red(rawDescription), 1000)
    const occurrences = int(w.occurrences ?? w.count ?? w.frequency ?? w.times ?? w.runs)
    const days = int(w.days ?? w.unique_days ?? w.day_count ?? w.distinct_days)
    const schedule = str(w.schedule ?? w.cron ?? w.typical_time ?? w.time).trim()
    const minutes = int(w.minutes_saved_per_week ?? w.estimated_minutes_saved ?? w.time_saved_minutes ?? w.minutes_saved, 5000) || Math.min(5000, occurrences * 5)
    const zone = zones.length ? classifyZones(`${title} ${description}`, zones, 1)[0] : undefined
    const rawId = str(w.id ?? w.key ?? w.name ?? rawTitle)
    out.push({
      id: truncate(red(rawId), 200),
      title,
      description,
      ...(schedule ? { schedule: truncate(red(schedule), 120) } : {}),
      occurrences,
      days,
      ...(zone ? { zone } : {}),
      minutes_saved_per_week: minutes,
    })
    ids.push(rawId)
    if (out.length >= 50) break
  }
  return { workflows: out, dropped, ids }
}

export function mapWorkflows(raw: unknown, zones: { id: string; name: string; keywords: string[] }[] = [], opts: WorkflowOptions = {}): Workflow[] {
  return mapWorkflowsDetailed(raw, zones, opts).workflows
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Completes a workflow with its details (GET /workflows/:id): `timingRuns` = complete occurrences, each bounded
 * by two cited timestamps. We draw the number of occurrences, of distinct days, the usual time (median
 * of the starts) and an estimate of the time per week (median duration × occurrences / weeks covered).
 */
export function enrichWorkflow(w: Workflow, detail: unknown): Workflow {
  if (!detail || typeof detail !== "object") return w
  const d = detail as Record<string, unknown>
  const runs = Array.isArray(d.timingRuns) ? (d.timingRuns as Record<string, unknown>[]) : []
  const bounds = runs
    .map((r) => {
      const s = Date.parse(str((r?.start as Record<string, unknown> | undefined)?.timestamp))
      const e = Date.parse(str((r?.end as Record<string, unknown> | undefined)?.timestamp))
      return { s, e }
    })
    .filter((b) => Number.isFinite(b.s))
  if (bounds.length === 0) return w
  const starts = bounds.map((b) => b.s)
  const days = new Set(starts.map((t) => new Date(t).toISOString().slice(0, 10))).size
  const minuteOfDay = median(starts.map((t) => new Date(t).getHours() * 60 + new Date(t).getMinutes()))
  const schedule = minuteOfDay !== undefined ? `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}` : w.schedule
  const durations = bounds.map((b) => (b.e - b.s) / 60_000).filter((m) => Number.isFinite(m) && m > 0 && m < 8 * 60)
  const perRun = median(durations) ?? 5
  const spanWeeks = Math.max(1, (Math.max(...starts) - Math.min(...starts)) / (7 * 86_400_000))
  const minutes = Math.min(5000, Math.max(1, Math.round((perRun * bounds.length) / spanWeeks)))
  return { ...w, occurrences: bounds.length, days, ...(schedule ? { schedule } : {}), minutes_saved_per_week: minutes }
}

export async function fetchScreenpipeWorkflows(
  url: string,
  token: string | undefined,
  zones: { id: string; name: string; keywords: string[] }[],
  opts: WorkflowOptions = {},
): Promise<{ workflows: Workflow[]; dropped: number }> {
  const base = url.replace(/\/+$/, "")
  try {
    const { status, data } = await getJson(`${base}/workflows?limit=50`, token, 3000)
    if (status >= 400) return { workflows: [], dropped: 0 }
    const mapped = mapWorkflowsDetailed(data, zones, opts)
    const workflows = [...mapped.workflows]
    for (let i = 0; i < Math.min(WORKFLOW_DETAIL_MAX, workflows.length); i++) {
      try {
        const d = await getJson(`${base}/workflows/${encodeURIComponent(mapped.ids[i])}?include_automation=false`, token, 3000)
        if (d.status < 400) workflows[i] = enrichWorkflow(workflows[i], d.data)
      } catch {
        break
      }
    }
    return { workflows, dropped: mapped.dropped }
  } catch {
    return { workflows: [], dropped: 0 }
  }
}
