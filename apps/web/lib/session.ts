import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SESSION_COOKIE, VIEW_AS_COOKIE, viewerFromCookies, type Viewer } from "./auth"

/** Pour les pages : le spectateur courant, ou redirection vers /login. */
export async function requirePageViewer(opts: { admin?: boolean } = {}): Promise<Viewer> {
  const jar = await cookies()
  const viewer = await viewerFromCookies(jar.get(SESSION_COOKIE)?.value, jar.get(VIEW_AS_COOKIE)?.value)
  if (!viewer) redirect("/login")
  if (opts.admin && viewer.real.role !== "admin") redirect("/")
  return viewer
}
