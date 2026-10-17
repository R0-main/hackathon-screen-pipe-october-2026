import { cookies } from "next/headers"
import { z } from "zod"
import { accountsCookieOptions, ACCOUNTS_COOKIE, profileFromToken, rememberAccounts, SESSION_COOKIE, SIGNED_OUT_COOKIE, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"
import { openSession } from "@/lib/session"
import { isStoreSetupError } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ token: z.string().min(8).max(200) })

/** Sign in to the dashboard with one's personal token; the company joins those remembered by this browser. */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const profile = await profileFromToken(body.data.token)
    if (!profile) return error(401, "Invalid token.")
    await openSession(profile.id)
    return json({ ok: true, profile })
  } catch (err) {
    // Missing migration (brain_settings table): 503 with the steps to follow, rather than an opaque 500 error.
    return internalError(err)
  }
}

/**
 * Sign-out. The company stays remembered by this browser: the sign-in page offers it in one click ("Forget" removes
 * it). The signed-out mark suspends automatic sign-in until the next time a company is opened.
 */
export async function DELETE() {
  const jar = await cookies()
  try {
    const accounts = await rememberAccounts(jar.get(SESSION_COOKIE)?.value, jar.get(ACCOUNTS_COOKIE)?.value)
    if (accounts) jar.set(ACCOUNTS_COOKIE, accounts, accountsCookieOptions)
    else jar.delete(ACCOUNTS_COOKIE)
  } catch (err) {
    // Storage not ready (or down): sign-out still goes through, without remembering the company.
    if (!isStoreSetupError(err)) console.error("[session]", err)
  }
  jar.delete(SESSION_COOKIE)
  jar.delete(VIEW_AS_COOKIE)
  jar.set(SIGNED_OUT_COOKIE, "1", accountsCookieOptions)
  return json({ ok: true })
}
