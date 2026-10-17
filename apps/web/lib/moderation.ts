// The brain's moderator: every 15 min, Claude rereads what arrived since the previous run and keeps, fixes or removes
// each knowledge item. The run is done by Claude Code on an admin's computer (`brain moderate`, started by its scheduled
// sync, with their subscription token), or by the server with the company's API key ("Run now"). A cursor (arrival
// date) remembers where the last run stopped.
// The admins' log only keeps metadata (zone, kind, reason), never the removed text.

import {
  MODERATION_BATCH,
  MODERATION_CHUNK,
  MODERATION_REASON_LABELS,
  applyModeration,
  buildModerationInput,
  moderationReason,
  redactText,
  truncate,
  type KnowledgeItem,
  type ModerationInput,
  type ModerationReason,
  type ModerationVerdict,
} from "@brain/core"
import { moderateKnowledge } from "@brain/core/claude"
import { getClaude } from "./ai"
import { getStore } from "./store"

/** `claude-code`: Claude Code on an admin's computer (their subscription); `server`: the company's API key. */
export type ModerationVia = "claude-code" | "server"

export type ModerationLogEntry = {
  at: string
  author: string
  zone: string
  kind: string
  decision: "edit" | "reject"
  category?: ModerationReason
  /** One-sentence reason (redacted); absent for a "personal" or "secret" removal, whose reason could quote the content. */
  reason?: string
}

export type ModerationRun = {
  at: string
  via: ModerationVia
  status: "done" | "nothing" | "off" | "no_claude" | "claude_error"
  reviewed: number
  edited: number
  rejected: number
  /** Knowledge still waiting after this run (reviewed at the next one). */
  remaining?: number
}

type Cursor = { at: string; ids: string[] }

const ENABLED_SETTING = "moderation"
const CURSOR_SETTING = "moderation-cursor"
const LOG_SETTING = "moderation-log"
const RUNS_SETTING = "moderation-runs"
const LOG_MAX = 100
const RUNS_MAX = 30
/** First run: what arrived in the last 24 h. */
const FIRST_WINDOW_MS = 24 * 3600_000
/** Knowledge already in place shown alongside (duplicates): the most recent, over 90 days. */
const PUBLISHED_DAYS = 90
const PUBLISHED_MAX = 400
/** Added by an admin (onboarding, connectors): not reviewed. */
const UNMODERATED_TOOLS = new Set(["onboarding", "connector"])
const CONCURRENCY = 3

const store = () => getStore()

async function readSetting<T>(name: string, fallback: T): Promise<T> {
  const raw = await store().getOrgSetting(name)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function moderationEnabled(): Promise<boolean> {
  return (await store().getOrgSetting(ENABLED_SETTING)) !== "off"
}

export async function setModerationEnabled(on: boolean) {
  await store().setOrgSetting(ENABLED_SETTING, on ? null : "off")
}

/** The admins' log; reasons saved by earlier (French) versions are read with their current id. */
export const loadModerationLog = async () =>
  (await readSetting<ModerationLogEntry[]>(LOG_SETTING, [])).map((e) => (e.category ? { ...e, category: moderationReason(e.category) ?? "other" } : e))
export const loadModerationRuns = () => readSetting<ModerationRun[]>(RUNS_SETTING, [])

async function loadCursor(): Promise<Cursor | null> {
  const c = await readSetting<Cursor | null>(CURSOR_SETTING, null)
  return c && typeof c.at === "string" && Array.isArray(c.ids) ? c : null
}

function isPending(item: KnowledgeItem, cursor: Cursor | null, since: string): boolean {
  if (UNMODERATED_TOOLS.has(item.source.tool) || item.superseded_by) return false
  if (item.created_at < since) return false
  return !(cursor && item.created_at === cursor.at && cursor.ids.includes(item.id))
}

/** Knowledge not reviewed yet, oldest first. */
async function pendingItems(): Promise<KnowledgeItem[]> {
  const cursor = await loadCursor()
  const since = cursor?.at ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString()
  const items = await store().listItems({ sinceIso: since, limit: 5000 })
  return items.filter((i) => isPending(i, cursor, since)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}

/** Material for a run: up to MODERATION_BATCH knowledge items to review (with their `id`), or the reason to do nothing. */
export async function moderationInput(): Promise<{ input: ModerationInput; remaining: number } | { skipped: "off" | "nothing" }> {
  if (!(await moderationEnabled())) return { skipped: "off" }
  const pending = await pendingItems()
  if (!pending.length) return { skipped: "nothing" }
  const batch = pending.slice(0, MODERATION_BATCH)
  const s = store()
  const [org, zones, profiles, published] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listProfiles(),
    s.listItems({ sinceIso: new Date(Date.now() - PUBLISHED_DAYS * 86400_000).toISOString(), limit: PUBLISHED_MAX, excludeSuperseded: true }),
  ])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const input = buildModerationInput({
    companyName: org.name,
    zones,
    items: batch.map((i) => ({ ...i, author: names.get(i.author_id) ?? "unknown" })),
    published,
  })
  return { input, remaining: pending.length - batch.length }
}

