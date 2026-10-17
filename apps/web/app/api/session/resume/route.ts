import { cookies } from "next/headers"
import { accountsCookieOptions, ACCOUNTS_COOKIE, latestRemembered, SIGNED_OUT_COOKIE } from "@/lib/auth"
import { error, internalError, json } from "@/lib/http"
import { openSession } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Expired session (or closed with the browser): reopens the most recently remembered company, without a token (called
 * by the /resume page). Nothing valid to reopen, or deliberate sign-out: 404, and the pages go straight to sign-in.
 */
export async function POST() {
  try {
    const jar = await cookies()
    const userId = jar.get(SIGNED_OUT_COOKIE) ? null : await latestRemembered(jar.get(ACCOUNTS_COOKIE)?.value)
    if (!userId) {
      jar.set(SIGNED_OUT_COOKIE, "1", accountsCookieOptions)
      return error(404, "No company to reopen on this browser: sign in with your token.")
    }
    await openSession(userId)
    return json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
