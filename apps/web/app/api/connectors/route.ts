import { listConnectors } from "@/lib/connectors"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET /api/connectors — the connectors and their state (never the token). Admins. */
export const GET = withViewer(async () => json({ connectors: await listConnectors() }), { admin: true })
