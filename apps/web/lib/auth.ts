// Authentification :
// - agents (brain-sync, MCP, hooks) : jeton personnel en en-tête `Authorization: Bearer cb_…` ;
// - dashboard : cookie de session signé (HMAC), obtenu en se connectant avec son jeton.
// Un admin peut « voir en tant que » un autre membre pour montrer les accès par zone.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Profile } from "@brain/core"
import { getStore, isStoreSetupError } from "./store"
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

// Secret HMAC des sessions : BRAIN_SESSION_SECRET s'il est défini, sinon un secret aléatoire de 32 octets généré
// une seule fois et conservé par le stockage (<dataDir>/session-secret en mode 600, ou table brain_settings).
// Jamais dérivé de valeurs devinables (URL de base, dossier, cwd…).
let warnedShortSecret = false
async function sessionSecret(): Promise<string> {
  const env = process.env.BRAIN_SESSION_SECRET?.trim()
  if (env) {
    if (env.length < 32 && !warnedShortSecret) {
      warnedShortSecret = true
      console.warn("[auth] BRAIN_SESSION_SECRET est court (< 32 caractères) : utilisez une valeur aléatoire plus longue.")
    }
    return env
  }
  return getStore().getSessionSecret()
}

/**
 * Charge signée : usage, membre, expiration et début de l'empreinte de son jeton (régénérer le jeton invalide les
 * sessions). L'usage sépare les cookies de session (« v2 ») des liens de connexion (« link1 ») : l'un ne vaut pas l'autre.
 */
async function sign(userId: string, exp: string, tokenHash: string, purpose = "v2"): Promise<string> {
  return createHmac("sha256", await sessionSecret()).update(`${purpose}.${userId}.${exp}.${tokenHash.slice(0, 16)}`).digest("base64url")
}

/** Durée de validité d'un lien de connexion ouvert par `brain.mjs setup`. */
export const LOGIN_LINK_SECONDS = 120

export async function createSessionValue(userId: string): Promise<string> {
  const tokenHash = await getStore().getTokenHash(userId)
  if (!tokenHash) throw new Error("Membre introuvable.")
  const exp = String(Date.now() + SESSION_DAYS * 86400_000)
  return `${userId}.${exp}.${await sign(userId, exp, tokenHash)}`
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_DAYS * 86400,
}

let warnedSetup = false

async function verifySigned(value: string | undefined, purpose: string): Promise<string | null> {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null
  const [userId, exp, sig] = parts
  if (!/^\d{10,16}$/.test(exp) || Number(exp) < Date.now()) return null
  const tokenHash = await getStore().getTokenHash(userId)
  if (!tokenHash) return null
  let expected: string
  try {
    expected = await sign(userId, exp, tokenHash, purpose)
  } catch (err) {
    // Secret introuvable (migration non appliquée) : session invérifiable, donc refusée (401 / page de connexion).
    if (!isStoreSetupError(err)) throw err
    if (!warnedSetup) {
      warnedSetup = true
      console.error(`[auth] ${err.message}`)
    }
    return null
  }
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return userId
}

function verifySession(value: string | undefined): Promise<string | null> {
  return verifySigned(value, "v2")
}

/**
 * Lien de connexion à usage court : après l'installation, le poste ouvre le dashboard déjà connecté, sans mettre le
 * jeton personnel dans une URL (historique du navigateur, journaux). Expire au bout de LOGIN_LINK_SECONDS.
 */
export async function createLoginCode(userId: string): Promise<string> {
  const tokenHash = await getStore().getTokenHash(userId)
  if (!tokenHash) throw new Error("Membre introuvable.")
  const exp = String(Date.now() + LOGIN_LINK_SECONDS * 1000)
  return `${userId}.${exp}.${await sign(userId, exp, tokenHash, "link1")}`
}

export function verifyLoginCode(code: string | null | undefined): Promise<string | null> {
  return verifySigned(code ?? undefined, "link1")
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
  const userId = await verifySession(session)
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
