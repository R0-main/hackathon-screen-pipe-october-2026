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

/** PUT /api/connectors/:id — règle un connecteur (jeton, adresse, zone, actif). Un jeton vide garde l'ancien. */
export const PUT = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const { id } = await params
    if (!isConnectorId(id)) return error(404, "Connecteur inconnu.")
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    if (body.data.url !== undefined && body.data.url.trim() && !/^https?:\/\//i.test(body.data.url.trim())) return error(400, "L'adresse du flux doit commencer par http:// ou https://.")
    if (body.data.zone) {
      const zones = await getStore().listZones()
      if (!zones.some((z) => z.id === body.data.zone)) return error(400, "Zone inconnue.")
    }
    return json(await updateConnector(id, body.data))
  },
  { admin: true },
)

/** DELETE /api/connectors/:id — débranche l'outil (le jeton est effacé ; les connaissances importées restent). */
export const DELETE = withViewer<Ctx>(
  async (_req, _viewer, { params }) => {
    const { id } = await params
    if (!isConnectorId(id)) return error(404, "Connecteur inconnu.")
    await removeConnector(id)
    return json({ removed: true })
  },
  { admin: true },
)
