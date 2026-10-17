import { newZonesInput } from "@/lib/new-zones"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins: the material for a "new zones" run (zones, recent numbered knowledge), so that the company's Claude
 * Code does the analysis with its subscription (`brain refresh-zones`). `{skipped}` if there is nothing to do.
 */
export const GET = withViewer(async () => json(await newZonesInput()), { admin: true })