export type VerdictById = Omit<ModerationVerdict, "ref"> & { id: string }

/**
 * Applies a run: `ids` = the reviewed knowledge (in the material's order), `verdicts` = Claude's decisions (no verdict:
 * kept as is). Knowledge already reviewed, deleted in the meantime or added by an admin is ignored. Removes the
 * rejected ones, fixes the others, then moves the cursor past the last one reviewed.
 */
export async function applyModerationVerdicts(ids: string[], verdicts: VerdictById[], via: ModerationVia): Promise<ModerationRun> {
  const s = store()
  const cursor = await loadCursor()
  const since = cursor?.at ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString()
  const found = await Promise.all([...new Set(ids)].map((id) => s.getItem(id)))
  const batch = found.filter((i): i is KnowledgeItem => Boolean(i) && isPending(i!, cursor, since))
  const byId = new Map(verdicts.map((v) => [v.id, v]))
  const refs: ModerationVerdict[] = batch.flatMap((item, n) => {
    const v = byId.get(item.id)
    if (!v) return []
    const { id: _id, ...rest } = v
    return [{ ...rest, ref: n + 1 }]
  })
  const zones = await s.listZones()
  const out = applyModeration(batch, refs, new Set(zones.map((z) => z.id)))

  for (const r of out.rejected) await s.deleteItem(r.item.id)
  const edited = out.kept.filter((k) => k.edited)
  for (const k of edited) await s.updateItem(k.item.id, { title: k.item.title, body: k.item.body, kind: k.item.kind, zone: k.item.zone })

  // Cursor: after the most recent of the reviewed knowledge (those that arrived in the same millisecond are kept by id).
  if (batch.length) {
    const last = batch.reduce((m, i) => (i.created_at > m ? i.created_at : m), batch[0].created_at)
    const atLast = batch.filter((i) => i.created_at === last).map((i) => i.id)
    const ids = cursor && cursor.at === last ? [...new Set([...cursor.ids, ...atLast])] : atLast
    await s.setOrgSetting(CURSOR_SETTING, JSON.stringify({ at: last, ids }))
  }

  const profiles = await s.listProfiles()
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const at = new Date().toISOString()
  const entries: ModerationLogEntry[] = [
    ...edited.map((k) => ({ at, author: names.get(k.item.author_id) ?? "unknown", zone: k.item.zone, kind: k.item.kind, decision: "edit" as const })),
    ...out.rejected.map((r) => ({
      at,
      author: names.get(r.item.author_id) ?? "unknown",
      zone: r.item.zone,
      kind: r.item.kind,
      decision: "reject" as const,
      category: r.category,
      ...(r.category === "personal" || r.category === "secret" || !r.reason ? {} : { reason: truncate(redactText(r.reason), 160) }),
    })),
  ]
  if (entries.length) await s.setOrgSetting(LOG_SETTING, JSON.stringify([...entries, ...(await loadModerationLog())].slice(0, LOG_MAX)))

  // The activity feed shows the moderator at work: one line per zone, quoting nothing of the removed text.
  const byZone = new Map<string, ModerationReason[]>()
  for (const r of out.rejected) byZone.set(r.item.zone, [...(byZone.get(r.item.zone) ?? []), r.category])
  const actor = profiles.find((p) => p.role === "admin") ?? profiles[0]
  if (byZone.size && actor) {
    await s.insertEvents(
      [...byZone].map(([zone, reasons]) => ({
        user_id: actor.id,
        agent: "job" as const,
        type: "write" as const,
        zones: [zone],
        summary: `Moderator: ${reasons.length} knowledge item${reasons.length > 1 ? "s" : ""} removed (${[...new Set(reasons.map((c) => MODERATION_REASON_LABELS[c]))].join(", ")})`,
        at,
      })),
    )
  }

  const remaining = (await pendingItems()).length
  return recordRun({ at, via, status: batch.length ? "done" : "nothing", reviewed: batch.length, edited: edited.length, rejected: out.rejected.length, remaining })
}

