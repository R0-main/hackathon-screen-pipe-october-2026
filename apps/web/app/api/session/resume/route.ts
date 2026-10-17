import { cookies } from "next/headers"
import { accountsCookieOptions, ACCOUNTS_COOKIE, latestRemembered, SIGNED_OUT_COOKIE } from "@/lib/auth"
import { error, internalError, json } from "@/lib/http"
import { openSession } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Session expirée (ou fermée avec le navigateur) : rouvre l'entreprise retenue la plus récente, sans jeton (appelé par
 * la page /reprise). Rien de valable à rouvrir, ou déconnexion volontaire : 404, et les pages vont droit à la connexion.
 */
export async function POST() {
  try {
    const jar = await cookies()
    const userId = jar.get(SIGNED_OUT_COOKIE) ? null : await latestRemembered(jar.get(ACCOUNTS_COOKIE)?.value)
    if (!userId) {
      jar.set(SIGNED_OUT_COOKIE, "1", accountsCookieOptions)
      return error(404, "Aucune entreprise à rouvrir sur ce navigateur : connectez-vous avec votre jeton.")
    }
    await openSession(userId)
    return json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
