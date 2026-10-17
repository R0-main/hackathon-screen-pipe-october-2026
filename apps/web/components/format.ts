import type { AgentName, AgentEventType, KnowledgeKind } from "@brain/core"
import { getDict, intlLocale, type Locale } from "@/lib/i18n"

const rtfs: Partial<Record<Locale, Intl.RelativeTimeFormat>> = {}
const rtfFor = (locale: Locale) => (rtfs[locale] ??= new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }))

// Fixed time zone (the company's, like DEFAULT_TIMEZONE on the brain side): the server (UTC) and the browser
// show the same date, otherwise hydration fails around midnight.
export const DISPLAY_TIMEZONE = "Europe/Paris"

/**
 * "5 minutes ago". For a hydrated server render, pass the server's `now` (never Date.now() during the
 * render): see <RelTime>.
 */
export function relativeTime(iso: string | null | undefined, now = Date.now(), locale: Locale = "en"): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const diff = (t - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return getDict(locale).common.now
  const rtf = rtfFor(locale)
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day")
  return new Date(t).toLocaleDateString(intlLocale(locale), { day: "numeric", month: "short", timeZone: DISPLAY_TIMEZONE })
}

export function absoluteTime(iso: string | null | undefined, locale: Locale = "en"): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ""
  return new Date(t).toLocaleString(intlLocale(locale), { dateStyle: "medium", timeStyle: "short", timeZone: DISPLAY_TIMEZONE })
}

/** Labels (knowledge kinds, event verbs, agents) for the interface. */
export function labels(locale: Locale): { kind: Record<KnowledgeKind, string>; event: Record<AgentEventType, string>; agent: Record<AgentName, string> } {
  const d = getDict(locale)
  return { kind: d.kinds, event: d.events, agent: d.agents }
}

/** Zones without duplicates (a third-party client may send ["dev", "dev"]: duplicate React keys otherwise). */
export function uniqueZones<T extends { zones: string[] }>(e: T): T {
  return new Set(e.zones).size === e.zones.length ? e : { ...e, zones: [...new Set(e.zones)] }
}

/** Readable error message for the interface. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("")
}

export function firstName(name: string): string {
  return name.split(" ")[0] ?? name
}

export const AGENT_LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "brain-sync": "brain-sync",
  job: "Brain",
  dashboard: "Dashboard",
  mcp: "Agent (MCP)",
}

export const EVENT_VERB: Record<AgentEventType, string> = {
  started: "started a session",
  query: "is searching",
  write: "fed the brain",
  stopped: "ended a session",
}

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  fact: "Fact",
  decision: "Decision",
  task: "Task",
  procedure: "Procedure",
  question: "Question",
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      credentials: "same-origin",
    })
  } catch {
    throw new Error("Server unreachable: check your connection and try again.")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const { error: msg, details } = data as { error?: string; details?: unknown }
    // Readable details (list of sentences): appended to the message, for example the file of a skill that contains a secret.
    const lines = Array.isArray(details) && details.every((d) => typeof d === "string") ? (details as string[]) : []
    if (msg) throw new Error(lines.length ? `${msg} ${lines.join("; ")}` : msg)
    throw new Error(res.status === 401 ? "Session expired: please sign in again." : `Error ${res.status}`)
  }
  return data as T
}
