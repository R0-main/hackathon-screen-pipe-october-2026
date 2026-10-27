import { after } from "next/server"
import { isDemoMode } from "@/lib/auth"
import { getState } from "@/lib/brain"
import { runDueConnectors } from "@/lib/connectors"
import { demoPulse } from "@/lib/demo-live"
import { json, withViewer } from "@/lib/http"
import { runDueMcpImports } from "@/lib/remote-mcp"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(async (_req, viewer) => {
  const state = await getState(viewer)
  // Due connectors (once an hour) run in the background, without delaying the response or making it fail.
  if (viewer.real.role === "admin") {
    void runInOrg(viewer.real.org_id, () => runDueConnectors(viewer)).catch((err) => console.error("[connectors]", err))
    // MCP server imports (every 6 hours, when enabled), the same way.
    void runInOrg(viewer.real.org_id, () => runDueMcpImports(viewer)).catch((err) => console.error("[mcp-import]", err))
  }
  // Live demo: the team keeps working while someone watches (the dashboard re-reads this route every 45 s).
  if (isDemoMode()) inBackground(() => runInOrg(viewer.real.org_id, () => demoPulse()).then(() => undefined))
  return json(state)
})

/** After the response (Vercel keeps the function alive for it); outside a Next request (scripts, tests), right away. */
function inBackground(task: () => Promise<void>) {
  const run = () => task().catch((err) => console.error("[demo]", err instanceof Error ? err.message : err))
  try {
    after(run)
  } catch {
    void run()
  }
}
