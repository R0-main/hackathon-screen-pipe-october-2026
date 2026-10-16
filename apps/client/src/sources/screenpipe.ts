// Source « Screenpipe » : API REST locale (http://localhost:3030 par défaut).
// Hypothèses de forme (tolérantes) : GET /search → { data: [{ type, content: { text | transcription | messages,
// app_name, window_name, timestamp, frame_id } }], pagination: { limit, offset, total } }.

import { classifyZones, isAllowedApp, normalize, truncate, type Conversation, type ConversationMessage, type SourceTool } from "@brain/core"
import type { Workflow } from "../api"
import type { State } from "../config"
import { DEFAULT_SCREENPIPE_CONTENT_TYPES } from "../config"
import { toIso } from "./jsonl"
import type { SourceResult } from "./types"

export type ScreenpipeItem = {
  type: string
  text: string
  app: string
  window: string
  at: string
  frameId?: string
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
}

function headers(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}`, accept: "application/json" } : { accept: "application/json" }
}

class ScreenpipeDown extends Error {}

async function getJson(url: string, token: string | undefined, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  let res: Response
  try {
    res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new ScreenpipeDown((err as Error).name === "TimeoutError" ? "délai dépassé" : ((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message))
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
    if (status >= 400) return { ok: false, detail: `HTTP ${status}${status === 401 || status === 403 ? " (jeton Screenpipe requis ?)" : ""}` }
    const s = (data as { status?: string } | null)?.status
    return { ok: true, detail: s ? `statut « ${s} »` : "répond" }
  } catch (err) {
    return { ok: false, detail: `injoignable (${(err as Error).message})` }
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

/** Normalise un élément de /search, quelle que soit sa forme exacte. */
export function normalizeScreenpipeItem(raw: unknown): ScreenpipeItem | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const c = (r.content && typeof r.content === "object" ? r.content : r) as Record<string, unknown>
  const at = toIso(c.timestamp ?? r.timestamp)
  if (!at) return null
  let messages: ConversationMessage[] | undefined
  if (Array.isArray(c.messages)) {
    messages = []
    for (const m of c.messages as Record<string, unknown>[]) {
      const role = roleOf(m?.role ?? m?.author ?? m?.speaker)
      const text = str(m?.text ?? m?.content).trim()
      if (role && text) messages.push({ role, text, at })
    }
    if (messages.length === 0) messages = undefined
  }
  const text = str(c.text ?? c.transcription ?? (typeof c.content === "string" ? c.content : "")).trim()
  if (!text && !messages) return null
  const frame = c.frame_id ?? c.frameId ?? c.id ?? c.chunk_id
  return {
    type: str(r.type) || "unknown",
    text,
    app: str(c.app_name ?? c.appName ?? c.app),
    window: str(c.window_name ?? c.windowName ?? c.window ?? c.title),
    at,
    frameId: frame !== undefined && frame !== null ? str(frame) : undefined,
    messages,
  }
}

export function inferTool(app: string, window: string): SourceTool {
  const s = `${app} ${window}`.toLowerCase()
  if (s.includes("chatgpt") || s.includes("openai")) return "chatgpt"
  if (s.includes("codex")) return "codex"
  if (/(terminal|iterm|warp|ghostty|alacritty|kitty|wezterm|code|cursor|windsurf|zed)/.test(app.toLowerCase())) return "claude-code"
  return "claude"
}

const normLine = (l: string) => normalize(l).replace(/\s+/g, " ").trim()

/** Regroupe par app + fenêtre (trou de 10 min = nouvelle session) et dédoublonne les lignes répétées d'une capture à l'autre. */
export function groupScreenpipeItems(items: ScreenpipeItem[], opts: { whitelist?: string[]; gapMinutes?: number; maxChars?: number } = {}): Conversation[] {
  const gap = (opts.gapMinutes ?? 10) * 60_000
  const maxChars = opts.maxChars ?? 40000
  const allowed = items
    .filter((i) => isAllowedApp(i.app, i.window, opts.whitelist && opts.whitelist.length ? opts.whitelist : undefined))
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

  const out: Conversation[] = []
  for (const g of done) {
    const seen = new Set<string>()
    const msgs: ConversationMessage[] = []
    const lines: string[] = []
    let size = 0
    for (const it of g.items) {
      if (it.messages) {
        for (const m of it.messages) {
          const k = `${m.role}:${normLine(m.text)}`
          if (seen.has(k)) continue
          seen.add(k)
          msgs.push(m)
        }
      }
      for (const raw of it.text.split(/\r?\n/)) {
        const l = raw.trim()
        const k = normLine(l)
        if (k.length < 2 || seen.has(k)) continue
        seen.add(k)
        if (size + l.length > maxChars) break
        lines.push(l)
        size += l.length + 1
      }
    }
    const first = g.items[0]
    const last = g.items[g.items.length - 1]
    const hasBoth = msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant")
    const label = `${g.app || "?"}${g.window ? ` — ${g.window}` : ""}`
    const messages: ConversationMessage[] = hasBoth
      ? msgs
      : lines.length
        ? [
            { role: "user", text: `Session capturée à l'écran : ${label}`, at: first.at },
            { role: "assistant", text: lines.join("\n"), at: last.at },
          ]
        : []
    if (messages.length === 0) continue
    out.push({
      id: `screenpipe:${first.frameId ?? Date.parse(first.at)}`,
      tool: inferTool(g.app, g.window),
      app: g.app || "Screenpipe",
      title: g.window ? truncate(g.window, 120) : undefined,
      started_at: first.at,
      ended_at: last.at,
      messages,
      screenpipe_ref: first.frameId,
    })
  }
  return out
}

