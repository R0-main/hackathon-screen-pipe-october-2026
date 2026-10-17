import { getRootStore } from "@/lib/store"
import { serverInfo } from "@/lib/monitoring"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/health — probe for an external monitor (Uptime Kuma, Better Stack, cron…). 200 if storage answers,
 * 503 otherwise; no company data. `stream`: how the real-time stream is notified (local, notify, poll).
 * `migrations` (Postgres): last migration applied in the database, last one shipped with this code, and whether the
 * database is up to date; a lagging database does not fail the probe (the brain works in degraded mode), it reports it.
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
