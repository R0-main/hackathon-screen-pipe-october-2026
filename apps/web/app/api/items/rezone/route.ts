import { z } from "zod"
import { contentText, contentZone, sessionOf, zoneScorer } from "@brain/core"
import { getStore } from "@/lib/store"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ZoneId = z.string().min(1).max(32)

const BySession = z.object({
  moves: z.array(z.object({ session_id: z.string().min(1).max(200), zone: ZoneId })).min(1).max(2000),
  dry_run: z.boolean().optional(),
})

const ByContent = z.object({
  by: z.literal("content"),
  /** Only the knowledge currently in these zones (all of them by default). */
  from: z.array(ZoneId).max(100).optional(),
  /** Only towards these zones (all of them by default). */
  to: z.array(ZoneId).max(100).optional(),
  /** Sessions opened in a project that a zone lists: their knowledge is filed by project (rezone by session), never by content. */
  keep_sessions: z.array(z.string().min(1).max(200)).max(20000).optional(),
  dry_run: z.boolean().optional(),
})

const Schema = z.union([ByContent, BySession])

/** Knowledge read per content rezone (the caller's own, most recent first). */
const CONTENT_SCAN_LIMIT = 5000
const SAMPLES = 25

export type RezoneResult = {
  dry_run: boolean
  /** Knowledge items moved (or that would be, in a dry run), in total and per zone. */
  moved: number
  zones: Record<string, number>
  /** Already in their project's zone. */
  already: number
  /** Sessions that gave knowledge to the brain, among those sent. */
  sessions: number
  unknown_zones: string[]
}

export type ContentRezoneResult = {
  dry_run: boolean
  /** Knowledge items moved (or that would be), in total, per destination and per zone left. */
  moved: number
  zones: Record<string, number>
  from: Record<string, number>
  /** The caller's knowledge read, and how much of it stayed in its project's zone (keep_sessions). */
  scanned: number
  kept: number
  /** A few of the moves, to review a dry run. */
  samples: { id: string; title: string; from: string; to: string; score: number }[]
  unknown_zones: string[]
}

/**
 * `brain rezone`: files the knowledge already drawn from sessions into their project's zone (session → zone, computed on
 * the computer from its Claude Code / Codex logs and the zones' projects). Only the caller's own knowledge moves, with
 * its tasks: nothing is distilled again.
 * `by: "content"` (`brain rezone --content`): files the caller's knowledge by what it says instead, with the zones'
 * keywords (contentZone): what clearly belongs to another zone moves there, the rest stays.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  if ("by" in body.data) return json(await rezoneByContent(viewer.real.id, body.data))
  const store = getStore()
  const known = new Set((await store.listZones()).map((z) => z.id))
  const target = new Map<string, string>()
  const unknown = new Set<string>()
  for (const m of body.data.moves) {
    if (known.has(m.zone)) target.set(sessionOf(m.session_id), m.zone)
    else unknown.add(m.zone)
  }
  const items = await store.listItemsBySessions(viewer.real.id, [...target.keys()])
  const byZone = new Map<string, string[]>()
  let already = 0
  for (const i of items) {
    const zone = target.get(i.session_id)
    if (!zone) continue
    if (i.zone === zone) already++
    else byZone.set(zone, [...(byZone.get(zone) ?? []), i.id])
  }
  const dryRun = Boolean(body.data.dry_run)
  const zones: Record<string, number> = {}
  let moved = 0
  for (const [zone, ids] of byZone) {
    const n = dryRun ? ids.length : await store.moveItems(ids, zone)
    zones[zone] = n
    moved += n
  }
  const result: RezoneResult = { dry_run: dryRun, moved, zones, already, sessions: new Set(items.map((i) => i.session_id)).size, unknown_zones: [...unknown] }
  return json(result)
})

async function rezoneByContent(authorId: string, opts: z.infer<typeof ByContent>): Promise<ContentRezoneResult> {
  const store = getStore()
  const zones = await store.listZones()
  const known = new Set(zones.map((z) => z.id))
  const unknown = [...new Set([...(opts.from ?? []), ...(opts.to ?? [])])].filter((z) => !known.has(z))
  const from = opts.from?.filter((z) => known.has(z))
  const to = opts.to?.filter((z) => known.has(z))
  const keep = new Set((opts.keep_sessions ?? []).map(sessionOf))
  const items = from?.length === 0 || to?.length === 0 ? [] : await store.listItems({ authorId, zones: from, limit: CONTENT_SCAN_LIMIT })
  const score = zoneScorer(zones)
  const byZone = new Map<string, string[]>()
  const left: Record<string, number> = {}
  const samples: ContentRezoneResult["samples"] = []
  let kept = 0
  for (const i of items) {
    const session = i.source?.session_id
    if (session && keep.has(sessionOf(session))) {
      kept++
      continue
    }
    const dest = contentZone(contentText(i), i.zone, score, { to })
    if (!dest) continue
    const ids = byZone.get(dest.zone) ?? []
    ids.push(i.id)
    byZone.set(dest.zone, ids)
    left[i.zone] = (left[i.zone] ?? 0) + 1
    if (samples.length < SAMPLES) samples.push({ id: i.id, title: i.title, from: i.zone, to: dest.zone, score: dest.score })
  }
  const dryRun = Boolean(opts.dry_run)
  const moved: Record<string, number> = {}
  let total = 0
  for (const [zone, ids] of byZone) {
    const n = dryRun ? ids.length : await store.moveItems(ids, zone)
    moved[zone] = n
    total += n
  }
  return { dry_run: dryRun, moved: total, zones: moved, from: left, scanned: items.length, kept, samples, unknown_zones: unknown }
}
