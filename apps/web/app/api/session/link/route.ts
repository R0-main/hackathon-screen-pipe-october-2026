import { NextResponse } from "next/server"
import { createLoginCode, LOGIN_LINK_SECONDS, profileFromToken, verifyLoginCode } from "@/lib/auth"
import { error, json } from "@/lib/http"
import { openSession } from "@/lib/session"

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

/**
 * Opens the session from the link, then the brain with the welcome banner. Expired link: sign-in page.
 * The company joins those remembered by this browser, next to the one that was open.
 */
export async function GET(req: Request) {
  const userId = await verifyLoginCode(new URL(req.url).searchParams.get("code"))
  if (!userId) return NextResponse.redirect(new URL("/login", req.url), 303)
  const res = NextResponse.redirect(new URL("/dashboard?welcome=1", req.url), 303)
  await openSession(userId, res)
  return res
}
