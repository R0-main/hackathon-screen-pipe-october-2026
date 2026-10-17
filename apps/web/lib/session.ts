import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import type { NextResponse } from "next/server"
import {
  accountsCookieOptions,
  ACCOUNTS_COOKIE,
  createSessionValue,
  listRememberedAccounts,
  rememberAccounts,
  SESSION_COOKIE,
  sessionCookieOptions,
  SIGNED_OUT_COOKIE,
  VIEW_AS_COOKIE,
  viewerFromCookies,
  type RememberedAccount,
  type Viewer,
} from "./auth"
import { isStoreSetupError } from "./store"

/** Pour les pages : le spectateur courant, ou null si personne n'est connecté. */
export async function getPageViewer(): Promise<Viewer | null> {
  const jar = await cookies()
  return viewerFromCookies(jar.get(SESSION_COOKIE)?.value, jar.get(VIEW_AS_COOKIE)?.value)
}

/**
 * Vrai si ce navigateur retient une entreprise et qu'on ne s'est pas déconnecté : une session expirée se rouvre alors
 * toute seule (/reprise), sans jeton.
 */
export async function canResume(): Promise<boolean> {
  const jar = await cookies()
  return Boolean(jar.get(ACCOUNTS_COOKIE)?.value) && !jar.get(SIGNED_OUT_COOKIE)
}

/** Pour les pages : le spectateur courant ; sinon reconnexion à l'entreprise retenue, à défaut la page de connexion. */
export async function requirePageViewer(opts: { admin?: boolean } = {}): Promise<Viewer> {
  const viewer = await getPageViewer()
  if (!viewer) redirect((await canResume()) ? "/reprise" : "/login")
  if (opts.admin && viewer.real.role !== "admin") redirect("/dashboard")
  return viewer
}

/** Pour les pages : les entreprises retenues par ce navigateur (vide si le stockage n'est pas prêt). */
export async function getRememberedAccounts(): Promise<RememberedAccount[]> {
  const value = (await cookies()).get(ACCOUNTS_COOKIE)?.value
  if (!value) return []
  try {
    return await listRememberedAccounts(value)
  } catch (err) {
    if (!isStoreSetupError(err)) throw err
    return []
  }
}

/**
 * Ouvre la session du dashboard pour ce compte et le retient en tête des entreprises de ce navigateur (la session qu'il
 * remplace, d'une autre entreprise, y reste : on peut y revenir en un clic). Lève la marque de déconnexion.
 * `res` : réponse de redirection qui porte les cookies ; sans elle (routes JSON), le magasin de cookies de la requête.
 */
export async function openSession(userId: string, res?: NextResponse): Promise<void> {
  const jar = await cookies()
  const session = await createSessionValue(userId)
  const accounts = await rememberAccounts(session, jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
  const out = res?.cookies ?? jar
  out.set(SESSION_COOKIE, session, sessionCookieOptions)
  out.set(ACCOUNTS_COOKIE, accounts, accountsCookieOptions)
  out.delete(VIEW_AS_COOKIE)
  out.delete(SIGNED_OUT_COOKIE)
}
