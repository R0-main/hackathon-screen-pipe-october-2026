// "State of the company" summary: LLM-free fallback, material sent to Claude (server or an admin's workstation)
// and lenient reading of its answer when it comes from `claude -p` on a workstation.

import { z } from "zod"
import type { CompanyStatus, KnowledgeItem, Profile, Task, Zone, ZoneStatus } from "./types"
import { truncate } from "./text"
import { slugify } from "./zones"

/** Author without a profile (deleted account…): a neutral label, without assuming the person's gender. */
export const UNKNOWN_PERSON = "Unknown person"

const OBJECTIVE_RE = /\b(objective|objectives|okr|okrs|goal|goals|target|targets|aim|aims|aiming|by the end of)\b/i

export function heuristicStatus(input: {
  zones: Zone[]
  items: KnowledgeItem[]
  tasks: Task[]
  profiles: Pick<Profile, "id" | "name">[]
  now?: Date
}): CompanyStatus {
  const now = input.now ?? new Date()
  const weekAgo = now.getTime() - 7 * 86400_000
  const names = new Map(input.profiles.map((p) => [p.id, p.name]))
  const zones: ZoneStatus[] = []
  let weekCount = 0
  let decisions = 0
  let busiest: { zone: string; n: number } | null = null

  for (const z of input.zones) {
    const items = input.items.filter((i) => i.zone === z.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
    const recent = items.filter((i) => new Date(i.created_at).getTime() >= weekAgo)
    const tasks = input.tasks.filter((t) => t.zone === z.id)
    const open = tasks.filter((t) => t.status === "open")
    const done = tasks.filter((t) => t.status === "done")
    weekCount += recent.length
    decisions += recent.filter((i) => i.kind === "decision").length
    if (!busiest || recent.length > busiest.n) busiest = { zone: z.name, n: recent.length }

    const objectives = items
      .filter((i) => OBJECTIVE_RE.test(`${i.title} ${i.body}`))
      .slice(0, 2)
      .map((i) => truncate(i.title, 110))

    const byAuthor = new Map<string, KnowledgeItem[]>()
    for (const i of recent) byAuthor.set(i.author_id, [...(byAuthor.get(i.author_id) ?? []), i])
    const who_did_what = [...byAuthor.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)
      .map(([author, list]) => ({
        person: names.get(author) ?? UNKNOWN_PERSON,
        did: `${list.length} contribution${list.length > 1 ? "s" : ""}, including "${truncate(list[0].title, 70)}"`,
      }))

    const lastDecision = items.find((i) => i.kind === "decision")
    const summary =
      items.length === 0
        ? "No knowledge yet."
        : `${items.length} items, ${recent.length} this week.` +
          (lastDecision ? ` Latest decision: ${truncate(lastDecision.title, 100)}.` : "")

    zones.push({
      zone: z.id,
      summary,
      objectives,
      progress: tasks.length ? `${done.length}/${tasks.length} tasks done` : recent.length ? "Steady activity, no tracked task" : "Quiet",
      next_steps: open.slice(0, 3).map((t) => truncate(t.title, 110)),
      who_did_what,
    })
  }

  const openTasks = input.tasks.filter((t) => t.status === "open").length
  const headline =
    `${weekCount} new item${weekCount === 1 ? "" : "s"} this week, ${decisions} decision${decisions === 1 ? "" : "s"}, ` +
    `${openTasks} open task${openTasks === 1 ? "" : "s"}.` +
    (busiest && busiest.n > 0 ? ` Most active zone: ${busiest.zone}.` : "")

  return { headline, zones, generated_at: now.toISOString(), generator: "heuristic" }
}

/**
 * Material for the "where the company stands" summary (GET /api/status/input): recent knowledge and tasks, zone by zone.
 * `generated_for`: the day covered (YYYY-MM-DD). Authors and owners are names, not ids.
 */
export type StatusInput = {
  company_name: string
  generated_for: string
  zones: { id: string; name: string; description: string }[]
  items: { zone: string; kind: string; title: string; body: string; author: string; created_at: string }[]
  tasks: { zone: string; title: string; status: "open" | "done"; assignee?: string }[]
}

export const STATUS_WINDOW_DAYS = 30
export const STATUS_MAX_ITEMS = 400
export const STATUS_MAX_TASKS = 400

/** Builds the summary material: last 30 days, 400 items at most (most recent first), people's names. */
export function buildStatusInput(input: {
  companyName: string
  zones: Pick<Zone, "id" | "name" | "description">[]
  items: KnowledgeItem[]
  tasks: Task[]
  profiles: Pick<Profile, "id" | "name">[]
  now?: Date
  generatedFor?: string
}): StatusInput {
  const now = input.now ?? new Date()
  const since = now.getTime() - STATUS_WINDOW_DAYS * 86400_000
  const names = new Map(input.profiles.map((p) => [p.id, p.name]))
  const known = new Set(input.zones.map((z) => z.id))
  const items = input.items
    .filter((i) => known.has(i.zone) && new Date(i.created_at).getTime() >= since)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, STATUS_MAX_ITEMS)
  const tasks = input.tasks
    .filter((t) => known.has(t.zone))
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || b.updated_at.localeCompare(a.updated_at))
    .slice(0, STATUS_MAX_TASKS)
  return {
    company_name: input.companyName,
    generated_for: input.generatedFor ?? now.toISOString().slice(0, 10),
    zones: input.zones.map((z) => ({ id: z.id, name: z.name, description: z.description })),
    items: items.map((i) => ({
      zone: i.zone,
      kind: i.kind,
      title: i.title,
      body: truncate(i.body, 1200),
      author: names.get(i.author_id) ?? UNKNOWN_PERSON,
      created_at: i.created_at,
    })),
    tasks: tasks.map((t) => {
      const assignee = t.assignee_id ? names.get(t.assignee_id) : undefined
      return { zone: t.zone, title: t.title, status: t.status, ...(assignee ? { assignee } : {}) }
    }),
  }
}

