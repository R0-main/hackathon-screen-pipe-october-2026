import { getRootStore } from "@/lib/store"
import { serverInfo } from "@/lib/monitoring"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/health — sonde pour un superviseur externe (Uptime Kuma, Better Stack, cron…). 200 si le stockage répond,
 * 503 sinon ; aucune donnée d'entreprise. `stream` : comment le flux temps réel est prévenu (local, notify, poll).
 */
export async function GET() {
  const store = getRootStore()
  let db: "ok" | "ko" = "ok"
  let detail: string | undefined
  try {
    await store.getOrg()
  } catch (err) {
    db = "ko"
    detail = err instanceof Error ? err.message.slice(0, 200) : String(err)
  }
  return Response.json(
    { ok: db === "ok", service: "company-brain", ...serverInfo(), store: store.kind, db, detail, stream: store.eventNotifyMode(), demo: process.env.BRAIN_DEMO === "1" },
    { status: db === "ok" ? 200 : 503 },
  )
}