/** Interroge /search en essayant les types de contenu dans l'ordre, avec pagination. */
export async function fetchScreenpipeItems(opts: ScreenpipeOptions): Promise<{ items: ScreenpipeItem[]; contentType?: string; truncated: boolean; tried: string[] }> {
  const base = opts.url.replace(/\/+$/, "")
  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 10
  const timeoutMs = opts.timeoutMs ?? 10000
  const until = opts.until ?? new Date()
  const tried: string[] = []
  for (const type of opts.contentTypes?.length ? opts.contentTypes : DEFAULT_SCREENPIPE_CONTENT_TYPES) {
    tried.push(type)
    const items: ScreenpipeItem[] = []
    let ok = true
    let truncated = false
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize
      const qs = new URLSearchParams({
        content_type: type,
        start_time: opts.since.toISOString(),
        end_time: until.toISOString(),
        limit: String(pageSize),
        offset: String(offset),
      })
      const { status, data } = await getJson(`${base}/search?${qs}`, opts.token, timeoutMs)
      if (status >= 400) {
        if (page === 0) ok = false
        break
      }
      const d = data as { data?: unknown[]; pagination?: { total?: number } } | unknown[] | null
      const rows = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
      for (const r of rows) {
        const it = normalizeScreenpipeItem(r)
        if (it) items.push(it)
      }
      const total = Array.isArray(d) ? undefined : d?.pagination?.total
      if (rows.length === 0 || rows.length < pageSize || (typeof total === "number" && offset + rows.length >= total)) break
      if (page === maxPages - 1) truncated = true
    }
    if (ok && items.length > 0) return { items, contentType: type, truncated, tried }
  }
  return { items: [], truncated: false, tried }
}

