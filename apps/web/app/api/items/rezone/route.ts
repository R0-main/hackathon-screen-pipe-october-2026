import { z } from "zod"
import { sessionOf } from "@brain/core"
import { getStore } from "@/lib/store"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({
  moves: z
    .array(z.object({ session_id: z.string().min(1).max(200), zone: z.string().min(1).max(32) }))
    .min(1)
    .max(2000),
  dry_run: z.boolean().optional(),
})

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

/**
 * `brain rezone`: files the knowledge already drawn from sessions into their project's zone (session → zone, computed on
 * the computer from its Claude Code / Codex logs and the zones' projects). Only the caller's own knowledge moves, with
 * its tasks: nothing is distilled again.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
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
