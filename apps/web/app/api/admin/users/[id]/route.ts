import { z } from "zod"
import type { Profile } from "@brain/core"
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
  manager_id: z.string().max(64).nullable().optional(),
  can_publish_skills: z.boolean().optional(),
})

/** Rattacher `id` à `managerId` boucle-t-il l'organigramme (managerId est `id` ou l'un de ses subordonnés) ? */
function makesCycle(id: string, managerId: string, profiles: Profile[]): boolean {
  const managerOf = new Map(profiles.map((p) => [p.id, p.manager_id ?? null]))
  const seen = new Set<string>()
  for (let cur: string | null = managerId; cur && !seen.has(cur); cur = managerOf.get(cur) ?? null) {
    if (cur === id) return true
    seen.add(cur)
  }
  return false
}

/** Met à jour le rôle, le rattachement, les zones visibles et le droit de publier des skills d'un membre. */
export const PATCH = withViewer<Ctx>(
  async (req, viewer, { params }) => {
    const { id } = await params
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    if (body.data.role === "member" && id === viewer.real.id) return error(400, "Vous ne pouvez pas retirer vos propres droits admin.")
    const managerId = body.data.manager_id
    if (managerId) {
      const profiles = await store.listProfiles()
      if (!profiles.some((p) => p.id === managerId)) return error(400, "La personne de rattachement n'existe pas.")
      if (makesCycle(id, managerId, profiles)) return error(400, "Rattachement impossible : cette personne fait partie de son équipe.")
    }
    const profile = await store.updateProfile(id, {
      name: body.data.name,
      title: body.data.title,
      role: body.data.role,
      manager_id: managerId,
      can_publish_skills: body.data.can_publish_skills,
    })
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
