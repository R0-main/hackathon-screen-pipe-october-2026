import { cookies } from "next/headers"
import { z } from "zod"
import { accountsCookieOptions, ACCOUNTS_COOKIE, profileFromToken, rememberAccounts, SESSION_COOKIE, SIGNED_OUT_COOKIE, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"
import { openSession } from "@/lib/session"
import { isStoreSetupError } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ token: z.string().min(8).max(200) })

/** Connexion au dashboard avec son jeton personnel ; l'entreprise rejoint celles retenues par ce navigateur. */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const profile = await profileFromToken(body.data.token)
    if (!profile) return error(401, "Jeton invalide.")
    await openSession(profile.id)
    return json({ ok: true, profile })
  } catch (err) {
    // Migration manquante (table brain_settings) : 503 avec la marche à suivre, plutôt qu'une erreur 500 opaque.
    return internalError(err)
  }
}

/**
 * Déconnexion. L'entreprise reste retenue par ce navigateur : la page de connexion la propose en un clic
 * (« Oublier » la retire). La marque de déconnexion suspend la reconnexion automatique jusqu'à la prochaine ouverture.
 */
export async function DELETE() {
  const jar = await cookies()
  try {
    const accounts = await rememberAccounts(jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
    if (accounts) jar.set(ACCOUNTS_COOKIE, accounts, accountsCookieOptions)
    else jar.delete(ACCOUNTS_COOKIE)
  } catch (err) {
    // Stockage pas prêt (ou en panne) : la déconnexion passe quand même, sans retenir l'entreprise.
    if (!isStoreSetupError(err)) console.error("[session]", err)
  }
  jar.delete(SESSION_COOKIE)
  jar.delete(VIEW_AS_COOKIE)
  jar.set(SIGNED_OUT_COOKIE, "1", accountsCookieOptions)
  return json({ ok: true })
}
