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

/** For pages: the current viewer, or null if nobody is signed in. */
export async function getPageViewer(): Promise<Viewer | null> {
  const jar = await cookies()
  return viewerFromCookies(jar.get(SESSION_COOKIE)?.value, jar.get(VIEW_AS_COOKIE)?.value)
}

/**
 * True if this browser remembers a company and the user has not signed out: an expired session then reopens on its
 * own (/resume), without a token.
 */
export async function canResume(): Promise<boolean> {
  const jar = await cookies()
  return Boolean(jar.get(ACCOUNTS_COOKIE)?.value) && !jar.get(SIGNED_OUT_COOKIE)
}

/** For pages: the current viewer; otherwise sign back in to the remembered company, failing that the sign-in page. */
export async function requirePageViewer(opts: { admin?: boolean } = {}): Promise<Viewer> {
  const viewer = await getPageViewer()
  if (!viewer) redirect((await canResume()) ? "/resume" : "/login")
  if (opts.admin && viewer.real.role !== "admin") redirect("/dashboard")
  return viewer
}

/** For pages: the companies remembered by this browser (empty if the storage is not ready). */
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
 * Opens the dashboard session for this account and remembers it at the top of this browser's companies (the session it
 * replaces, of another company, stays there: you can go back to it in one click). Clears the signed-out mark.
 * `res`: redirect response that carries the cookies; without it (JSON routes), the request's cookie store.
 */
export async function openSession(userId: string, res?: NextResponse): Promise<void> {
  // The session first: database not migrated (secret not found) → clear configuration error, before touching cookies.
  const session = await createSessionValue(userId)
  const jar = await cookies()
  const accounts = await rememberAccounts(session, jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
  const out = res?.cookies ?? jar
  out.set(SESSION_COOKIE, session, sessionCookieOptions)
  out.set(ACCOUNTS_COOKIE, accounts, accountsCookieOptions)
  out.delete(VIEW_AS_COOKIE)
  out.delete(SIGNED_OUT_COOKIE)
}
