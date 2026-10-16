import { runAutomationDetection } from "@/lib/brain"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = withViewer(async () => json({ automations: await runAutomationDetection() }), { admin: true })
