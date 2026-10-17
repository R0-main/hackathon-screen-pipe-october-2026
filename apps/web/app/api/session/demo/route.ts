import { cookies } from "next/headers"
import { z } from "zod"
import { getStore } from "@/lib/store"
import { createSessionValue, isDemoMode, SESSION_COOKIE, sessionCookieOptions, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"
import { ensureDemoBrain } from "@/lib/demo-seed"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Demo mode only (BRAIN_DEMO=1): list of accounts for one-click sign-in. */
export async function GET() {
  if (!isDemoMode()) return error(404, "Demo mode is off.")
  try {
    // Fresh deployment: the database is empty, it is seeded with the demo's fictional company.
    await ensureDemoBrain()
    const profiles = await getStore().listProfiles()
    return json({ users: profiles.map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role })) })
  } catch (err) {
    return internalError(err)
  }
}

const Schema = z.object({ userId: z.string().max(64) })

export async function POST(req: Request) {
  if (!isDemoMode()) return error(404, "Demo mode is off.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const profile = await getStore().getProfile(body.data.userId)
    if (!profile) return error(404, "Member not found.")
    const session = await createSessionValue(profile.id)
    const jar = await cookies()
    jar.set(SESSION_COOKIE, session, sessionCookieOptions)
    jar.delete(VIEW_AS_COOKIE)
    return json({ ok: true, profile })
  } catch (err) {
    return internalError(err)
  }
}
