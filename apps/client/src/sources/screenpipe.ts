// Source « Screenpipe » : API REST locale (http://localhost:3030 par défaut).
// Hypothèses de forme (tolérantes) : GET /search → { data: [{ type, content: { text | transcription | messages,
// app_name, window_name, timestamp, frame_id } }], pagination: { limit, offset, total } }.
// Lecture par fenêtres de temps croissantes : le checkpoint n'avance jamais au-delà de ce qui a été lu en entier.

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
  /** Taille de la première fenêtre de lecture (apprise lors d'un passage précédent), en ms. */
  spanMs?: number
}

/** Plus petite fenêtre de lecture : en dessous, on lit ce qu'on peut. */
export const MIN_SPAN_MS = 60_000

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

/** Clé (empreinte) d'une fenêtre app + titre, pour se souvenir des lignes déjà envoyées. */
export function windowKey(app: string, window: string): string {
  return fnv1a(`${app.toLowerCase()}\u0000${window.toLowerCase()}`)
}

export type GroupOptions = {
  whitelist?: string[]
  gapMinutes?: number
  maxChars?: number
  /** Lignes déjà envoyées lors des passages précédents (state.screenpipe.seen). */
  seen?: Record<string, SeenLines>
}

/** Lignes d'une conversation, à mémoriser une fois la conversation envoyée. */
export type ConversationLines = { window: string; hashes: string[]; at: string }

/**
 * Regroupe par app + fenêtre (trou de 10 min = nouvelle session) et dédoublonne les lignes répétées d'une capture à
 * l'autre, et d'un passage à l'autre (`seen`). Une session trop longue est coupée en plusieurs conversations, sans perte.
 */
