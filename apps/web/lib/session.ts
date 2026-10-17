import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SESSION_COOKIE, VIEW_AS_COOKIE, viewerFromCookies, type Viewer } from "./auth"

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
