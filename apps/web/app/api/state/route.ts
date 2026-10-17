import { getState } from "@/lib/brain"
import { runDueConnectors } from "@/lib/connectors"
import { json, withViewer } from "@/lib/http"
import { runDueMcpImports } from "@/lib/remote-mcp"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(async (_req, viewer) => {
  const state = await getState(viewer)
  // Les connecteurs dus (une fois par heure) tournent en arrière-plan, sans retarder la réponse ni la faire échouer.
  if (viewer.real.role === "admin") {
    void runInOrg(viewer.real.org_id, () => runDueConnectors(viewer)).catch((err) => console.error("[connectors]", err))
    // Imports des serveurs MCP (toutes les 6 heures, s'ils sont activés), de la même façon.
    void runInOrg(viewer.real.org_id, () => runDueMcpImports(viewer)).catch((err) => console.error("[mcp-import]", err))
  }
  return json(state)
})
