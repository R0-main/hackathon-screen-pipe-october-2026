// The company's Claude API key, entered by an admin in "Zones": it pays for the server's calls for
// this company (new zones, status summary, onboarding). Encrypted (AES-256-GCM) in the company's
// settings and never sent back in clear: the API only shows its last 4 characters.
// Encryption uses BRAIN_SECRET_KEY when it is set (the key stays unreadable even with database access),
// otherwise the brain's session secret, kept in the same database (protects against reading the settings alone).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"
import { getRootStore, type BrainStore } from "./store"

const SETTING = "claude-api-key"

/** Format of an Anthropic Console key (sk-ant-api03-…, sk-ant-admin…). */
export const CLAUDE_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/

type Stored = { v: 1; iv: string; tag: string; data: string; last4: string; updated_at: string; updated_by: string }

export type ClaudeKeyInfo = {
  /** `org`: the company's key; `server`: the deployment's ANTHROPIC_API_KEY; null: no Claude on the server. */
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

/** The company's key in clear, or null (missing, or unreadable if BRAIN_SECRET_KEY changed). */
export async function getOrgClaudeKey(store: BrainStore): Promise<string | null> {
  const s = await readStored(store)
  if (!s) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", await cipherKey(), Buffer.from(s.iv, "base64"))
    decipher.setAuthTag(Buffer.from(s.tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    console.error("[claude-key] the company's key is unreadable (did BRAIN_SECRET_KEY change?): enter it again")
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

/** What the admin sees: where Claude comes from for their company, never the key itself. */
export async function claudeKeyInfo(store: BrainStore): Promise<ClaudeKeyInfo> {
  const s = await readStored(store)
  if (s) return { source: "org", last4: s.last4, updated_at: s.updated_at, updated_by: s.updated_by }
  return { source: serverHasClaude() ? "server" : null }
}

/**
 * Tries the key against Anthropic (model list: free, no token consumed) before saving it.
 * `invalid`: Anthropic rejects it; `unreachable`: cannot check (network, outage), nothing is saved.
 */
export async function verifyClaudeKey(key: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "unreachable"; message: string }> {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 }).models.list({ limit: 1 })
    return { ok: true }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
      return { ok: false, reason: "invalid", message: "Anthropic rejects this key: check it in the Console (console.anthropic.com), or create a new one." }
    return { ok: false, reason: "unreachable", message: "Could not reach Anthropic to check the key: try again in a moment." }
  }
}
