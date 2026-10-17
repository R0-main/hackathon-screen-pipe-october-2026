import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The company's zones (with keywords, used by the hooks to classify a prompt) and the user's permissions. */
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
