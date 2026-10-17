// Daily "new zones" job (Vercel cron, see app/api/cron/new-zones): for a company, Claude re-reads the
// recent knowledge, and the zones it spots are created right away, without approval. The knowledge
// concerned is moved there and read access follows (readersOfNewZone): nobody loses or gains sight of anything.
// Everything runs in a company's context (runInOrg), with the server's API key: nothing runs on the workstations.

import {
  DEFAULT_TIMEZONE,
  NEW_ZONES_MAX_ITEMS,
  NEW_ZONES_MIN_CORPUS,
  NEW_ZONES_WINDOW_DAYS,
  MAX_ZONES,
  buildNewZonesInput,
  planNewZones,
  readersOfNewZone,
  redactText,
  type NewZoneProposal,
  type NewZonesInput,
} from "@brain/core"
import { proposeNewZones } from "@brain/core/claude"
import { getClaude } from "./ai"
import { zonesFromDraft } from "./onboarding"
import { getStore } from "./store"

export type NewZonesOutcome =
  | { status: "created"; zones: { id: string; name: string; items: number; readers: number }[] }
  | { status: "unchanged" }
  | { status: "skipped"; reason: "no_claude" | "max_zones" | "too_few_items" | "claude_error" }

/** `server`: Claude called by the server (API key); `claude-code`: proposal made by the company's Claude Code (subscription). */
export type NewZonesVia = "server" | "claude-code"

export type NewZonesRun = NewZonesOutcome & { at: string; via?: NewZonesVia }

/** What the company's Claude Code proposes (`brain refresh-zones`): items by id, not by number. */
export type AgentZoneProposal = { name: string; description: string; keywords: string[]; item_ids: string[] }

/** Local time (company time zone) of the daily run. vercel.json triggers the job at 8am and 9am UTC: one of the two falls at 10am in Paris, summer and winter. */
export const NEW_ZONES_HOUR = 10

const LOG_SETTING = "new-zones-log"
const LOG_MAX = 30

export function localHour(at = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(at)
  return Number(h)
}

export function localDay(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE }).format(at)
}

type Propose = (input: NewZonesInput) => Promise<NewZoneProposal[] | null>

/**
 * One run for the current company. `propose` replaces the Claude call (tests). Without a server-side API key, nothing
 * is created: a zone invented by a heuristic, without review, would do more harm than good.
 */
export async function runNewZones(opts: { propose?: Propose; via?: NewZonesVia } = {}): Promise<NewZonesRun> {
  const outcome = await evolve(opts.propose)
  const run: NewZonesRun = { ...outcome, at: new Date().toISOString(), via: opts.via ?? "server" }
  // Without a key, the server's cron runs every day for nothing (the company may go through its subscription, in CI):
  // the history only keeps real runs.
  if (!(outcome.status === "skipped" && outcome.reason === "no_claude")) await appendLog(run)
  return run
}

/** Material sent to the company's Claude Code (GET /api/admin/zones/auto/input), or the reason to do nothing. */
export async function newZonesInput(): Promise<{ input: NewZonesInput } | { skipped: "max_zones" | "too_few_items" }> {
  const s = getStore()
  const zones = await s.listZones()
  if (zones.length >= MAX_ZONES) return { skipped: "max_zones" }
  const since = new Date(Date.now() - NEW_ZONES_WINDOW_DAYS * 86400_000).toISOString()
  const [items, org] = await Promise.all([s.listItems({ sinceIso: since, limit: NEW_ZONES_MAX_ITEMS }), s.getOrg()])
  if (items.length < NEW_ZONES_MIN_CORPUS) return { skipped: "too_few_items" }
  return { input: buildNewZonesInput({ companyName: org.name, zones, items }) }
}

/**
 * Applies what the company's Claude Code proposed, with exactly the safeguards of a server run.
 * The material is re-read here: an item that arrived, was deleted or left the window in the meantime is simply
 * ignored, and an invented id points to nothing.
 */
export function applyAgentProposals(zones: AgentZoneProposal[]): Promise<NewZonesRun> {
  return runNewZones({
    via: "claude-code",
    propose: async (input) => {
      const refs = new Map(input.items.map((i) => [i.id, i.ref]))
      return zones.map((z) => ({ ...z, items: z.item_ids.map((id) => refs.get(id)).filter((r): r is number => r !== undefined) }))
    },
  })
}

async function evolve(propose?: Propose): Promise<NewZonesOutcome> {
  const s = getStore()
  const claude = propose ? null : await getClaude()
  if (!propose && !claude) return { status: "skipped", reason: "no_claude" }
  const material = await newZonesInput()
  if ("skipped" in material) return { status: "skipped", reason: material.skipped }
  const input = material.input
  const proposals = propose ? await propose(input) : await proposeNewZones(claude!, input)
  if (!proposals) return { status: "skipped", reason: "claude_error" }
  // Re-read right before writing: a zone created in the admin in the meantime is not duplicated.
  const current = await s.listZones()
  const plans = planNewZones(proposals, input, current)
  if (plans.length === 0) return { status: "unchanged" }

  const clean = (t: string) => redactText(t).trim()
  const created = zonesFromDraft(
    { zones: plans.map((p) => ({ ...p.zone, name: clean(p.zone.name) || p.zone.name, description: clean(p.zone.description) })) },
    current,
  )
  for (const z of created) await s.upsertZone(z)

  const profiles = await s.listProfiles()
  const members = profiles.filter((p) => p.role !== "admin")
  const access = await s.listZoneAccess()
  const rows = new Map(members.map((m) => [m.id, access.filter((a) => a.user_id === m.id).map(({ zone_id, can_write }) => ({ zone_id, can_write }))]))
  const granted = new Set<string>()
  const result: { id: string; name: string; items: number; readers: number }[] = []
  for (const [k, plan] of plans.entries()) {
    const zone = created[k]
    // Permissions computed BEFORE the move, on the original zones: the order of the plans changes nothing.
    const readers = readersOfNewZone(plan, members.map((m) => ({ id: m.id, readable: (rows.get(m.id) ?? []).map((r) => r.zone_id) })))
    for (const id of readers) {
      rows.get(id)!.push({ zone_id: zone.id, can_write: true })
      granted.add(id)
    }
    const moved = await s.moveItems(plan.items.map((i) => i.id), zone.id)
    result.push({ id: zone.id, name: zone.name, items: moved, readers: readers.length })
  }
  for (const id of granted) await s.setZoneAccess(id, rows.get(id)!)

  // The new zone's neon lights up, and the activity feed says why. It takes an account: an admin preferably.
  const actor = profiles.find((p) => p.role === "admin") ?? profiles[0]
  if (actor) {
    await s.insertEvents(
      result.map((z) => ({
        user_id: actor.id,
        agent: "job" as const,
        type: "write" as const,
        zones: [z.id],
        summary: `New zone created automatically: ${z.name} (${z.items} item${z.items === 1 ? "" : "s"} filed here)`,
        at: new Date().toISOString(),
      })),
    )
  }
  return { status: "created", zones: result }
}

/** History of runs (the last 30), readable by admins: GET /api/admin/zones/auto. */
export async function loadNewZonesLog(): Promise<NewZonesRun[]> {
  const raw = await getStore().getOrgSetting(LOG_SETTING)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function appendLog(run: NewZonesRun) {
  const log = await loadNewZonesLog()
  await getStore().setOrgSetting(LOG_SETTING, JSON.stringify([run, ...log].slice(0, LOG_MAX)))
}
