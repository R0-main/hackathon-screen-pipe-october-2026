import { cookies } from "next/headers"
import { z } from "zod"
import { getStore } from "@/lib/store"
import { sessionCookieOptions, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ userId: z.string().max(64).nullable() })

/** Admin : voir le dashboard avec les droits d'un autre membre (démo des accès par zone). */
export const POST = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const jar = await cookies()
    if (!body.data.userId || body.data.userId === viewer.real.id) {
      jar.delete(VIEW_AS_COOKIE)
      return json({ ok: true, viewAs: null })
    }
    const target = await getStore().getProfile(body.data.userId)
    if (!target) return error(404, "Membre introuvable.")
    jar.set(VIEW_AS_COOKIE, target.id, sessionCookieOptions)
    return json({ ok: true, viewAs: target })
  },
  { admin: true },
)
