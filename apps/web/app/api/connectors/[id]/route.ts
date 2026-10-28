import { z } from "zod"
import { isConnectorId } from "@brain/core"
import { removeConnector, updateConnector } from "@/lib/connectors"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Schema = z.object({
  token: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
  zone: z.string().max(64).nullable().optional(),
  enabled: z.boolean().optional(),
})

/** PUT /api/connectors/:id — configures a connector (token, URL, zone, active). An empty token keeps the old one. */
export const PUT = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const { id } = await params
    if (!isConnectorId(id)) return error(404, "Unknown connector.")
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    if (body.data.url !== undefined && body.data.url.trim() && !/^https?:\/\//i.test(body.data.url.trim())) return error(400, "The feed URL must start with http:// or https://.")
    if (body.data.zone) {
      const zones = await getStore().listZones()
      if (!zones.some((z) => z.id === body.data.zone)) return error(400, "Unknown zone.")
    }
    return json(await updateConnector(id, body.data))
  },
  { admin: true, demoReadOnly: true },
)

/** DELETE /api/connectors/:id — disconnects the tool (the token is erased; imported knowledge stays). */
export const DELETE = withViewer<Ctx>(
  async (_req, _viewer, { params }) => {
    const { id } = await params
    if (!isConnectorId(id)) return error(404, "Unknown connector.")
    await removeConnector(id)
    return json({ removed: true })
  },
  { admin: true, demoReadOnly: true },
)
