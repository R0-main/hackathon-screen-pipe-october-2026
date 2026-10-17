import { getRootStore } from "@/lib/store"
import { serverInfo } from "@/lib/monitoring"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/health — sonde pour un superviseur externe (Uptime Kuma, Better Stack, cron…). 200 si le stockage répond,
 * 503 sinon ; aucune donnée d'entreprise. `stream` : comment le flux temps réel est prévenu (local, notify, poll).
 * `migrations` (Postgres) : dernière migration appliquée en base, dernière livrée avec ce code, et si la base est à
 * jour ; une base en retard ne fait pas échouer la sonde (le cerveau marche en mode dégradé), elle le signale.
 */
export async function GET() {
  const store = getRootStore()
  let db: "ok" | "ko" = "ok"
  let detail: string | undefined
  let migrations: { applied: number; last: string | null; expected: string | null; up_to_date: boolean | null } | undefined
  try {
    await store.getOrg()
    const status = await store.migrationStatus()
    if (status) {
      const expected = process.env.BRAIN_EXPECTED_MIGRATION || null
      migrations = { ...status, expected, up_to_date: expected ? status.last !== null && status.last >= expected : null }
    }
  } catch (err) {
    db = "ko"
    detail = err instanceof Error ? err.message.slice(0, 200) : String(err)
  }
  return Response.json(
    { ok: db === "ok", service: "company-brain", ...serverInfo(), store: store.kind, db, detail, migrations, stream: store.eventNotifyMode(), demo: process.env.BRAIN_DEMO === "1" },
    { status: db === "ok" ? 200 : 503 },
  )
}
