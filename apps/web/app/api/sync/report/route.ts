import { SyncReportSchema, posteHealth } from "@brain/core"
import { getStore } from "@/lib/store"
import { sendAlert } from "@/lib/monitoring"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/sync/report — le poste rend compte de chaque `brain sync` (réussi ou non) : compteurs seulement, jamais
 * de contenu. Sert à la page Supervision ; une synchro en échec déclenche une alerte webhook (au plus une par heure et par poste).
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, SyncReportSchema)
  if ("response" in body) return body.response
  const report = body.data
  const row = await getStore().saveSyncReport(viewer.real.id, { ...report, at: clamp(report.at) })
  const health = posteHealth({ report: row, lastEventAt: null, now: Date.now() })
  if (!report.ok) void sendAlert(`sync-failed:${viewer.real.id}`, `Synchronisation en échec sur le poste de ${viewer.real.name} : ${report.error ?? "erreur inconnue"}`)
  return json({ saved: true, health: health.status }, 201)
})

/** Une date absente, invalide ou dans le futur devient « maintenant ». */
function clamp(at: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t) || t > Date.now() + 60_000) return new Date().toISOString()
  return new Date(t).toISOString()
}
