import { getRootStore } from "@/lib/store"
import { serverInfo } from "@/lib/monitoring"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/health — probe for an external monitor (Uptime Kuma, Better Stack, cron…). 200 if storage answers,
 * 503 otherwise; no company data. `stream`: how the real-time stream is notified (local, notify, poll).
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
