import { z } from "zod"
import { getStore } from "@/lib/store"
import { hashToken, newToken } from "@/lib/auth"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(
  async () => {
    const store = getStore()
    const [profiles, access, zones] = await Promise.all([store.listProfiles(), store.listZoneAccess(), store.listZones()])
    return json({
      zones,
      users: profiles.map((p) => ({ ...p, zones: access.filter((a) => a.user_id === p.id).map((a) => a.zone_id) })),
    })
  },
  { admin: true },
)

const Schema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  title: z.string().max(80).optional(),
  role: z.enum(["admin", "member"]).default("member"),
  zones: z.array(z.string().max(64)).max(30).default([]),
  manager_id: z.string().max(64).nullable().optional(),
  can_publish_skills: z.boolean().default(false),
})

/** Invite un membre : crée son compte, ses accès, et renvoie son prompt d'installation (jeton affiché une seule fois). */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    if (body.data.manager_id && !(await store.getProfile(body.data.manager_id))) return error(400, "La personne de rattachement n'existe pas.")
    const known = new Set((await store.listZones()).map((z) => z.id))
    const zones = body.data.zones.filter((z) => known.has(z))
    const token = newToken()
    const profile = await store.createProfile({
      name: body.data.name,
      email: body.data.email,
      title: body.data.title,
      role: body.data.role,
      manager_id: body.data.manager_id ?? null,
      can_publish_skills: body.data.can_publish_skills,
      token_hash: hashToken(token),
    })
    await store.setZoneAccess(profile.id, zones.map((zone_id) => ({ zone_id, can_write: true })))
    const org = await store.getOrg()
    const prompt = buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, zones })
    return json({ profile, token, prompt }, 201)
  },
  { admin: true },
)
