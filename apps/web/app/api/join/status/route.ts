import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { hashToken } from "@/lib/auth"
import { getRootStore, storeForOrg } from "@/lib/store"
import { error, internalError, json, parseBody } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ id: z.string().max(64), token: z.string().min(8).max(200) })

/** Public: the state of a request. Only the workstation that made it (it holds the token) can know. */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const orgId = await getRootStore().findJoinRequestOrg(body.data.id)
    const store = orgId ? storeForOrg(orgId) : null
    const request = store ? await store.getJoinRequest(body.data.id) : null
    const a = Buffer.from(hashToken(body.data.token))
    const b = Buffer.from(request?.token_hash ?? "")
    if (!store || !request || a.length !== b.length || !timingSafeEqual(a, b)) return error(404, "Request not found.")
    return json({ status: request.status, org: (await store.getOrg()).name })
  } catch (err) {
    return internalError(err)
  }
}
