import { z } from "zod"
import { getStore } from "@/lib/store"
import { joinPromptFor } from "@/lib/join"
import { json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Admins: the company's team message and the pending requests. `?count=1`: the count only (sidebar). */
export const GET = withViewer(
  async (req) => {
    const store = getStore()
    const pending = await store.listJoinRequests({ status: "pending" })
    if (new URL(req.url).searchParams.get("count") === "1") return json({ pending: pending.length })
    return json({ ...(await joinPromptFor(store, publicBaseUrl(req))), requests: pending })
  },
  { admin: true },
)

const Schema = z.object({ rotate: z.literal(true) })

/** Admins: changes the code. The old message stops working; requests already made stay. */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    await store.rotateJoinCode()
    return json(await joinPromptFor(store, publicBaseUrl(req)))
  },
  { admin: true },
)
