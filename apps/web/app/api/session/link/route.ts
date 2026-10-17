import { NextResponse } from "next/server"
import { createLoginCode, LOGIN_LINK_SECONDS, profileFromToken, verifyLoginCode } from "@/lib/auth"
import { error, json } from "@/lib/http"
import { openSession } from "@/lib/session"

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
  const res = NextResponse.redirect(new URL("/dashboard?bienvenue=1", req.url), 303)
  await openSession(userId, res)
  return res
}
