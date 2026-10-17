// Les secrets du client lui-même (jeton du cerveau, jeton Screenpipe, clé API, jeton Claude Code) et la session d'installation
// (le prompt magique contient le jeton en clair) ne doivent jamais remonter au cerveau.

import type { Config } from "./config"

/**
 * Première phrase du prompt d'installation (apps/web/lib/install-prompt.ts) : la session qui le contient est ignorée.
 * Les deux formes : NOS Brainer (actuelle) et « cerveau d'entreprise » (prompts déjà distribués), plus le message
 * d'équipe (apps/web/lib/install-prompt.ts, buildJoinPrompt), qui contient le code de l'entreprise, et le prompt
 * d'onboarding par un agent (apps/web/lib/onboarding-agent.ts), qui contient un code d'envoi.
 */
export const INSTALL_PROMPT_RE = /Tu vas connecter ce poste (?:à NOS Brainer|au cerveau d'entreprise)|Tu vas demander à rejoindre NOS Brainer|Tu vas préparer l'onboarding de NOS Brainer/

/** Forme des jetons personnels du cerveau (cb_ + 32 caractères base64url), des codes d'équipe (cj_…) et d'envoi d'onboarding (co_…). */
const BRAIN_TOKEN_RE = /\bc[bjo]_[A-Za-z0-9_-]{20,}/g

const JETON = "[jeton masqué]"

/** Les secrets configurés sur ce poste, jetons de toutes ses entreprises compris (assez longs pour être reconnus sans faux positif). */
export function ownSecrets(cfg: Partial<Pick<Config, "token" | "companies" | "screenpipe_token" | "anthropic_api_key" | "claude_oauth_token">> | null | undefined): string[] {
  if (!cfg) return []
  return [cfg.token, ...(cfg.companies ?? []).map((c) => c.token), cfg.screenpipe_token, cfg.anthropic_api_key, cfg.claude_oauth_token]
    .filter((s): s is string => typeof s === "string" && s.trim().length >= 8)
    .map((s) => s.trim())
}

/** Masque les jetons du cerveau (toute forme cb_…) et, littéralement, les secrets configurés. */
export function maskOwnSecrets(text: string, secrets: string[] = []): { text: string; count: number } {
  let count = 0
  let out = text
  for (const s of secrets) {
    if (!out.includes(s)) continue
    const parts = out.split(s)
    count += parts.length - 1
    out = parts.join(JETON)
  }
  out = out.replace(BRAIN_TOKEN_RE, () => {
    count++
    return JETON
  })
  return { text: out, count }
}

/** Vrai pour la session d'installation du cerveau : prompt magique, ou texte contenant un des secrets du poste. */
export function isBrainSetupText(text: string, secrets: string[] = []): boolean {
  return INSTALL_PROMPT_RE.test(text) || secrets.some((s) => text.includes(s))
}
