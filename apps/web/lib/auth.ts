// Authentification :
// - agents (brain-sync, MCP, hooks) : jeton personnel en en-tête `Authorization: Bearer cb_…` ;
// - dashboard : cookie de session signé (HMAC), obtenu en se connectant avec son jeton.
// Un admin peut « voir en tant que » un autre membre pour montrer les accès par zone.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Profile } from "@brain/core"
import { getStore } from "./store"
import { getAccess, type Access } from "./access"

export const SESSION_COOKIE = "brain_session"
export const VIEW_AS_COOKIE = "brain_view_as"
const SESSION_DAYS = 14

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function newToken(): string {
  return `cb_${randomBytes(24).toString("base64url")}`
}

function sessionSecret(): string {
  return (
    process.env.BRAIN_SESSION_SECRET ||
    createHash("sha256")
      .update(`company-brain:${process.env.DATABASE_URL ?? ""}:${process.env.BRAIN_DATA_DIR ?? ".brain"}:${process.cwd()}`)
      .digest("hex")
  )
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url")
}

export function createSessionValue(userId: string): string {
  const exp = Date.now() + SESSION_DAYS * 86400_000
  const payload = `${userId}.${exp}`
  return `${payload}.${sign(payload)}`
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_DAYS * 86400,
}

function verifySession(value: string | undefined): string | null {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null
  const [userId, exp, sig] = parts
  const expected = sign(`${userId}.${exp}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (Number(exp) < Date.now()) return null
  return userId
}

export type Viewer = {
  /** Profil effectif (celui dont on applique les droits). */
  profile: Profile
  /** Profil réellement connecté (différent si un admin « voit en tant que »). */
  real: Profile
  access: Access
}

async function buildViewer(real: Profile | null, viewAs?: string): Promise<Viewer | null> {
  if (!real) return null
  let profile = real
  if (viewAs && real.role === "admin" && viewAs !== real.id) profile = (await getStore().getProfile(viewAs)) ?? real
  return { profile, real, access: await getAccess(profile) }
}

export async function profileFromToken(token: string): Promise<Profile | null> {
  return getStore().getProfileByTokenHash(hashToken(token.trim()))
}

/** Pour les pages (server components) : à partir des valeurs de cookies. */
export async function viewerFromCookies(session: string | undefined, viewAs: string | undefined): Promise<Viewer | null> {
  const userId = verifySession(session)
  if (!userId) return null
  return buildViewer(await getStore().getProfile(userId), viewAs)
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return undefined
}

/** Pour les routes API : jeton Bearer (agents) ou cookie de session (dashboard). */
export async function viewerFromRequest(req: Request): Promise<Viewer | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return buildViewer(await profileFromToken(bearer))
  const cookie = req.headers.get("cookie")
  return viewerFromCookies(readCookie(cookie, SESSION_COOKIE), readCookie(cookie, VIEW_AS_COOKIE))
}

/** Mode démo : connexion en un clic sur /login. À n'activer qu'avec des données fictives. */
export function isDemoMode(): boolean {
  return process.env.BRAIN_DEMO === "1" || process.env.BRAIN_DEMO === "true"
}
