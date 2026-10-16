import { getStore } from "@/lib/store"
import { refreshStatus } from "@/lib/brain"
import { canRead } from "@/lib/access"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** État de l'entreprise (filtré par zones lisibles). */
export const GET = withViewer(async (_req, viewer) => {
  const status = await getStore().getStatus()
  return json(status ? { ...status, zones: status.zones.filter((z) => canRead(viewer.access, z.zone)) } : null)
})

/** Régénère l'état (Claude si ANTHROPIC_API_KEY, sinon heuristique). */
export const POST = withViewer(async (_req, viewer) => json(await refreshStatus(viewer)), { admin: true })
