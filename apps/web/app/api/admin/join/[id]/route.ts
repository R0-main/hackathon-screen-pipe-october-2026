import { z } from "zod"
import { getRootStore, getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    name: z.string().trim().min(1).max(80),
    title: z.string().trim().max(80).optional(),
    email: z.string().email().max(200).optional().or(z.literal("").transform(() => undefined)),
    role: z.enum(["admin", "member"]).default("member"),
    zones: z.array(z.string().max(64)).max(30).default([]),
    manager_id: z.string().max(64).nullable().optional(),
  }),
  z.object({ action: z.literal("reject") }),
])

/**
 * Admins : accepte une demande (le compte est créé avec ce que l'admin a vérifié ou complété, et l'empreinte du jeton
 * du poste, qui termine alors son installation tout seul) ou la refuse.
 */
export const POST = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const { id } = await params
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    const request = await store.getJoinRequest(id)
    if (!request) return error(404, "Demande introuvable.")
    if (request.status !== "pending") return error(409, request.status === "accepted" ? "Cette demande a déjà été acceptée." : "Cette demande a déjà été refusée.")

    if (body.data.action === "reject") return json(await store.decideJoinRequest(id, { status: "rejected" }))

    const d = body.data
    if (await getRootStore().findUserOrg({ tokenHash: request.token_hash })) return error(409, "Ce poste a déjà un compte.")
    if (d.manager_id && !(await store.getProfile(d.manager_id))) return error(400, "La personne de rattachement n'existe pas.")
    const known = new Set((await store.listZones()).map((z) => z.id))
    const profile = await store.createProfile({
      name: d.name,
      title: d.title || undefined,
      email: d.email,
      role: d.role,
      manager_id: d.manager_id ?? null,
      token_hash: request.token_hash,
    })
    await store.setZoneAccess(profile.id, d.zones.filter((z) => known.has(z)).map((zone_id) => ({ zone_id, can_write: true })))
    const decided = await store.decideJoinRequest(id, { status: "accepted", profile_id: profile.id })
    return json({ request: decided, profile })
  },
  { admin: true },
)
