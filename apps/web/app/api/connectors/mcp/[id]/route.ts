import { z } from "zod"
import { MCP_AGENTS_MODES } from "@brain/core"
import { McpUserError, removeMcp, updateMcp } from "@/lib/remote-mcp"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Schema = z.object({
  client_id: z.string().max(500).optional(),
  client_secret: z.string().max(2000).optional(),
  token: z.string().max(4000).optional(),
  enabled: z.boolean().optional(),
  agents: z.enum(MCP_AGENTS_MODES as [string, ...string[]]).optional(),
  zone: z.string().max(64).nullable().optional(),
  import_enabled: z.boolean().optional(),
})

/**
 * PUT /api/connectors/mcp/:id — OAuth client declared by hand, personal token, pause, tools open to agents (off, read,
 * all), zone, automatic import. Adds the server if needed.
 */
export const PUT = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const { id } = await params
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    if (body.data.zone && !(await getStore().listZones()).some((z) => z.id === body.data.zone)) return error(400, "Zone inconnue.")
    try {
      return json(await updateMcp(id, body.data as Parameters<typeof updateMcp>[1]))
    } catch (err) {
      if (err instanceof McpUserError) return error(400, err.message)
      throw err
    }
  },
  { admin: true },
)

/** DELETE /api/connectors/mcp/:id — removes the server and forgets its tokens. */
export const DELETE = withViewer<Ctx>(
  async (_req, _viewer, { params }) => {
    const { id } = await params
    await removeMcp(id)
    return json({ removed: true })
  },
  { admin: true },
)
