// Clé API Claude de l'entreprise, saisie par un admin dans « Zones » : c'est elle qui paie les appels du serveur pour
// cette entreprise (nouvelles zones, résumé d'état, onboarding). Chiffrée (AES-256-GCM) dans les réglages de
// l'entreprise et jamais renvoyée en clair : l'API n'en montre que les 4 derniers caractères.
// Le chiffrement prend BRAIN_SECRET_KEY si elle est définie (la clé reste illisible même avec un accès à la base),
// sinon le secret de session du cerveau, conservé dans la même base (protège d'une lecture des seuls réglages).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"
import { getRootStore, type BrainStore } from "./store"

const SETTING = "claude-api-key"

/** Format d'une clé de la Console Anthropic (sk-ant-api03-…, sk-ant-admin…). */
export const CLAUDE_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/

type Stored = { v: 1; iv: string; tag: string; data: string; last4: string; updated_at: string; updated_by: string }

export type ClaudeKeyInfo = {
  /** `org` : clé de l'entreprise ; `server` : ANTHROPIC_API_KEY du déploiement ; null : pas de Claude côté serveur. */
  source: "org" | "server" | null
  last4?: string
  updated_at?: string
  updated_by?: string
}

async function cipherKey(): Promise<Buffer> {
  const secret = process.env.BRAIN_SECRET_KEY?.trim() || (await getRootStore().getSessionSecret())
  return createHash("sha256").update(`claude-key.v1:${secret}`).digest()
}

async function readStored(store: BrainStore): Promise<Stored | null> {
  const raw = await store.getOrgSetting(SETTING)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Stored
    return s?.v === 1 ? s : null
  } catch {
    return null
  }
}

/** La clé de l'entreprise en clair, ou null (absente, ou illisible si BRAIN_SECRET_KEY a changé). */
export async function getOrgClaudeKey(store: BrainStore): Promise<string | null> {
  const s = await readStored(store)
  if (!s) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", await cipherKey(), Buffer.from(s.iv, "base64"))
    decipher.setAuthTag(Buffer.from(s.tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    console.error("[claude-key] clé de l'entreprise illisible (BRAIN_SECRET_KEY a changé ?) : à saisir de nouveau")
    return null
  }
}

export async function setOrgClaudeKey(store: BrainStore, key: string, updatedBy: string): Promise<ClaudeKeyInfo> {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", await cipherKey(), iv)
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()])
  const stored: Stored = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    last4: key.slice(-4),
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }
  await store.setOrgSetting(SETTING, JSON.stringify(stored))
  return { source: "org", last4: stored.last4, updated_at: stored.updated_at, updated_by: updatedBy }
}

export async function clearOrgClaudeKey(store: BrainStore): Promise<void> {
  await store.setOrgSetting(SETTING, null)
}

export function serverHasClaude(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

/** Ce que l'admin voit : d'où vient Claude pour son entreprise, sans jamais la clé elle-même. */
export async function claudeKeyInfo(store: BrainStore): Promise<ClaudeKeyInfo> {
  const s = await readStored(store)
  if (s) return { source: "org", last4: s.last4, updated_at: s.updated_at, updated_by: s.updated_by }
  return { source: serverHasClaude() ? "server" : null }
}

/**
 * Essaie la clé auprès d'Anthropic (liste des modèles : gratuit, sans jeton consommé) avant de l'enregistrer.
 * `invalid` : Anthropic la refuse ; `unreachable` : impossible de vérifier (réseau, panne), rien n'est enregistré.
 */
export async function verifyClaudeKey(key: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "unreachable"; message: string }> {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 }).models.list({ limit: 1 })
    return { ok: true }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
      return { ok: false, reason: "invalid", message: "Anthropic refuse cette clé : vérifiez-la dans la Console (console.anthropic.com), ou créez-en une nouvelle." }
    return { ok: false, reason: "unreachable", message: "Impossible de joindre Anthropic pour vérifier la clé : réessayez dans un instant." }
  }
}
