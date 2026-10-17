// Authentification :
// - agents (brain-sync, MCP, hooks): personal token in the `Authorization: Bearer cb_…` header;
// - dashboard: signed session cookie (HMAC), obtained by signing in with one's token.
// An admin can "view as" another member to show per-zone access.

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

// HMAC secret for sessions: BRAIN_SESSION_SECRET if set, otherwise a random 32-byte secret generated
// once and kept by the store (<dataDir>/session-secret with mode 600, or the brain_settings table).
// Never derived from guessable values (base URL, folder, cwd…).
let warnedShortSecret = false
async function sessionSecret(): Promise<string> {
  const env = process.env.BRAIN_SESSION_SECRET?.trim()
  if (env) {
    if (env.length < 32 && !warnedShortSecret) {
      warnedShortSecret = true
      console.warn("[auth] BRAIN_SESSION_SECRET is short (< 32 characters): use a longer random value.")
    }
    return env
  }
  return getRootStore().getSessionSecret()
}

/**
 * Signed payload: purpose, member, expiry and the start of their token's fingerprint (regenerating the token invalidates
 * the sessions). The purpose separates session cookies ("v2") from sign-in links ("link1"): one is not worth the other.
 */
async function sign(userId: string, exp: string, tokenHash: string, purpose = "v2"): Promise<string> {
  return createHmac("sha256", await sessionSecret()).update(`${purpose}.${userId}.${exp}.${tokenHash.slice(0, 16)}`).digest("base64url")
}

/** The store of an account's company (accounts of all companies sign in at the same place). */
async function storeForUser(userId: string): Promise<BrainStore | null> {
  const orgId = await getRootStore().findUserOrg({ id: userId })
  return orgId ? storeForOrg(orgId) : null
}

async function tokenHashOf(userId: string): Promise<string | null> {
  return (await (await storeForUser(userId))?.getTokenHash(userId)) ?? null
}

/** Validity of a sign-in link opened by `brain.mjs setup`. */
export const LOGIN_LINK_SECONDS = 120

