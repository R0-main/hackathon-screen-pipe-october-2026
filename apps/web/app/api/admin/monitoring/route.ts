import { HEALTH_ORDER, posteHealth, type PosteHealthResult, type Profile, type SyncReportRow } from "@brain/core"
import { getStore } from "@/lib/store"
import { listIncidents, serverInfo } from "@/lib/monitoring"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export type PosteStatus = {
  profile: Pick<Profile, "id" | "name" | "title" | "role">
  health: PosteHealthResult
  report: SyncReportRow | null
  last_event_at: string | null
  /** Connaissances envoyées par ce poste sur les 7 derniers jours (d'après ses comptes rendus). */
  items_7d: number
  syncs_7d: number
  errors_7d: number
}

export type MonitoringState = Awaited<ReturnType<typeof buildMonitoring>>

const WINDOW_7D_MS = 7 * 86400_000

async function buildMonitoring() {
  const s = getStore()
  const now = Date.now()
  const since7d = new Date(now - WINDOW_7D_MS).toISOString()
  const [profiles, latest, history, events] = await Promise.all([
    s.listProfiles(),
    s.latestSyncReports(),
    s.listSyncReports({ limit: 2000 }),
    s.listEvents({ sinceIso: new Date(now - 30 * 86400_000).toISOString(), limit: 5000 }),
  ])
  const lastEvent = new Map<string, string>()
  for (const e of events) if (!lastEvent.has(e.user_id)) lastEvent.set(e.user_id, e.at)
  const latestBy = new Map(latest.map((r) => [r.user_id, r]))
  const postes: PosteStatus[] = profiles.map((p) => {
    const report = latestBy.get(p.id) ?? null
    const recent = history.filter((r) => r.user_id === p.id && r.at >= since7d)
    return {
      profile: { id: p.id, name: p.name, title: p.title, role: p.role },
      health: posteHealth({ report, lastEventAt: lastEvent.get(p.id) ?? null, uninstalledAt: p.uninstalled_at, now }),
      report,
      last_event_at: lastEvent.get(p.id) ?? null,
      items_7d: recent.reduce((n, r) => n + r.items_sent, 0),
      syncs_7d: recent.length,
      errors_7d: recent.filter((r) => !r.ok).length,
    }
  })
  postes.sort((a, b) => HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status] || a.profile.name.localeCompare(b.profile.name))
  const counts = { ok: 0, late: 0, error: 0, never: 0, uninstalled: 0 }
  for (const p of postes) counts[p.health.status]++
  return {
    generated_at: new Date(now).toISOString(),
    postes,
    counts,
    incidents: listIncidents(30),
    server: { ...serverInfo(), store: s.kind, stream: s.eventNotifyMode() },
  }
}

/** GET /api/admin/monitoring — l'état de chaque poste (dernière synchro, retard, erreur), les incidents serveur récents. */
export const GET = withViewer(async () => json(await buildMonitoring()), { admin: true })
