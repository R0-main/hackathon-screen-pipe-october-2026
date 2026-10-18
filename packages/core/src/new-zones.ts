// New zones created automatically: every day, Claude re-reads recent knowledge and spots an area of work
// that has no zone of its own (legal filed for lack of a better place in "Leadership"…). Nothing waits for approval:
// the safeguards below alone decide what gets created, and the order of existing zones is never touched.

import { z } from "zod"
import type { KnowledgeItem, KnowledgeKind, Zone } from "./types"
import type { ZoneHint } from "./distill"
import { jsonObjects } from "./status"
import { normalize, truncate } from "./text"
import { isCoreZone, slugify } from "./zones"

/** Material re-read: knowledge from the last 30 days, 300 at most (the most recent). */
export const NEW_ZONES_WINDOW_DAYS = 30
export const NEW_ZONES_MAX_ITEMS = 300
/** Below this, there is not enough for an area to emerge: Claude is not called. */
export const NEW_ZONES_MIN_CORPUS = 12
/** A new zone must gather at least this many items already in the brain. */
export const NEW_ZONE_MIN_ITEMS = 4
export const NEW_ZONES_PER_RUN = 2
/** Beyond this, the brain becomes unreadable: no more zones are created automatically. */
export const MAX_ZONES = 12

export type NewZonesInput = {
  company_name: string
  zones: ZoneHint[]
  /** `ref`: short number Claude cites (fewer tokens than a UUID, and no invented id). */
  items: { ref: number; id: string; author_id: string; zone: string; kind: KnowledgeKind; title: string; body: string }[]
}

/** What Claude proposes: `items` = numbers (`ref`) of the items to file in the new zone. */
export type NewZoneProposal = { name: string; description: string; keywords: string[]; items: number[] }

export type NewZonePlan = {
  zone: { id: string; name: string; description: string; keywords: string[] }
  /** Moved items, with their original zone (to carry read access over). */
  items: { id: string; author_id: string; from: string }[]
}

export function buildNewZonesInput(input: { companyName: string; zones: Zone[]; items: KnowledgeItem[] }): NewZonesInput {
  return {
    company_name: input.companyName,
    zones: input.zones.map(({ id, name, description, keywords }) => ({ id, name, description, keywords })),
    items: input.items.slice(0, NEW_ZONES_MAX_ITEMS).map((i, n) => ({
      ref: n + 1,
      id: i.id,
      author_id: i.author_id,
      zone: i.zone,
      kind: i.kind,
      title: truncate(i.title, 140),
      body: truncate(i.body.replace(/\s+/g, " "), 240),
    })),
  }
}

/**
 * Safeguards applied to Claude's proposal, since nobody reviews it:
 * - never more than NEW_ZONES_PER_RUN zones per run, nor more than MAX_ZONES in total;
 * - never a duplicate of an existing zone (same id, same name, or a name that yields the same id);
 * - at least NEW_ZONE_MIN_ITEMS items actually provided, each moved only once;
 * - names, descriptions and keywords bounded as in the admin.
 */
export function planNewZones(proposals: NewZoneProposal[], input: NewZonesInput, existing: Pick<Zone, "id" | "name">[]): NewZonePlan[] {
  // The core, in every brain, does not take a team zone's place.
  const room = Math.min(NEW_ZONES_PER_RUN, MAX_ZONES - existing.filter((z) => !isCoreZone(z.id)).length)
  if (room <= 0) return []
  const byRef = new Map(input.items.map((i) => [i.ref, i]))
  const takenIds = new Set(existing.flatMap((z) => [z.id, slugify(z.name)]))
  const takenNames = new Set(existing.map((z) => normalize(z.name).trim()))
  const claimed = new Set<number>()
  const out: NewZonePlan[] = []
  for (const p of proposals) {
    if (out.length >= room) break
    const name = p.name.replace(/\s+/g, " ").trim().slice(0, 40).trim()
    if (!name) continue
    const id = slugify(name)
    if (takenIds.has(id) || takenNames.has(normalize(name).trim())) continue
    const refs = [...new Set(p.items)].filter((r) => byRef.has(r) && !claimed.has(r))
    if (refs.length < NEW_ZONE_MIN_ITEMS) continue
    for (const r of refs) claimed.add(r)
    takenIds.add(id)
    takenNames.add(normalize(name).trim())
    const keywords = [...new Set(p.keywords.map((k) => normalize(k).trim()).filter((k) => k.length >= 2 && k.length <= 40))].slice(0, 25)
    out.push({
      zone: { id, name, description: truncate(p.description.replace(/\s+/g, " ").trim(), 300), keywords },
      items: refs.map((r) => {
        const i = byRef.get(r)!
        return { id: i.id, author_id: i.author_id, from: i.zone }
      }),
    })
  }
  return out
}

/**
 * Who reads the new zone: its authors, and every member who read ALL the zones its items come from.
 * Nobody loses sight of an item they could read, and nobody discovers one they could not read.
 * Admins read everything anyway: only members are concerned.
 */
export function readersOfNewZone(plan: NewZonePlan, members: { id: string; readable: string[] }[]): string[] {
  const sources = [...new Set(plan.items.map((i) => i.from))]
  const authors = new Set(plan.items.map((i) => i.author_id))
  return members.filter((m) => authors.has(m.id) || sources.every((z) => m.readable.includes(z))).map((m) => m.id)
}

const LooseProposalSchema = z.object({
  name: z.string(),
  description: z.string().catch(""),
  keywords: z.array(z.unknown()).catch([]),
  items: z.array(z.unknown()).catch([]),
})

/**
 * `claude -p` answer (Claude Code subscription, on a workstation or in CI): tolerates text around it, a code block,
 * the CLI's JSON envelope, and numbers written "#12" or "12". `[]` if Claude proposes nothing, null if unreadable.
 */
export function parseNewZonesJson(text: string): NewZoneProposal[] | null {
  if (typeof text !== "string" || !text.trim()) return null
  const objects = jsonObjects(text)
  const envelope = objects.find((o) => !("zones" in o) && ("result" in o || "structured_output" in o || "is_error" in o))
  if (envelope && !objects.some((o) => "zones" in o)) {
    if (envelope.is_error === true) return null
    if (envelope.structured_output && typeof envelope.structured_output === "object") return parseNewZonesJson(JSON.stringify(envelope.structured_output))
    return typeof envelope.result === "string" ? parseNewZonesJson(envelope.result) : null
  }
  const candidate = objects.find((o) => Array.isArray(o.zones))
  if (!candidate) return null
  const out: NewZoneProposal[] = []
  for (const raw of candidate.zones as unknown[]) {
    const parsed = LooseProposalSchema.safeParse(raw)
    if (!parsed.success) continue
    const p = parsed.data
    out.push({
      name: p.name,
      description: p.description,
      keywords: p.keywords.filter((k): k is string => typeof k === "string"),
      items: p.items.map((r) => (typeof r === "number" ? r : Number(String(r).replace(/^#/, "")))).filter((r) => Number.isInteger(r)),
    })
  }
  return out
}
