import { NextResponse } from "next/server"
import {
  createLoginCode,
  createSessionValue,
  LOGIN_LINK_SECONDS,
  profileFromToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  VIEW_AS_COOKIE,
  verifyLoginCode,
} from "@/lib/auth"
import { error, json } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The workstation client (Bearer token) asks for a sign-in link; `brain.mjs setup` opens it in the browser. */
export async function POST(req: Request) {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const profile = bearer ? await profileFromToken(bearer) : null
  if (!profile) return error(401, "Not authenticated: missing or invalid token.")
  const code = await createLoginCode(profile.id)
  return json({ path: `/api/session/link?code=${encodeURIComponent(code)}`, expires_in: LOGIN_LINK_SECONDS })
}

/** Opens the session from the link, then the brain with the welcome banner. Expired link: sign-in page. */
export async function GET(req: Request) {
  const userId = await verifyLoginCode(new URL(req.url).searchParams.get("code"))
  if (!userId) return NextResponse.redirect(new URL("/login", req.url), 303)
  const res = NextResponse.redirect(new URL("/dashboard?welcome=1", req.url), 303)
  res.cookies.set(SESSION_COOKIE, await createSessionValue(userId), sessionCookieOptions)
  res.cookies.delete(VIEW_AS_COOKIE)
  return res
}
