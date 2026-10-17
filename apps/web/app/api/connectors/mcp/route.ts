import { z } from "zod"
import { addCustom, addFromCatalog, listMcpConnectors, mcpRedirectUri, McpUserError } from "@/lib/remote-mcp"
import { error, json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET /api/connectors/mcp — the MCP servers added (without token or secret) and the OAuth redirect URI. Admins. */
export const GET = withViewer(async (req) => json({ connectors: await listMcpConnectors(), redirect_uri: mcpRedirectUri(publicBaseUrl(req)) }), { admin: true })

const Schema = z.union([
  z.object({ catalog_id: z.string().min(1).max(64) }),
  z.object({ name: z.string().max(80), url: z.string().min(1).max(2000), token: z.string().max(4000).optional() }),
])

/** POST /api/connectors/mcp — adds a catalog server, or any server (address, optional token). */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    try {
      return json("catalog_id" in body.data ? await addFromCatalog(body.data.catalog_id) : await addCustom(body.data), 201)
    } catch (err) {
      if (err instanceof McpUserError) return error(400, err.message)
      throw err
    }
  },
  { admin: true },
)
