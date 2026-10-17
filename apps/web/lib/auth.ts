// Authentification :
// - agents (brain-sync, MCP, hooks) : jeton personnel en en-tête `Authorization: Bearer cb_…` ;
// - dashboard : cookie de session signé (HMAC), obtenu en se connectant avec son jeton.
// Un admin peut « voir en tant que » un autre membre pour montrer les accès par zone.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Profile } from "@brain/core"
import { getRootStore, isStoreSetupError, storeForOrg, type BrainStore } from "./store"
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
  return getRootStore().getSessionSecret()
}

/**
 * Charge signée : usage, membre, expiration et début de l'empreinte de son jeton (régénérer le jeton invalide les
 * sessions). L'usage sépare les cookies de session (« v2 ») des liens de connexion (« link1 ») : l'un ne vaut pas l'autre.
 */
async function sign(userId: string, exp: string, tokenHash: string, purpose = "v2"): Promise<string> {
  return createHmac("sha256", await sessionSecret()).update(`${purpose}.${userId}.${exp}.${tokenHash.slice(0, 16)}`).digest("base64url")
}

/** Le stockage de l'entreprise d'un compte (les comptes de toutes les entreprises se connectent au même endroit). */
async function storeForUser(userId: string): Promise<BrainStore | null> {
  const orgId = await getRootStore().findUserOrg({ id: userId })
  return orgId ? storeForOrg(orgId) : null
}

async function tokenHashOf(userId: string): Promise<string | null> {
  return (await (await storeForUser(userId))?.getTokenHash(userId)) ?? null
}

/** Durée de validité d'un lien de connexion ouvert par `brain.mjs setup`. */
export const LOGIN_LINK_SECONDS = 120

export async function createSessionValue(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
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
  const tokenHash = await tokenHashOf(userId)
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

/** Le compte d'une valeur de cookie de session, si elle est valable (signature, expiration, jeton non régénéré). */
export function sessionUserId(value: string | undefined): Promise<string | null> {
  return verifySigned(value, "v2")
}
const verifySession = sessionUserId

/**
 * Entreprises retenues par ce navigateur : une session signée par entreprise (séparées par `~`), la plus récente
 * d'abord. Elles permettent de revenir à une entreprise, ou de passer de l'une à l'autre, sans ressaisir son jeton.
 * Même protection que le cookie de session (httpOnly, signé, 14 jours, invalidé quand le jeton est régénéré).
 */
export const ACCOUNTS_COOKIE = "brain_accounts"
const MAX_ACCOUNTS = 8

export type RememberedAccount = {
  userId: string
  name: string
  title?: string
  role: Profile["role"]
  org: { id: string; name: string; description: string }
}

type Remembered = RememberedAccount & { session: string }

/** Les sessions retenues encore valables, avec leur compte et leur entreprise ; une seule par entreprise (la première). */
async function readRemembered(value: string | undefined): Promise<Remembered[]> {
  const out: Remembered[] = []
  for (const session of (value ?? "").split("~").filter(Boolean).slice(0, MAX_ACCOUNTS + 2)) {
    if (out.length >= MAX_ACCOUNTS) break
    const userId = await verifySession(session)
    if (!userId || out.some((a) => a.userId === userId)) continue
    const profile = await (await storeForUser(userId))?.getProfile(userId)
    if (!profile || out.some((a) => a.org.id === profile.org_id)) continue
    const org = await storeForOrg(profile.org_id).getOrg()
    out.push({ session, userId, name: profile.name, title: profile.title, role: profile.role, org: { id: org.id, name: org.name, description: org.description } })
  }
  return out
}

/** Les entreprises retenues par ce navigateur, sans les sessions (pour l'affichage). */
export async function listRememberedAccounts(value: string | undefined): Promise<RememberedAccount[]> {
  return (await readRemembered(value)).map(({ session: _session, ...account }) => account)
}

/**
 * Nouvelle valeur du cookie des entreprises : les sessions données, dans l'ordre (la plus récente d'abord), sans les
 * sessions expirées ni un second compte de la même entreprise. Chaque argument est une session ou une liste `~`.
 */
export async function rememberAccounts(...values: (string | undefined)[]): Promise<string> {
  return (await readRemembered(values.filter(Boolean).join("~"))).map((a) => a.session).join("~")
}

/** La liste des entreprises retenues, sans le compte `userId`. */
export async function forgetAccount(value: string | undefined, userId: string): Promise<string> {
  return (await readRemembered(value))
    .filter((a) => a.userId !== userId)
    .map((a) => a.session)
    .join("~")
}

/** Vrai si ce navigateur retient encore une session valable pour ce compte. */
export async function isRemembered(value: string | undefined, userId: string): Promise<boolean> {
  return (await readRemembered(value)).some((a) => a.userId === userId)
}

/**
 * Lien de connexion à usage court : après l'installation, le poste ouvre le dashboard déjà connecté, sans mettre le
 * jeton personnel dans une URL (historique du navigateur, journaux). Expire au bout de LOGIN_LINK_SECONDS.
 */
export async function createLoginCode(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Membre introuvable.")
  const exp = String(Date.now() + LOGIN_LINK_SECONDS * 1000)
  return `${userId}.${exp}.${await sign(userId, exp, tokenHash, "link1")}`
}

export function verifyLoginCode(code: string | null | undefined): Promise<string | null> {
  return verifySigned(code ?? undefined, "link1")
}

/** Durée de validité du code d'envoi d'un onboarding préparé par Claude Code ou Codex (lecture de l'historique comprise). */
export const ONBOARDING_CODE_HOURS = 2

/**
 * Code d'envoi de l'onboarding par un agent : il permet seulement de déposer une proposition (POST
 * /api/onboarding/import) pour l'entreprise de cet admin, qui la relit avant de l'appliquer. Signé comme un lien de
 * connexion, avec son propre usage ; préfixé `co_` pour que brain-sync le reconnaisse et le masque.
 */
export async function createOnboardingCode(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Membre introuvable.")
  const exp = String(Date.now() + ONBOARDING_CODE_HOURS * 3600_000)
  return `co_${Buffer.from(`${userId}.${exp}.${await sign(userId, exp, tokenHash, "onb1")}`).toString("base64url")}`
}

export async function verifyOnboardingCode(code: string | null | undefined): Promise<string | null> {
  const m = code?.trim().match(/^co_([A-Za-z0-9_-]{20,400})$/)
  if (!m) return null
  return verifySigned(Buffer.from(m[1], "base64url").toString("utf8"), "onb1")
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
  if (viewAs && real.role === "admin" && viewAs !== real.id) profile = (await storeForOrg(real.org_id).getProfile(viewAs)) ?? real
  return { profile, real, access: await getAccess(profile) }
}

export async function profileFromToken(token: string): Promise<Profile | null> {
  const hash = hashToken(token.trim())
  const orgId = await getRootStore().findUserOrg({ tokenHash: hash })
  return orgId ? storeForOrg(orgId).getProfileByTokenHash(hash) : null
}

/** Pour les pages (server components) : à partir des valeurs de cookies. */
export async function viewerFromCookies(session: string | undefined, viewAs: string | undefined): Promise<Viewer | null> {
  const userId = await verifySession(session)
  if (!userId) return null
  return buildViewer((await (await storeForUser(userId))?.getProfile(userId)) ?? null, viewAs)
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

/** Création d'entreprise depuis la page d'accueil (/creer). `BRAIN_SIGNUP=0` la ferme : cerveau sur invitation seulement. */
export function signupOpen(): boolean {
  return process.env.BRAIN_SIGNUP !== "0" && process.env.BRAIN_SIGNUP !== "false"
}
