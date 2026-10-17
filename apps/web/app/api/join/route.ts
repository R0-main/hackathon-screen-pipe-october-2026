import { z } from "zod"
import { getRootStore, storeForOrg } from "@/lib/store"
import { JOIN_CODE_RE } from "@/lib/store/codes"
import { MAX_PENDING_JOINS, prefilled, prefilledEmail } from "@/lib/join"
import { error, internalError, json, parseBody } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({
  code: z.string().regex(JOIN_CODE_RE),
  name: prefilled(80),
  title: prefilled(80),
  email: prefilledEmail,
  hostname: prefilled(80),
  /** Empreinte SHA-256 du jeton généré sur le poste : le jeton lui-même ne quitte jamais le poste. */
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * Public : `brain join` (lancé par le message d'équipe) demande à rejoindre l'entreprise du code. La demande attend
 * qu'un admin l'accepte ; le poste suit son état avec POST /api/join/status.
 */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const root = getRootStore()
    const orgId = await root.findOrgByJoinCode(body.data.code)
    if (!orgId) return error(404, "Code d'équipe invalide ou remplacé : demandez le nouveau message à un admin de l'entreprise.")
    if (await root.findUserOrg({ tokenHash: body.data.token_hash })) return error(409, "Ce poste a déjà un compte.")
    const store = storeForOrg(orgId)
    if ((await store.listJoinRequests({ status: "pending", limit: MAX_PENDING_JOINS })).length >= MAX_PENDING_JOINS)
      return error(429, "Trop de demandes en attente pour cette entreprise : un admin doit d'abord traiter les précédentes.")
    const { code: _code, ...fields } = body.data
    const request = await store.createJoinRequest(fields)
    const org = await store.getOrg()
    return json({ id: request.id, status: request.status, org: org.name }, 201)
  } catch (err) {
    return internalError(err)
  }
}