export async function createSessionValue(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Member not found.")
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
    // Secret not found (migration not applied): session cannot be verified, so it is refused (401 / sign-in page).
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

/** The account of a session cookie value, if it is valid (signature, expiry, token not regenerated). */
export function sessionUserId(value: string | undefined): Promise<string | null> {
  return verifySigned(value, "v2")
}
const verifySession = sessionUserId

/**
 * Companies remembered by this browser (separated by `~`), most recent first: one signed entry per company, for a
 * separate use ("acct1", which is not a session), valid for a year and renewed each time it is opened. They let you
 * come back to a company, or switch from one to another, without retyping its token; when the session expires, the
 * most recent one is reopened on its own. Protection: httpOnly (no script reads the token or the entry), signature,
 * and invalidation when the token is regenerated.
 */
export const ACCOUNTS_COOKIE = "brain_accounts"
/** Set by signing out: no automatic sign-in until a company has been reopened by hand. */
export const SIGNED_OUT_COOKIE = "brain_signed_out"
const MAX_ACCOUNTS = 8
const REMEMBER_DAYS = 365

export const accountsCookieOptions = { ...sessionCookieOptions, maxAge: REMEMBER_DAYS * 86400 }

async function createRememberValue(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Member not found.")
  const exp = String(Date.now() + REMEMBER_DAYS * 86400_000)
  return `${userId}.${exp}.${await sign(userId, exp, tokenHash, "acct1")}`
}

export type RememberedAccount = {
  userId: string
  name: string
  title?: string
  role: Profile["role"]
  org: { id: string; name: string; description: string }
}

/** `value`: the entry as is; `remembered`: false for a session (to convert into a one-year entry). */
type Remembered = RememberedAccount & { value: string; remembered: boolean }

/**
 * The entries still valid, with their account and company; only one per company (the first). A session (session
 * cookie, or entry remembered before the one-year entries) is accepted too.
 */
async function readRemembered(value: string | undefined): Promise<Remembered[]> {
  const out: Remembered[] = []
  for (const v of (value ?? "").split("~").filter(Boolean).slice(0, MAX_ACCOUNTS + 2)) {
    if (out.length >= MAX_ACCOUNTS) break
    const kept = await verifySigned(v, "acct1")
    const userId = kept ?? (await verifySession(v))
    if (!userId || out.some((a) => a.userId === userId)) continue
    const profile = await (await storeForUser(userId))?.getProfile(userId)
    if (!profile || out.some((a) => a.org.id === profile.org_id)) continue
    const org = await storeForOrg(profile.org_id).getOrg()
    out.push({
      value: v,
      remembered: kept !== null,
      userId,
      name: profile.name,
      title: profile.title,
      role: profile.role,
      org: { id: org.id, name: org.name, description: org.description },
    })
  }
  return out
}

/** The companies remembered by this browser, without the signed entries (for display). */
export async function listRememberedAccounts(value: string | undefined): Promise<RememberedAccount[]> {
  return (await readRemembered(value)).map(({ value: _v, remembered: _r, ...account }) => account)
}

/**
 * New value of the companies cookie: the given accounts, in order (most recent first), without expired entries or a
 * second account of the same company. Each argument is a session, an entry or a `~` list; a session becomes a one-year
 * entry (the one just opened thus starts again for a year).
 */
export async function rememberAccounts(...values: (string | undefined)[]): Promise<string> {
  const out: string[] = []
  for (const a of await readRemembered(values.filter(Boolean).join("~"))) out.push(a.remembered ? a.value : await createRememberValue(a.userId))
  return out.join("~")
}

/** The list of remembered companies, without the `userId` account. */
export async function forgetAccount(value: string | undefined, userId: string): Promise<string> {
  return (await readRemembered(value))
    .filter((a) => a.userId !== userId)
    .map((a) => a.value)
    .join("~")
}

/** The account of the most recently remembered company (automatic sign-in), or null. */
export async function latestRemembered(value: string | undefined): Promise<string | null> {
  return (await readRemembered(value))[0]?.userId ?? null
}

/** True if this browser still remembers this account. */
export async function isRemembered(value: string | undefined, userId: string): Promise<boolean> {
  return (await readRemembered(value)).some((a) => a.userId === userId)
}

/**
 * Short-lived sign-in link: after the install, the workstation opens the dashboard already signed in, without putting
 * the personal token in a URL (browser history, logs). Expires after LOGIN_LINK_SECONDS.
 */
export async function createLoginCode(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Member not found.")
  const exp = String(Date.now() + LOGIN_LINK_SECONDS * 1000)
  return `${userId}.${exp}.${await sign(userId, exp, tokenHash, "link1")}`
}

export function verifyLoginCode(code: string | null | undefined): Promise<string | null> {
  return verifySigned(code ?? undefined, "link1")
}

/** Validity of the upload code of an onboarding prepared by Claude Code or Codex (reading the history included). */
export const ONBOARDING_CODE_HOURS = 2

/**
 * Upload code for an onboarding done by an agent: it only allows depositing a proposal (POST
 * /api/onboarding/import) for this admin's company, who reviews it before applying it. Signed like a sign-in
 * link, with its own purpose; prefixed `co_` so that brain-sync recognizes and redacts it.
 */
export async function createOnboardingCode(userId: string): Promise<string> {
  const tokenHash = await tokenHashOf(userId)
  if (!tokenHash) throw new Error("Member not found.")
  const exp = String(Date.now() + ONBOARDING_CODE_HOURS * 3600_000)
  return `co_${Buffer.from(`${userId}.${exp}.${await sign(userId, exp, tokenHash, "onb1")}`).toString("base64url")}`
}

export async function verifyOnboardingCode(code: string | null | undefined): Promise<string | null> {
  const m = code?.trim().match(/^co_([A-Za-z0-9_-]{20,400})$/)
  if (!m) return null
  return verifySigned(Buffer.from(m[1], "base64url").toString("utf8"), "onb1")
}

export type Viewer = {
  /** Effective profile (the one whose permissions apply). */
  profile: Profile
  /** Profile actually signed in (different if an admin "views as"). */
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

/** For pages (server components): from the cookie values. */
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

/** For API routes: Bearer token (agents) or session cookie (dashboard). */
export async function viewerFromRequest(req: Request): Promise<Viewer | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return buildViewer(await profileFromToken(bearer))
  const cookie = req.headers.get("cookie")
  return viewerFromCookies(readCookie(cookie, SESSION_COOKIE), readCookie(cookie, VIEW_AS_COOKIE))
}

/** Demo mode: one-click sign-in on /login. Only enable with fictional data. */
export function isDemoMode(): boolean {
  return process.env.BRAIN_DEMO === "1" || process.env.BRAIN_DEMO === "true"
}

/** Company creation from the home page (/create). `BRAIN_SIGNUP=0` closes it: invitation-only brain. */
/** Public page on `/`. `BRAIN_LANDING=0` (brain run locally): `/` leads to /create, /login or the dashboard. */
export function landingEnabled(): boolean {
  return process.env.BRAIN_LANDING !== "0" && process.env.BRAIN_LANDING !== "false"
}

export function signupOpen(): boolean {
  return process.env.BRAIN_SIGNUP !== "0" && process.env.BRAIN_SIGNUP !== "false"
}
