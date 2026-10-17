import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  ACCOUNTS_COOKIE,
  createLoginCode,
  createSessionValue,
  LOGIN_LINK_SECONDS,
  profileFromToken,
  rememberAccounts,
  SESSION_COOKIE,
  sessionCookieOptions,
  VIEW_AS_COOKIE,
  verifyLoginCode,
} from "@/lib/auth"
import { error, json } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Le client du poste (jeton Bearer) demande un lien de connexion ; `brain.mjs setup` l'ouvre dans le navigateur. */
export async function POST(req: Request) {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const profile = bearer ? await profileFromToken(bearer) : null
  if (!profile) return error(401, "Non authentifié : jeton manquant ou invalide.")
  const code = await createLoginCode(profile.id)
  return json({ path: `/api/session/link?code=${encodeURIComponent(code)}`, expires_in: LOGIN_LINK_SECONDS })
}

/**
 * Ouvre la session à partir du lien, puis le cerveau avec le bandeau de bienvenue. Lien expiré : page de connexion.
 * L'entreprise rejoint celles retenues par ce navigateur, à côté de celle qui était ouverte.
 */
export async function GET(req: Request) {
  const userId = await verifyLoginCode(new URL(req.url).searchParams.get("code"))
  if (!userId) return NextResponse.redirect(new URL("/login", req.url), 303)
  const jar = await cookies()
  const session = await createSessionValue(userId)
  const accounts = await rememberAccounts(session, jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
  const res = NextResponse.redirect(new URL("/dashboard?bienvenue=1", req.url), 303)
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions)
  res.cookies.set(ACCOUNTS_COOKIE, accounts, sessionCookieOptions)
  res.cookies.delete(VIEW_AS_COOKIE)
  return res
}
