import { cookies } from "next/headers"
import { z } from "zod"
import { createSessionValue, profileFromToken, SESSION_COOKIE, sessionCookieOptions, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ token: z.string().min(8).max(200) })

/** Sign in to the dashboard with one's personal token. */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const profile = await profileFromToken(body.data.token)
    if (!profile) return error(401, "Invalid token.")
    const session = await createSessionValue(profile.id)
    const jar = await cookies()
    jar.set(SESSION_COOKIE, session, sessionCookieOptions)
    jar.delete(VIEW_AS_COOKIE)
    return json({ ok: true, profile })
  } catch (err) {
    // Missing migration (brain_settings table): 503 with the steps to follow, rather than an opaque 500 error.
    return internalError(err)
  }
}

export async function DELETE() {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  jar.delete(VIEW_AS_COOKIE)
  return json({ ok: true })
}
