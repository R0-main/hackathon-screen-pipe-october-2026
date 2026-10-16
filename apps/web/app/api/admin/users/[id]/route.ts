import { z } from "zod"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Schema = z.object({
  name: z.string().min(1).max(80).optional(),
  title: z.string().max(80).optional(),
  role: z.enum(["admin", "member"]).optional(),
  zones: z.array(z.string().max(64)).max(30).optional(),
})

/** Met à jour le rôle et les zones visibles d'un membre. */
export const PATCH = withViewer<Ctx>(
  async (req, viewer, { params }) => {
    const { id } = await params
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    if (body.data.role === "member" && id === viewer.real.id) return error(400, "Vous ne pouvez pas retirer vos propres droits admin.")
    const profile = await store.updateProfile(id, { name: body.data.name, title: body.data.title, role: body.data.role })
    if (!profile) return error(404, "Membre introuvable.")
    if (body.data.zones) {
      const known = new Set((await store.listZones()).map((z) => z.id))
      await store.setZoneAccess(id, body.data.zones.filter((z) => known.has(z)).map((zone_id) => ({ zone_id, can_write: true })))
    }
    const zones = (await store.listZoneAccess(id)).map((a) => a.zone_id)
    return json({ ...profile, zones })
  },
  { admin: true },
)
