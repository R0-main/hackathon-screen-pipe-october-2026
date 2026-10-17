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
  /** SHA-256 fingerprint of the token generated on the workstation: the token itself never leaves the workstation. */
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * Public: `brain join` (run by the team message) asks to join the code's company. The request waits
 * for an admin to accept it; the workstation follows its state with POST /api/join/status.
 */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const root = getRootStore()
    const orgId = await root.findOrgByJoinCode(body.data.code)
    if (!orgId) return error(404, "Invalid or replaced team code: ask a company admin for the new message.")
    if (await root.findUserOrg({ tokenHash: body.data.token_hash })) return error(409, "This workstation already has an account.")
    const store = storeForOrg(orgId)
    if ((await store.listJoinRequests({ status: "pending", limit: MAX_PENDING_JOINS })).length >= MAX_PENDING_JOINS)
      return error(429, "Too many pending requests for this company: an admin must handle the previous ones first.")
    const { code: _code, ...fields } = body.data
    const request = await store.createJoinRequest(fields)
    const org = await store.getOrg()
    return json({ id: request.id, status: request.status, org: org.name }, 201)
  } catch (err) {
    return internalError(err)
  }
}
