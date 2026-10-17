import { cookies } from "next/headers"
import { z } from "zod"
import { ACCOUNTS_COOKIE, forgetAccount, isRemembered, SESSION_COOKIE, sessionCookieOptions, sessionUserId, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"
import { openSession } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ userId: z.string().max(64) })

/** Passe sur une entreprise retenue par ce navigateur, sans ressaisir son jeton. */
export async function POST(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const jar = await cookies()
    if (!(await isRemembered(jar.get(ACCOUNTS_COOKIE)?.value, body.data.userId))) {
      return error(404, "Cette entreprise n'est plus retenue sur ce navigateur : reconnectez-vous avec votre jeton.")
    }
    await openSession(body.data.userId)
    return json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}

/** Oublie une entreprise sur ce navigateur ; si c'est celle de la session ouverte, la session est fermée. */
export async function DELETE(req: Request) {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const jar = await cookies()
    const accounts = await forgetAccount(jar.get(ACCOUNTS_COOKIE)?.value, body.data.userId)
    if (accounts) jar.set(ACCOUNTS_COOKIE, accounts, sessionCookieOptions)
    else jar.delete(ACCOUNTS_COOKIE)
    const signedOut = (await sessionUserId(jar.get(SESSION_COOKIE)?.value)) === body.data.userId
    if (signedOut) {
      jar.delete(SESSION_COOKIE)
      jar.delete(VIEW_AS_COOKIE)
    }
    return json({ ok: true, signedOut })
  } catch (err) {
    return internalError(err)
  }
}
