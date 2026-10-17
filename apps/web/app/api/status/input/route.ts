import { getStatusInput } from "@/lib/brain"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins: the material for the "where the company stands" summary (zones, knowledge from the last 30 days, tasks), to
 * generate it on a workstation with Claude (`brain refresh-status`, through the employee's subscription) then send it back with POST /api/status.
 */
export const GET = withViewer(async () => json(await getStatusInput()), { admin: true })
