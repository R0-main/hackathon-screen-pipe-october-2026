import { agentConnectors } from "@/lib/remote-mcp"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/connected-tools?connector=&query= — les outils des connecteurs MCP que l'admin a ouverts aux agents, visibles
 * par ce membre (zone du connecteur lisible), avec leur schéma d'entrée. Utilisé par l'outil `connected_tools` du MCP.
 */
export const GET = withViewer(async (req, viewer) => {
  const q = new URL(req.url).searchParams
  const connector = q.get("connector")?.trim().toLowerCase()
  const needle = q.get("query")?.trim().toLowerCase()
  const list = (await agentConnectors(viewer))
    .filter((c) => !connector || c.id === connector || c.name.toLowerCase() === connector)
    .map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode,
      tools: c.tools.filter((t) => !needle || `${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase().includes(needle)),
    }))
  return json({ connectors: list })
})
