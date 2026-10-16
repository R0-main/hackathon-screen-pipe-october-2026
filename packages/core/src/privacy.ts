// Filtre vie privée appliqué SUR LE POSTE, avant toute distillation ou envoi.
// Principe : liste blanche d'apps + masquage des secrets et données personnelles.

/** Apps dont on accepte le contenu (sessions IA). Comparaison insensible à la casse, par inclusion. */
export const DEFAULT_APP_WHITELIST = [
  "claude",
  "codex",
  "chatgpt",
  "terminal",
  "iterm",
  "warp",
  "ghostty",
  "alacritty",
  "kitty",
  "wezterm",
  "code", // VS Code (Claude Code dans le terminal intégré)
  "cursor",
  "windsurf",
  "zed",
]

/** Fenêtres de navigateur acceptées uniquement si le titre ressemble à une session IA. */
export const AI_WINDOW_HINTS = ["claude", "chatgpt", "codex", "openai", "anthropic", "mistral", "gemini", "perplexity"]

export const BROWSERS = ["chrome", "arc", "safari", "firefox", "brave", "edge", "opera", "vivaldi", "chromium"]

/** Mots qui signalent un contenu perso à ne jamais faire remonter (titre de fenêtre ou texte). */
const PERSONAL_HINTS = [
  "whatsapp", "messenger", "signal", "telegram", "imessage", "messages", "tinder", "bumble", "hinge", "doctolib",
  "ameli", "mutuelle", "banque populaire", "boursorama", "credit agricole", "societe generale", "bnp paribas",
  "netflix", "youtube", "spotify", "instagram", "facebook", "tiktok", "leboncoin",
]

export function isAllowedApp(app: string | undefined, windowName: string | undefined, whitelist = DEFAULT_APP_WHITELIST): boolean {
  const a = (app ?? "").toLowerCase()
  const w = (windowName ?? "").toLowerCase()
  if (!a && !w) return false
  if (PERSONAL_HINTS.some((h) => a.includes(h) || w.includes(h))) return false
  if (BROWSERS.some((b) => a.includes(b))) return AI_WINDOW_HINTS.some((h) => w.includes(h))
  return whitelist.some((x) => a.includes(x.toLowerCase()))
}

type Rule = { name: string; re: RegExp; replace: string; check?: (match: string) => boolean }

function luhn(match: string): boolean {
  const digits = match.replace(/\D/g, "")
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const RULES: Rule[] = [
  { name: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[clé privée masquée]" },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_\-]{10,}/g, replace: "[secret masqué]" },
  { name: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g, replace: "[secret masqué]" },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, replace: "[secret masqué]" },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[secret masqué]" },
  { name: "aws_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "[secret masqué]" },
  { name: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: "[secret masqué]" },
  { name: "google_key", re: /\bAIza[0-9A-Za-z_\-]{30,}/g, replace: "[secret masqué]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, replace: "[jeton masqué]" },
  { name: "bearer", re: /\b(Bearer|Token)\s+[A-Za-z0-9._\-]{16,}/gi, replace: "$1 [jeton masqué]" },
  {
    name: "env_secret",
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{4,}["']?/g,
    replace: "$1=[masqué]",
  },
  { name: "url_credentials", re: /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, replace: "$1[identifiants masqués]@" },
  { name: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, replace: "[IBAN masqué]" },
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g, replace: "[numéro masqué]", check: luhn },
  { name: "email", re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, replace: "[email masqué]" },
  { name: "phone_fr", re: /(?:(?:\+|00)33[\s.\-]?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, replace: "[téléphone masqué]" },
  { name: "phone_intl", re: /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}\b/g, replace: "[téléphone masqué]" },
  { name: "nir", re: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g, replace: "[n° sécu masqué]" },
]

export type RedactionReport = { text: string; redactions: Record<string, number> }

/** Masque secrets et données personnelles. Idempotent. */
export function redact(text: string): RedactionReport {
  const redactions: Record<string, number> = {}
  let out = text
  for (const r of RULES) {
    out = out.replace(r.re, (...args) => {
      if (r.check && !r.check(args[0] as string)) return args[0] as string
      redactions[r.name] = (redactions[r.name] ?? 0) + 1
      const groups = args.slice(1, -2) as (string | undefined)[]
      return r.replace.replace(/\$(\d)/g, (_, i) => groups[Number(i) - 1] ?? "")
    })
  }
  return { text: out, redactions }
}

export function redactText(text: string): string {
  return redact(text).text
}

/** Vrai si le texte ressemble à du contenu personnel qu'on préfère ignorer entièrement. */
export function looksPersonal(text: string): boolean {
  const t = text.toLowerCase()
  return PERSONAL_HINTS.some((h) => t.includes(h)) && !/\b(client|projet|project|facture|code|api)\b/.test(t)
}