export function groupScreenpipeDetailed(items: ScreenpipeItem[], opts: GroupOptions = {}): { conversations: Conversation[]; lines: Map<string, ConversationLines> } {
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
    const base = { tool: inferTool(g.app, g.window), app: g.app || "Screenpipe", title: g.window ? truncate(g.window, 120) : undefined }
    const hasBoth = msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant")
    if (hasBoth) {
      // Messages structurés : la conversation telle quelle ; les lignes OCR de la même fenêtre sont redondantes.
      const id = `screenpipe:${first.frameId ?? Date.parse(first.at)}`
      conversations.push({ id, ...base, started_at: first.at, ended_at: last.at, messages: msgs, screenpipe_ref: first.frameId })
      lines.set(id, { window: wk, hashes: [...msgHashes, ...parts.flatMap((p) => p.hashes)], at: last.at })
      continue
    }
    // Messages d'un seul rôle (la suite d'un échange déjà envoyé) : gardés comme du texte capturé.
    if (msgs.length) parts.unshift({ lines: msgs.map((m) => m.text), hashes: msgHashes, first, last, size: 0 })
    parts.forEach((p, i) => {
      const id = `screenpipe:${p.first.frameId ?? Date.parse(p.first.at)}${i > 0 ? `#${i}` : ""}`
      conversations.push({
        id,
        ...base,
        started_at: p.first.at,
        ended_at: p.last.at,
        messages: [
          { role: "user", text: `Session capturée à l'écran : ${label}`, at: p.first.at },
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

async function searchPage(base: string, type: string, a: number, b: number, offset: number, pageSize: number, token: string | undefined, timeoutMs: number): Promise<Page> {
  const qs = new URLSearchParams({
    content_type: type,
    start_time: new Date(a).toISOString(),
    end_time: new Date(b).toISOString(),
    limit: String(pageSize),
    offset: String(offset),
  })
  const { status, data } = await getJson(`${base}/search?${qs}`, token, timeoutMs)
  if (status >= 400) return { status, rows: [], raw: 0, done: true }
  const d = data as { data?: unknown[]; pagination?: { total?: number } } | unknown[] | null
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
  const rows: ScreenpipeItem[] = []
  for (const r of list) {
    const it = normalizeScreenpipeItem(r)
    if (it) rows.push(it)
  }
  const total = Array.isArray(d) ? undefined : typeof d?.pagination?.total === "number" ? d.pagination.total : undefined
  const done = list.length === 0 || list.length < pageSize || (total !== undefined && offset + list.length >= total)
  return { status, rows, raw: list.length, total, done }
}

/** Nombre de captures estimé sur [a, b] d'après la première page (total si fourni, sinon densité observée). */
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
 * Lit un type de contenu par fenêtres croissantes depuis `since` : une fenêtre trop chargée est réduite avant d'être lue,
 * et `covered` ne dépasse jamais ce qui a été lu en entier (la suite sera lue au prochain passage).
 */
async function readContentType(
  base: string,
  type: string,
  o: { token?: string; pageSize: number; maxPages: number; timeoutMs: number; spanMs?: number },
  sinceMs: number,
  untilMs: number,
): Promise<TypeRead> {
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
    const first = await searchPage(base, type, cursor, end, 0, o.pageSize, o.token, o.timeoutMs)
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
      // Trop de captures pour ce passage : on réduit la fenêtre (avec une marge) avant de la lire.
      span = Math.max(MIN_SPAN_MS, Math.floor(((end - cursor) * capacity * 0.8) / estimate))
      continue
    }
    let rows = first.rows
    let done = first.done
    for (let offset = o.pageSize; !done && pagesLeft > 0; offset += o.pageSize) {
      const p = await searchPage(base, type, cursor, end, offset, o.pageSize, o.token, o.timeoutMs)
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
    // Fenêtre lue en partie : on ne garde que ce qui est sûr.
    truncated = true
    if (ascending(rows)) {
      // Du plus ancien au plus récent : [cursor, dernière capture[ est complet (la frontière sera relue).
      items.push(...rows)
      cursor = Math.max(cursor, Date.parse(rows[rows.length - 1].at))
    } else if (status === undefined) {
      // Du plus récent au plus ancien, sans total : on retentera avec une fenêtre plus petite.
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
  /** Tout n'a pas pu être lu : la suite sera lue aux prochains passages. */
  truncated: boolean
  tried: string[]
  /** Toutes les captures antérieures à cette date ont été lues. */
  coveredUntil: string
  /** Taille de fenêtre à retenir pour le prochain passage (Screenpipe sans total). */
  spanHint?: number
  /** Erreur HTTP en cours de lecture (la lecture s'est arrêtée là). */
  status?: number
  /** Screenpipe a refusé ou échoué partout : rien n'est fiable, aucun checkpoint ne doit avancer. */
  error?: string
}

function httpProblem(status: number): string {
  if (status === 401 || status === 403)
    return `Screenpipe refuse l'accès (HTTP ${status}) : jeton d'API local manquant ou invalide — ajoutez-le avec \`init --screenpipe-token <jeton>\`.`
  return `Screenpipe a répondu HTTP ${status}.`
}

/** Interroge /search en essayant les types de contenu dans l'ordre. */
export async function fetchScreenpipeItems(opts: ScreenpipeOptions): Promise<ScreenpipeFetch> {
  const base = opts.url.replace(/\/+$/, "")
  const o = { token: opts.token, pageSize: opts.pageSize ?? 100, maxPages: opts.maxPages ?? 20, timeoutMs: opts.timeoutMs ?? 10000, spanMs: opts.spanMs }
  const sinceMs = opts.since.getTime()
  const untilMs = (opts.until ?? new Date()).getTime()
  const tried: string[] = []
  const failures: number[] = []
  let emptyCovered: number | undefined
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
  // Aucune donnée : ce n'est une vraie période vide que si Screenpipe a bien répondu (pas de 401/403/5xx).
  const blocking = failures.find((s) => s === 401 || s === 403 || s >= 500)
  if (emptyCovered === undefined || blocking !== undefined) {
    return { items: [], truncated: false, tried, coveredUntil: opts.since.toISOString(), error: httpProblem(blocking ?? failures[0] ?? 0) }
  }
  return { items: [], truncated: false, tried, coveredUntil: new Date(emptyCovered).toISOString() }
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
}

export async function readScreenpipe(opts: Omit<ScreenpipeOptions, "since"> & { state: State; since: Date; explicitSince?: boolean }): Promise<SourceResult> {
  const result: SourceResult = { source: "screenpipe", available: true, conversations: [], commits: [], warnings: [], stats: {} }
  const sp = opts.state.screenpipe
  const last = sp?.last_timestamp
  const since = last && !opts.explicitSince ? new Date(Math.max(Date.parse(last), 0)) : opts.since
  const until = opts.until ?? new Date()
  let fetched: ScreenpipeFetch
  try {
    fetched = await fetchScreenpipeItems({ ...opts, since, until, spanMs: opts.spanMs ?? sp?.span_ms })
  } catch (err) {
    result.available = false
    result.warnings.push(`Screenpipe injoignable sur ${opts.url} (${(err as Error).message}) : source ignorée, on continue avec les autres.`)
    return result
  }
  if (fetched.error) {
    // Aucun checkpoint : la période sera relue quand Screenpipe répondra.
    result.available = false
    result.warnings.push(`${fetched.error} Source ignorée ; ces captures seront relues à la prochaine synchro.`)
    return result
  }
  result.stats.items = fetched.items.length
  result.stats.content_type = fetched.contentType ?? `aucune donnée (${fetched.tried.join(", ")})`
  if (fetched.status) result.warnings.push(`${httpProblem(fetched.status)} Lecture arrêtée là ; la suite sera relue à la prochaine synchro.`)
  else if (fetched.truncated)
    result.warnings.push(`Screenpipe : beaucoup de captures sur la période, lues jusqu'au ${hhmm(fetched.coveredUntil)} ; la suite sera lue aux prochaines synchros.`)
  const grouped = groupScreenpipeDetailed(fetched.items, { whitelist: opts.whitelist, gapMinutes: opts.gapMinutes, seen: sp?.seen })
  const conversations = grouped.conversations
  result.conversations = conversations

  const covered = Date.parse(fetched.coveredUntil)
  const maxSeen = fetched.items.reduce((m, i) => (i.at > m ? i.at : m), "")
  // Les captures tardives (horodatées juste avant la lecture) sont relues : on repart de la dernière vue + 1 ms.
  const final = maxSeen ? new Date(Math.min(Date.parse(maxSeen) + 1, covered)).toISOString() : fetched.coveredUntil
  // Un commit par conversation (ordre chronologique) : il n'avance qu'une fois traitées toutes celles commencées avant.
  for (const c of [...conversations].sort((a, b) => a.ended_at.localeCompare(b.ended_at))) {
    const covers = conversations.filter((o) => o.started_at <= c.ended_at).map((o) => o.id)
    const at = c.ended_at < final ? c.ended_at : final
    result.commits.push({ covers, apply: (s) => bump(s, at) })
  }
  for (const [id, l] of grouped.lines) result.commits.push({ covers: [id], apply: (s) => rememberLines(s, l) })
  result.commits.push({ covers: conversations.map((c) => c.id), apply: (s) => bump(s, final) })
  result.commits.push({
    covers: [],
    apply: (s) => {
      s.screenpipe ??= {}
      if (fetched.spanHint) s.screenpipe.span_ms = fetched.spanHint
      else if (!fetched.truncated) delete s.screenpipe.span_ms
    },
  })
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

/** Mémorise les lignes envoyées d'une fenêtre (bornées : 1000 par fenêtre, 60 fenêtres, 7 jours). */
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

export type WorkflowOptions = { whitelist?: string[] }

/**
 * Correspondance « au mieux » des workflows détectés par Screenpipe vers POST /api/automations, avec les mêmes
 * garde-fous que le reste : workflow écarté s'il cite une app hors liste blanche ou a l'air personnel, texte masqué.
 */
export function mapWorkflowsDetailed(
  raw: unknown,
  zones: { id: string; name: string; keywords: string[] }[] = [],
  opts: WorkflowOptions = {},
): { workflows: Workflow[]; dropped: number } {
  const r = raw as { workflows?: unknown; data?: unknown } | unknown[] | null
  const list = Array.isArray(r) ? r : Array.isArray(r?.workflows) ? r.workflows : Array.isArray(r?.data) ? r.data : []
  const whitelist = opts.whitelist?.length ? opts.whitelist : undefined
  const out: Workflow[] = []
  let dropped = 0
  for (const w of list as Record<string, unknown>[]) {
    if (!w || typeof w !== "object") continue
    const rawTitle = str(w.title ?? w.name ?? w.description ?? w.summary).trim()
    if (!rawTitle) continue
    const rawDescription = str(w.description ?? w.summary ?? w.details).trim()
    const apps = appsOf(w)
    if (looksPersonal(`${rawTitle}\n${rawDescription}\n${apps.join(" ")}`) || apps.some((a) => !isAllowedApp(a, "", whitelist))) {
      dropped++
      continue
    }
    const title = truncate(redact(rawTitle).text, 200)
    const description = truncate(redact(rawDescription).text, 1000)
    const occurrences = int(w.occurrences ?? w.count ?? w.frequency ?? w.times ?? w.runs)
    const days = int(w.days ?? w.unique_days ?? w.day_count ?? w.distinct_days)
    const schedule = str(w.schedule ?? w.cron ?? w.typical_time ?? w.time).trim()
    const minutes = int(w.minutes_saved_per_week ?? w.estimated_minutes_saved ?? w.time_saved_minutes ?? w.minutes_saved, 5000) || Math.min(5000, occurrences * 5)
    const zone = zones.length ? classifyZones(`${title} ${description}`, zones, 1)[0] : undefined
    out.push({
      id: truncate(redact(str(w.id ?? w.key ?? w.name ?? rawTitle)).text, 200),
      title,
      description,
      ...(schedule ? { schedule: truncate(redact(schedule).text, 120) } : {}),
      occurrences,
      days,
      ...(zone ? { zone } : {}),
      minutes_saved_per_week: minutes,
    })
    if (out.length >= 50) break
  }
  return { workflows: out, dropped }
}

export function mapWorkflows(raw: unknown, zones: { id: string; name: string; keywords: string[] }[] = [], opts: WorkflowOptions = {}): Workflow[] {
  return mapWorkflowsDetailed(raw, zones, opts).workflows
}

export async function fetchScreenpipeWorkflows(
  url: string,
  token: string | undefined,
  zones: { id: string; name: string; keywords: string[] }[],
  opts: WorkflowOptions = {},
): Promise<{ workflows: Workflow[]; dropped: number }> {
  try {
    const { status, data } = await getJson(`${url.replace(/\/+$/, "")}/workflows`, token, 3000)
    if (status >= 400) return { workflows: [], dropped: 0 }
    return mapWorkflowsDetailed(data, zones, opts)
  } catch {
    return { workflows: [], dropped: 0 }
  }
}
