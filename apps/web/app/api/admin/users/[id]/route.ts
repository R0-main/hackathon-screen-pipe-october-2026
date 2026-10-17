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

/** Does attaching `id` to `managerId` loop the org chart (managerId is `id` or one of its reports)? */
function makesCycle(id: string, managerId: string, profiles: Profile[]): boolean {
  const managerOf = new Map(profiles.map((p) => [p.id, p.manager_id ?? null]))
  const seen = new Set<string>()
  for (let cur: string | null = managerId; cur && !seen.has(cur); cur = managerOf.get(cur) ?? null) {
    if (cur === id) return true
    seen.add(cur)
  }
  return false
}

/** Updates a member's role, manager, visible zones and right to publish skills. */
export const PATCH = withViewer<Ctx>(
  async (req, viewer, { params }) => {
    const { id } = await params
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    if (body.data.role === "member" && id === viewer.real.id) return error(400, "You cannot remove your own admin rights.")
    const managerId = body.data.manager_id
    if (managerId) {
      const profiles = await store.listProfiles()
      if (!profiles.some((p) => p.id === managerId)) return error(400, "The manager does not exist.")
      if (makesCycle(id, managerId, profiles)) return error(400, "Cannot attach: this person is part of their team.")
    }
    const profile = await store.updateProfile(id, {
      name: body.data.name,
      title: body.data.title,
      role: body.data.role,
      manager_id: managerId,
      can_publish_skills: body.data.can_publish_skills,
    })
    if (!profile) return error(404, "Member not found.")
    if (body.data.zones) {
      const known = new Set((await store.listZones()).map((z) => z.id))
      await store.setZoneAccess(id, body.data.zones.filter((z) => known.has(z)).map((zone_id) => ({ zone_id, can_write: true })))
    }
    const zones = (await store.listZoneAccess(id)).map((a) => a.zone_id)
    return json({ ...profile, zones })
  },
  { admin: true },
)