export async function readScreenpipe(opts: Omit<ScreenpipeOptions, "since"> & { state: State; since: Date; explicitSince?: boolean }): Promise<SourceResult> {
  const result: SourceResult = { source: "screenpipe", available: true, conversations: [], commits: [], warnings: [], stats: {} }
  const last = opts.state.screenpipe?.last_timestamp
  const since = last && !opts.explicitSince ? new Date(Math.max(Date.parse(last), 0)) : opts.since
  const until = opts.until ?? new Date()
  let fetched
  try {
    fetched = await fetchScreenpipeItems({ ...opts, since, until })
  } catch (err) {
    result.available = false
    result.warnings.push(`Screenpipe injoignable sur ${opts.url} (${(err as Error).message}) : source ignorée, on continue avec les autres.`)
    return result
  }
  result.stats.items = fetched.items.length
  result.stats.content_type = fetched.contentType ?? `aucune donnée (${fetched.tried.join(", ")})`
  if (fetched.truncated) result.warnings.push(`Screenpipe : beaucoup de captures sur la période, seule une partie a été lue (${fetched.items.length}).`)
  const conversations = groupScreenpipeItems(fetched.items, { whitelist: opts.whitelist, gapMinutes: opts.gapMinutes })
  result.conversations = conversations
  const maxSeen = fetched.items.reduce((m, i) => (i.at > m ? i.at : m), "")
  // Un commit par conversation (ordre chronologique), puis le checkpoint final si tout a été traité.
  for (const c of [...conversations].sort((a, b) => a.ended_at.localeCompare(b.ended_at))) {
    result.commits.push({ covers: [c.id], apply: (s) => bump(s, c.ended_at) })
  }
  const final = maxSeen ? new Date(Date.parse(maxSeen) + 1).toISOString() : until.toISOString()
  result.commits.push({ covers: conversations.map((c) => c.id), apply: (s) => bump(s, final) })
  return result
}

function bump(state: State, iso: string) {
  state.screenpipe ??= {}
  const cur = state.screenpipe.last_timestamp
  if (!cur || iso > cur) state.screenpipe.last_timestamp = iso
}

function int(v: unknown, max = 1_000_000): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0
}

/** Correspondance « au mieux » des workflows détectés par Screenpipe vers POST /api/automations. */
export function mapWorkflows(raw: unknown, zones: { id: string; name: string; keywords: string[] }[] = []): Workflow[] {
  const r = raw as { workflows?: unknown; data?: unknown } | unknown[] | null
  const list = Array.isArray(r) ? r : Array.isArray(r?.workflows) ? r.workflows : Array.isArray(r?.data) ? r.data : []
  const out: Workflow[] = []
  for (const w of list as Record<string, unknown>[]) {
    if (!w || typeof w !== "object") continue
    const title = truncate(str(w.title ?? w.name ?? w.description ?? w.summary).trim(), 200)
    if (!title) continue
    const description = truncate(str(w.description ?? w.summary ?? w.details).trim(), 1000)
    const occurrences = int(w.occurrences ?? w.count ?? w.frequency ?? w.times ?? w.runs)
    const days = int(w.days ?? w.unique_days ?? w.day_count ?? w.distinct_days)
    const schedule = str(w.schedule ?? w.cron ?? w.typical_time ?? w.time).trim()
    const minutes = int(w.minutes_saved_per_week ?? w.estimated_minutes_saved ?? w.time_saved_minutes ?? w.minutes_saved, 5000) || Math.min(5000, occurrences * 5)
    const zone = zones.length ? classifyZones(`${title} ${description}`, zones, 1)[0] : undefined
    out.push({
      id: truncate(str(w.id ?? w.key ?? w.name ?? title), 200),
      title,
      description,
      ...(schedule ? { schedule: truncate(schedule, 120) } : {}),
      occurrences,
      days,
      ...(zone ? { zone } : {}),
      minutes_saved_per_week: minutes,
    })
    if (out.length >= 50) break
  }
  return out
}

export async function fetchScreenpipeWorkflows(url: string, token: string | undefined, zones: { id: string; name: string; keywords: string[] }[]): Promise<Workflow[]> {
  try {
    const { status, data } = await getJson(`${url.replace(/\/+$/, "")}/workflows`, token, 3000)
    if (status >= 400) return []
    return mapWorkflows(data, zones)
  } catch {
    return []
  }
}
