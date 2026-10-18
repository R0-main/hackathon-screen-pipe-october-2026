import { agentConnectors } from "@/lib/remote-mcp"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/connected-tools?connector=&query= — the MCP connector tools the admin opened to agents, visible to this member
 * (allowed to every cortex, or to one they read), with their input schema. Used by the MCP's `connected_tools` tool.
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
