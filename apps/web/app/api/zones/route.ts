import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Zones de l'entreprise (avec mots-clés, utilisés par les hooks pour classer un prompt) et droits de l'utilisateur. */
export const GET = withViewer(async (_req, viewer) => {
  const store = getStore()
  const [zones, stats] = await Promise.all([store.listZones(), store.zoneStats()])
  const counts = new Map(stats.map((s) => [s.zone, s.count]))
  return json({
    zones: zones.map((z) => ({
      ...z,
      readable: viewer.access.readable.includes(z.id),
      count: viewer.access.readable.includes(z.id) ? (counts.get(z.id) ?? 0) : undefined,
    })),
  })
})
