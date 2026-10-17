import { listConnectors } from "@/lib/connectors"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET /api/connectors — les connecteurs et leur état (jamais le jeton). Admins. */
export const GET = withViewer(async () => json({ connectors: await listConnectors() }), { admin: true })