// --- Lenient reading of a "JSON" answer from Claude --------------------------------------------------------------------

/** Index of the closing brace that balances the one at `start` (JSON strings included), or -1. */
function matchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return i
  }
  return -1
}

function parseLoose(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    // trailing commas ("[1, 2,]"): a frequent error in model output
    try {
      return JSON.parse(json.replace(/,\s*([}\]])/g, "$1"))
    } catch {
      return undefined
    }
  }
}

/** JSON objects found in free text (code blocks, prose around…), first to last, without descending into a found object. */
export function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let tries = 0
  for (let start = text.indexOf("{"); start !== -1 && tries < 50; start = text.indexOf("{", start + 1)) {
    tries++
    const end = matchingBrace(text, start)
    if (end === -1) continue
    const v = parseLoose(text.slice(start, end + 1))
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>)
      start = end
    }
  }
  return out
}

const looseText = z.string().catch("")
const looseList = z.array(z.unknown()).catch([])
const LooseZoneSchema = z.object({
  zone: z.string(),
  summary: looseText,
  objectives: looseList,
  progress: looseText,
  next_steps: looseList,
  who_did_what: looseList,
})

const clean = (s: string, max: number) => truncate(s.replace(/\s+/g, " ").trim(), max)
const strings = (list: unknown[], n: number, max: number) =>
  list
    .map((x) => (typeof x === "string" || typeof x === "number" ? clean(String(x), max) : ""))
    .filter(Boolean)
    .slice(0, n)
const firstString = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string
  return ""
}

/**
 * Reads Claude's answer to the buildCliStatusPrompt prompt: the raw output of `claude -p --output-format json`
 * ({ result: "…" } envelope) or the text itself, with or without a code block or text around it.
 * Validates the shape (zod), drops unknown or duplicate zones, bounds the lengths.
 * Null if nothing is usable (no JSON, no headline, envelope in error).
 */
export function parseStatusJson(text: string, zoneIds: string[]): { headline: string; zones: ZoneStatus[] } | null {
  if (typeof text !== "string" || !text.trim()) return null
  const objects = jsonObjects(text)
  // CLI envelope: the summary is in `result` (text) or `structured_output` (object).
  const envelope = objects.find((o) => !("headline" in o) && ("result" in o || "structured_output" in o || "is_error" in o))
  if (envelope && !objects.some((o) => "headline" in o)) {
    if (envelope.is_error === true) return null
    if (envelope.structured_output && typeof envelope.structured_output === "object") return parseStatusJson(JSON.stringify(envelope.structured_output), zoneIds)
    return typeof envelope.result === "string" ? parseStatusJson(envelope.result, zoneIds) : null
  }
  const candidate = objects.find((o) => typeof o.headline === "string" && o.headline.trim())
  if (!candidate) return null
  const ids = new Map<string, string>()
  for (const id of zoneIds) for (const k of [id, id.toLowerCase(), slugify(id)]) if (!ids.has(k)) ids.set(k, id)
  const zones: ZoneStatus[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(candidate.zones) ? candidate.zones : []) {
    const parsed = LooseZoneSchema.safeParse(raw)
    if (!parsed.success) continue
    const z = parsed.data
    const id = ids.get(z.zone) ?? ids.get(z.zone.trim().toLowerCase()) ?? ids.get(slugify(z.zone))
    if (!id || seen.has(id)) continue
    seen.add(id)
    zones.push({
      zone: id,
      summary: clean(z.summary, 1500),
      objectives: strings(z.objectives, 10, 300),
      progress: clean(z.progress, 800),
      next_steps: strings(z.next_steps, 10, 300),
      who_did_what: z.who_did_what
        .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object" && !Array.isArray(w))
        .map((w) => ({ person: clean(firstString(w, ["person", "name", "who"]), 80), did: clean(firstString(w, ["did", "action", "what"]), 300) }))
        .filter((w) => w.person && w.did)
        .slice(0, 12),
    })
  }
  return { headline: clean(candidate.headline as string, 600), zones }
}