async function recordRun(run: ModerationRun): Promise<ModerationRun> {
  // Empty runs (every 15 min) do not fill the history.
  if (run.status !== "nothing" && run.status !== "off") {
    await store().setOrgSetting(RUNS_SETTING, JSON.stringify([run, ...(await loadModerationRuns())].slice(0, RUNS_MAX)))
  }
  return run
}

type Moderate = (input: ModerationInput) => Promise<ModerationVerdict[] | null>

/**
 * Run done by the server, with the company's API key ("Run now"): batches of MODERATION_CHUNK reviewed in parallel. Only
 * the batches reviewed in a row from the start count: a batch without an answer (and the rest) waits for the next run,
 * so the cursor never skips knowledge that was not reviewed. `moderate` replaces Claude (tests).
 */
export async function runModeration(moderate?: Moderate): Promise<ModerationRun> {
  const at = new Date().toISOString()
  const material = await moderationInput()
  if ("skipped" in material) return { at, via: "server", status: material.skipped, reviewed: 0, edited: 0, rejected: 0 }
  if (!moderate) {
    const claude = await getClaude()
    if (!claude) return { at, via: "server", status: "no_claude", reviewed: 0, edited: 0, rejected: 0, remaining: material.input.items.length + material.remaining }
    moderate = (input) => moderateKnowledge(claude, input)
  }
  const { input } = material
  const chunks: ModerationInput[] = []
  for (let i = 0; i < input.items.length; i += MODERATION_CHUNK) chunks.push({ ...input, items: input.items.slice(i, i + MODERATION_CHUNK) })
  const answers: (ModerationVerdict[] | null)[] = new Array(chunks.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++
      try {
        answers[k] = await moderate!(chunks[k])
      } catch (err) {
        console.error("[moderation]", err instanceof Error ? err.message : err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
  const done = answers.findIndex((a) => !a)
  const usable = done === -1 ? chunks.length : done
  if (usable === 0) return recordRun({ at, via: "server", status: "claude_error", reviewed: 0, edited: 0, rejected: 0, remaining: input.items.length + material.remaining })
  const items = chunks.slice(0, usable).flatMap((c) => c.items)
  const refToId = new Map(items.map((i) => [i.ref, i.id!]))
  const verdicts: VerdictById[] = answers
    .slice(0, usable)
    .flatMap((a) => a!)
    .flatMap(({ ref, ...v }) => (refToId.has(ref) ? [{ ...v, id: refToId.get(ref)! }] : []))
  return applyModerationVerdicts(
    items.map((i) => i.id!),
    verdicts,
    "server",
  )
}
