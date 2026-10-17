import { z } from "zod"
import { getStore } from "@/lib/store"
import { joinPromptFor } from "@/lib/join"
import { json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Admins : le message d'équipe de l'entreprise et les demandes en attente. `?count=1` : le nombre seulement (barre latérale). */
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

/** Admins : change le code. L'ancien message cesse de marcher ; les demandes déjà faites restent. */
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
