import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import {
  ACCOUNTS_COOKIE,
  createSessionValue,
  listRememberedAccounts,
  rememberAccounts,
  SESSION_COOKIE,
  sessionCookieOptions,
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

/** Pour les pages : le spectateur courant, ou redirection vers /login. */
export async function requirePageViewer(opts: { admin?: boolean } = {}): Promise<Viewer> {
  const viewer = await getPageViewer()
  if (!viewer) redirect("/login")
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
 * Pour les routes API : ouvre la session du dashboard pour ce compte, et le retient en tête des entreprises de ce
 * navigateur (la session qu'il remplace, d'une autre entreprise, y reste : on peut y revenir en un clic).
 */
export async function openSession(userId: string): Promise<void> {
  const jar = await cookies()
  const session = await createSessionValue(userId)
  const accounts = await rememberAccounts(session, jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
  jar.set(SESSION_COOKIE, session, sessionCookieOptions)
  jar.set(ACCOUNTS_COOKIE, accounts, sessionCookieOptions)
  jar.delete(VIEW_AS_COOKIE)
}
