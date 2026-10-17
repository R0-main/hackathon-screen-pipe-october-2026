// The client's own secrets (brain token, Screenpipe token, API key, Claude Code token) and the install session
// (the magic prompt contains the token in clear text) must never go up to the brain.

import type { Config } from "./config"

/**
 * First sentence of the install prompt (apps/web/lib/install-prompt.ts): the session that contains it is ignored.
 * The current English forms, plus the French ones of prompts already handed out (NOS Brainer and "cerveau d'entreprise"):
 * the install prompt, the team message (buildJoinPrompt), which contains the company's code, and the onboarding prompt
 * for an agent (apps/web/lib/onboarding-agent.ts), which contains an upload code.
 */
export const INSTALL_PROMPT_RE = /You are going to (?:connect this computer to NOS Brainer|ask to join NOS Brainer|prepare the onboarding of NOS Brainer)|Tu vas connecter ce poste (?:à NOS Brainer|au cerveau d'entreprise)|Tu vas demander à rejoindre NOS Brainer|Tu vas préparer l'onboarding de NOS Brainer/

/** Shape of the brain's personal tokens (cb_ + 32 base64url characters), team codes (cj_…) and onboarding upload codes (co_…). */
const BRAIN_TOKEN_RE = /\bc[bjo]_[A-Za-z0-9_-]{20,}/g

const TOKEN_MASK = "[token redacted]"

/** The secrets configured on this computer, tokens of all its companies included (long enough to be recognized without false positives). */
export function ownSecrets(cfg: Partial<Pick<Config, "token" | "companies" | "screenpipe_token" | "anthropic_api_key" | "claude_oauth_token">> | null | undefined): string[] {
  if (!cfg) return []
  return [cfg.token, ...(cfg.companies ?? []).map((c) => c.token), cfg.screenpipe_token, cfg.anthropic_api_key, cfg.claude_oauth_token]
    .filter((s): s is string => typeof s === "string" && s.trim().length >= 8)
    .map((s) => s.trim())
}

/** Redacts the brain's tokens (any cb_… form) and, literally, the configured secrets. */
export function maskOwnSecrets(text: string, secrets: string[] = []): { text: string; count: number } {
  let count = 0
  let out = text
  for (const s of secrets) {
    if (!out.includes(s)) continue
    const parts = out.split(s)
    count += parts.length - 1
    out = parts.join(TOKEN_MASK)
  }
  out = out.replace(BRAIN_TOKEN_RE, () => {
    count++
    return TOKEN_MASK
  })
  return { text: out, count }
}

/** True for the brain's install session: magic prompt, or text containing one of the computer's secrets. */
export function isBrainSetupText(text: string, secrets: string[] = []): boolean {
  return INSTALL_PROMPT_RE.test(text) || secrets.some((s) => text.includes(s))
}
