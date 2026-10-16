// Filtre vie privée appliqué SUR LE POSTE, avant toute distillation ou envoi (et rejoué côté serveur).
// Principe : liste blanche d'apps + masquage des secrets et données personnelles.

import { normalize } from "./text"

/** Apps dont on accepte le contenu (sessions IA). Comparaison insensible à la casse, par inclusion dans le nom de l'app. */
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

/** Produits IA (conservé pour compatibilité ; la reconnaissance stricte d'un onglet passe par AI_TITLE_RE / AI_HOSTS). */
export const AI_WINDOW_HINTS = ["claude", "chatgpt", "codex", "openai", "anthropic", "mistral", "gemini", "perplexity"]

/** Domaines des assistants IA, quand Screenpipe fournit l'URL de l'onglet. */
export const AI_HOSTS = [
  "claude.ai", "chatgpt.com", "chat.openai.com", "platform.openai.com", "gemini.google.com", "aistudio.google.com",
  "chat.mistral.ai", "perplexity.ai", "console.anthropic.com", "copilot.microsoft.com", "chat.deepseek.com",
]

export const BROWSERS = ["chrome", "arc", "safari", "firefox", "brave", "edge", "opera", "vivaldi", "chromium"]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordsRe = (list: string[]) => new RegExp(`\\b(?:${list.map(escapeRe).join("|")})\\b`, "g")

const BROWSERS_RE = wordsRe(BROWSERS)

/** Apps grand public : signal faible (un vrai contexte de travail peut les citer, ex. « l'API WhatsApp Business »). */
const PERSONAL_APPS = [
  "whatsapp", "messenger", "telegram", "imessage", "snapchat", "tinder", "bumble", "hinge", "meetic", "happn", "grindr",
  "doctolib", "ameli", "mutuelle", "netflix", "youtube", "spotify", "deezer", "instagram", "facebook", "tiktok", "leboncoin",
  "vinted", "boursorama", "fortuneo", "banque populaire", "credit agricole", "credit mutuel", "caisse d'epargne",
  "societe generale", "bnp paribas", "banque postale", "hello bank",
]
const PERSONAL_APPS_RE = wordsRe(PERSONAL_APPS)

/** Noms d'apps ambigus dans un texte (« les messages d'erreur », « signal SIGTERM ») : bloqués seulement comme nom d'app exact. */
const PERSONAL_APP_NAMES = ["messages", "signal", "facetime", "photos", "contacts"]

/** Sujets de vie privée : signal fort, qu'aucun mot de travail n'excuse (texte sans accents, en minuscules). */
const STRONG_PERSONAL: RegExp[] = [
  // famille, couple
  /\b(?:ma|mon|mes) (?:copine|copain|cheri|cherie|femme|mari|epouse|epoux|compagne|compagnon|conjoint|conjointe|mere|pere|maman|papa|parents|fils|fille|filles|enfant|enfants|soeur|frere|grand-mere|grand-pere|belle-mere|beau-pere|famille)\b/g,
  /\bmon ex\b(?!-)/g,
  // santé
  /\b(?:arret maladie|arret de travail|burn-?out|depression|antidepresseurs?|anxiolytiques?|psychiatre|psychologue|ma psy|mon psy|therapeute|mon ordonnance|ordonnance (?:medicale|du (?:medecin|docteur|psychiatre|dentiste))|analyses? (?:de sang|sanguines?)|prise de sang|medecin traitant|mon medecin|ma medecin|gynecologue|ma grossesse|fausse couche|chimiotherapie)\b/g,
  // juridique perso
  /\b(?:divorce|divorcer|pension alimentaire|garde alternee|garde des enfants|mon avocat|mon avocate)\b/g,
  // rencontres
  /\b(?:tinder|bumble|hinge|meetic|happn|grindr|rencard)\b/g,
  // finances perso
  /\b(?:mon (?:compte|livret|pret|credit) (?:perso|personnel|bancaire|immobilier|joint)|mes impots|ma declaration d'impots|mon loyer|mon proprio)\b/g,
]

/** Vocabulaire de travail : il faut au moins deux de ces mots pour excuser un signal faible. */
const WORK_HINTS = [
  "client", "clients", "projet", "projets", "project", "facture", "factures", "devis", "contrat", "code", "api", "sdk", "bug",
  "deploy", "deploiement", "deployer", "production", "prod", "staging", "serveur", "server", "endpoint", "webhook", "webhooks",
  "repo", "commit", "branche", "merge", "migration", "sql", "database", "base de donnees", "ticket", "tickets", "sprint",
  "roadmap", "spec", "specs", "maquette", "backend", "frontend", "script", "fonction", "function", "typescript", "javascript",
  "python", "react", "docker", "integration", "integrer", "bot", "prospect", "prospects", "crm", "tresorerie", "compta", "tva",
  "urssaf", "paie", "recrutement", "composant", "component", "business", "entreprise", "equipe", "reunion",
]
const WORK_HINTS_RE = wordsRe(WORK_HINTS)

/** Pages web qui ne sont pas des sessions IA, même si leur titre cite Claude ou Gemini. */
const NON_AI_PAGE_RE =
  /\b(?:gmail|outlook|inbox|boite de reception|webmail|messagerie|yahoo|proton ?mail|wikipedia|youtube|linkedin|reddit|twitter|facebook|horoscope|astrologie)\b/

const AI_TITLE_RE =
  /^(?:claude(?:\.ai)?|claude code|chatgpt|chat ?gpt|chatgpt codex|codex|openai(?: platform| playground)?|anthropic console|console anthropic|google gemini|gemini|google ai studio|mistral(?: ai)?|le chat(?: mistral)?|perplexity(?: ai)?|copilot|microsoft copilot|deepseek)$/

const BROWSER_SUFFIX_RE =
  /\s[-–—|]\s(?:google chrome|chrome|chromium|mozilla firefox|firefox|safari|brave|microsoft edge|edge|opera|vivaldi|arc)\s*$/

function matchesAll(re: RegExp, text: string): string[] {
  re.lastIndex = 0
  return [...text.matchAll(re)].map((m) => m[0])
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** Onglet de navigateur : accepté seulement s'il s'agit visiblement d'un assistant IA (domaine, ou titre « … - Claude »). */
export function isAiBrowserWindow(windowName: string | undefined, browserUrl?: string): boolean {
  if (browserUrl) {
    const host = hostOf(browserUrl)
    return AI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  }
  const w = normalize(windowName ?? "").trim()
  if (!w || NON_AI_PAGE_RE.test(w)) return false
  const segments = w
    .replace(BROWSER_SUFFIX_RE, "")
    .split(/\s+[-–—|·:]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return false
  return AI_TITLE_RE.test(segments[0]) || AI_TITLE_RE.test(segments[segments.length - 1])
}

/**
 * Vrai si le contenu de cette fenêtre peut être lu. Mots entiers uniquement : « messages.ts » ou un onglet « signal »
 * dans un terminal ne sont pas des messageries. `browserUrl` (optionnel) : URL de l'onglet si Screenpipe la fournit.
 */
export function isAllowedApp(app: string | undefined, windowName: string | undefined, whitelist = DEFAULT_APP_WHITELIST, browserUrl?: string): boolean {
  const a = normalize(app ?? "").trim()
  const w = normalize(windowName ?? "").trim()
  if (!a && !w) return false
  if (PERSONAL_APP_NAMES.includes(a)) return false
  if (matchesAll(PERSONAL_APPS_RE, a).length || matchesAll(PERSONAL_APPS_RE, w).length) return false
  if (STRONG_PERSONAL.some((re) => matchesAll(re, w).length > 0)) return false
  if (matchesAll(BROWSERS_RE, a).length) return isAiBrowserWindow(windowName, browserUrl)
  return whitelist.some((x) => a.includes(normalize(x)))
}

export type PersonalSignals = { strong: string[]; weak: string[]; work: number }

/** Indices de contenu personnel trouvés dans un texte (pour décider, et pour l'expliquer en simulation). */
export function personalSignals(text: string): PersonalSignals {
  const t = normalize(text)
  const strong = [...new Set(STRONG_PERSONAL.flatMap((re) => matchesAll(re, t)))]
  const weak = [...new Set(matchesAll(PERSONAL_APPS_RE, t))]
  const work = new Set(matchesAll(WORK_HINTS_RE, t)).size
  return { strong, weak, work }
}

/**
 * Vrai si le texte ressemble à du contenu personnel qu'on préfère ignorer entièrement.
 * Un sujet de vie privée (santé, famille, divorce…) suffit ; une app grand public ne compte que sans vrai contexte de travail.
 */
export function looksPersonal(text: string): boolean {
  const s = personalSignals(text)
  if (s.strong.length > 0) return true
  return s.weak.length > 0 && s.work < 2
}

// ---------------------------------------------------------------------------------------------------------------------
// Masquage des secrets et données personnelles.

type Ctx = { input: string; offset: number }
type Rule = {
  name: string
  re: RegExp
  /** Texte de remplacement ($1… = groupes), ou fonction ; `null` = faux positif, on garde le texte. */
  replace: string | ((match: string, groups: (string | undefined)[], ctx: Ctx) => string | null)
  check?: (match: string, ctx: Ctx) => boolean
}

const MASK = "[masqué]"
const SECRET = "[secret masqué]"
const JETON = "[jeton masqué]"

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

function ibanValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase()
  if (s.length < 15 || s.length > 34 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const ch of moved) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rest = (rest * 10 + Number(d)) % 97
  }
  return rest === 1
}

/** IBAN : on cherche le plus long préfixe valide (clé modulo 97), pour ne pas avaler le mot suivant. */
function maskIban(match: string): string | null {
  const parts = match.split(/(?=[\s-][A-Z0-9])/i)
  for (let n = parts.length; n >= 1; n--) {
    const head = parts.slice(0, n).join("")
    if (ibanValid(head)) return "[IBAN masqué]" + parts.slice(n).join("")
  }
  // Format IBAN en majuscules mais clé fausse (faute de frappe) : on masque quand même.
  for (let n = parts.length; n >= 4; n--) {
    const head = parts.slice(0, n).join("")
    if (/^[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){3,}(?: [A-Z0-9]{1,4})?$/.test(head)) return "[IBAN masqué]" + parts.slice(n).join("")
  }
  return null
}

function basicAuthLooksReal(b64: string): boolean {
  try {
    const decoded = Buffer.from(b64, "base64").toString("latin1")
    return /^[\x20-\x7e]{1,200}:[\x20-\x7e]{1,200}$/.test(decoded)
  } catch {
    return false
  }
}

/** Mots qui suivent souvent « mot de passe : » ou « token : » sans être un secret. */
const PROSE_WORDS = new Set(
  (
    "le la les l un une des du de d est et ou en a au aux ce cet cette ces mon ma mes ton ta tes son sa ses leur leurs il elle on nous vous " +
    "ils elles pas plus dans sur sous pour par avec sans voir cf ici oui non aucun aucune vide identique le meme the an is are was to in on " +
    "of for and or not see here none yes no"
  ).split(/\s+/),
)

/** Valeurs qui ne sont pas des secrets : types, mots-clés, variables d'environnement, gabarits, valeurs déjà masquées. */
const PLACEHOLDER_RE =
  /^(?:\[|<|\{\{|\$\{|\$\(|\$[A-Z_][A-Z0-9_]*$|%[A-Z_(]|\*+$|[xX]{3,}$|•+$|\.{3}$|…|process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|env\(|env\.|secrets\.|vault:|(?:[Yy]our|YOUR|[Vv]otre|VOTRE)[-_ ]\w)/
const NON_SECRET_RE =
  /^(?:true|false|null|none|nil|undefined|str|string|number|int|integer|float|bool|boolean|bytes|any|unknown|object|optional|required|await|new|typeof|function|async|return|this|self|lambda|const|let|var)$/i

function plausibleSecret(value: string, quoted: boolean): boolean {
  const v = value.trim()
  if (v.length < 3 || PLACEHOLDER_RE.test(v)) return false
  if (quoted) return true
  if (NON_SECRET_RE.test(v) || PROSE_WORDS.has(v.toLowerCase())) return false
  // Un mot français accentué (« expiré », « oublié ») n'est pas un mot de passe.
  if (/^[a-zà-ÿ]+$/i.test(v) && /[à-ÿ]/i.test(v)) return false
  // Types et appels de code : Optional[str], Promise<string>, getToken(), cfg.token, req.headers.authorization
  if (/^(?:Optional|List|Dict|Union|Record|Array|Promise|Map|Set)\b/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*$/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[,;)]*$/.test(v)) return false
  return true
}

const SECRET_WORDS = new Set(["password", "passwd", "pwd", "pass", "mdp", "passphrase", "secret", "token", "credential", "credentials", "apikey", "cookie", "cvv", "cvc"])
const KEY_PREFIXES = new Set([
  "api", "access", "secret", "private", "auth", "signing", "encryption", "master", "license", "licence", "client", "app",
  "service", "account", "consumer", "session", "storage", "subscription", "sas", "webhook", "deploy", "ssh", "gpg", "pgp", "admin", "root",
])
const KEY_SUFFIXES = new Set(["base", "value", "b64", "base64", "hex", "raw", "enc", "encoded", "plain"])

/** Le nom de clé désigne-t-il un secret ? (DB_PASSWORD, clientSecret, x-api-key, aws_secret_access_key, mdp…) */
export function isSecretKey(key: string): boolean {
  if (key === "PWD" || key === "OLDPWD") return false // répertoire courant du shell
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.\-]+/)
    .map((p) => p.replace(/\d+$/, ""))
    .filter(Boolean)
  while (parts.length > 1 && KEY_SUFFIXES.has(parts[parts.length - 1])) parts.pop()
  if (parts.length === 0) return false
  const last = parts[parts.length - 1]
  const prev = parts[parts.length - 2]
  if (parts.join("").endsWith("motdepasse")) return true
  if (SECRET_WORDS.has(last) || /(?:password|passwd|passphrase|secret|token|apikey)$/.test(last)) return true
  if (last === "key" && prev && KEY_PREFIXES.has(prev)) return true
  if (last === "id" && prev === "key" && parts[parts.length - 3] === "private") return true
  return /^[A-Z][A-Z0-9_]*_KEY\d*$/.test(key)
}

/** Sépare la ponctuation finale d'une valeur non entre guillemets (« mdp: azerty12, puis… »). */
function splitTrailing(v: string): [string, string] {
  const m = v.match(/^(.*?)([,;:.)\]}]+)$/)
  return m && m[1].length >= 3 ? [m[1], m[2]] : [v, ""]
}

const SECRET_CONTEXT_RE = /(?:aws|secret|secr[eè]te?|access[ _-]?key|cl[ée]|credential|password|mot de passe)/i

const RULES: Rule[] = [
  {
    name: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s\\]*)/g,
    replace: "[clé privée masquée]",
  },
  {
    // user:motdepasse@hôte — le mot de passe peut contenir « / » ou « @ » : on va jusqu'au dernier « @ » suivi d'un hôte.
    name: "url_credentials",
    re: /\b([a-z][a-z0-9+.\-]*:\/\/)([^\s:/]+?):(\S+?)@(?=[A-Za-z0-9.\-]+(?::\d+)?(?:[/?#\s"'<>)\],;]|$))/gi,
    replace: (m, g) => (/^\d{1,5}\//.test(g[2] ?? "") ? null : `${g[0]}[identifiants masqués]@`),
  },
  { name: "webhook_url", re: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/\-]+/g, replace: "[webhook masqué]" },
  { name: "webhook_url", re: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_\-]+/g, replace: "[webhook masqué]" },
  { name: "webhook_url", re: /https?:\/\/[a-z0-9.\-]*webhook\.office\.com\/[^\s"'<>]+/gi, replace: "[webhook masqué]" },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_\-]{10,}/g, replace: SECRET },
  { name: "openai_key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}/g, replace: SECRET },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, replace: SECRET },
  { name: "gitlab_token", re: /\b(?:glpat|gldt|glrt|glptt|glft|glsoat)-[A-Za-z0-9_\-]{20,}/g, replace: SECRET },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: SECRET },
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}\b/g, replace: SECRET },
  { name: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, replace: SECRET },
  { name: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: SECRET },
  { name: "stripe_webhook_secret", re: /\bwhsec_[A-Za-z0-9+/=]{20,}/g, replace: SECRET },
  { name: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: SECRET },
  { name: "slack_token", re: /\bxapp-\d-[A-Za-z0-9-]{10,}/g, replace: SECRET },
  { name: "aws_key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, replace: SECRET },
  { name: "google_key", re: /\bAIza[0-9A-Za-z_\-]{30,}/g, replace: SECRET },
  { name: "saas_token", re: /\b(?:shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|lin_api_[A-Za-z0-9]{32,}|ntn_[A-Za-z0-9]{40,}|sbp_[a-f0-9]{40}|sb_secret_[A-Za-z0-9_\-]{20,}|key-[a-f0-9]{32})\b/g, replace: SECRET },
  { name: "saas_token", re: /\bpat-(?:na|eu)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, replace: SECRET },
  { name: "telegram_token", re: /\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b/g, replace: SECRET },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_\-]{10,}\.(?:eyJ[A-Za-z0-9_\-]{5,}\.?[A-Za-z0-9_\-]*|[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})/g,
    replace: "[jeton masqué]",
  },
  // Jeton personnel du cerveau (cb_ + 32 caractères base64url).
  { name: "brain_token", re: /\bcb_[A-Za-z0-9_\-]{16,}/g, replace: JETON, check: (m) => /[A-Z0-9]/.test(m.slice(3)) },
  {
    name: "auth_header",
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["'`]?)(?:(Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|AWS4-HMAC-SHA256|SSWS)\s+)?(?!\[|\$\{|(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|SSWS)\s)([^\s"'`,;]{6,})/gi,
    replace: (m, g) => `${g[0]}${g[1] ? `${g[1]} ` : ""}${MASK}`,
  },
  {
    name: "basic_auth",
    re: /\b(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g,
    replace: (m, g) => (basicAuthLooksReal(g[1] ?? "") ? `${g[0]}${MASK}` : null),
  },
  {
    name: "bearer",
    re: /\b(Bearer|Token|Jeton)\s+(?!\[)([A-Za-z0-9._~+/\-]{16,}=*)/gi,
    replace: (m, g) => (/^bearer$/i.test(g[0] ?? "") || /\d/.test(g[1] ?? "") ? `${g[0]} ${JETON}` : null),
  },
  {
    // CLE=valeur, clé: "valeur", "clé": "valeur", --clé=valeur, clé => valeur (env, YAML, JSON, code, en-têtes HTTP).
    name: "env_secret",
    re: /(["'`]?)\b([A-Za-z][A-Za-z0-9_.\-]{0,60})\1(\??\s*(?:=>|:=|=|:)[ \t]*)(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`|([^\s"'`<>]+))/g,
    replace: (m, g) => {
      const [q, key, sep, dq, sq, bq, bare] = g
      if (!key || !isSecretKey(key)) return null
      const head = `${q}${key}${q}${sep}`
      if (dq !== undefined) return plausibleSecret(dq, true) ? `${head}"${MASK}"` : null
      if (sq !== undefined) return plausibleSecret(sq, true) ? `${head}'${MASK}'` : null
      if (bq !== undefined) return plausibleSecret(bq, true) ? `${head}\`${MASK}\`` : null
      const [value, tail] = splitTrailing(bare ?? "")
      return plausibleSecret(value, false) ? `${head}${MASK}${tail}` : null
    },
  },
  {
    // --password s3cret, --token xyz (la forme --clé=valeur est traitée juste au-dessus).
    name: "cli_secret",
    re: /(--?(?:password|passwd|pass|pwd|token|secret|api-key|apikey|api_key|access-token|auth-token|client-secret)\s+)(["']?)(?!-)([^\s"']+)\2/gi,
    replace: (m, g) => (plausibleSecret(g[2] ?? "", Boolean(g[1])) ? `${g[0]}${g[1]}${MASK}${g[1]}` : null),
  },
  {
    name: "cli_secret",
    re: /(\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g,
    replace: (m, g) => (plausibleSecret(g[2] ?? "", true) ? `${g[0]}${g[1]}:${MASK}` : null),
  },
  {
    // En toutes lettres : « le mot de passe ssh root est Azerty123! », « mdp : … », « the password is … ».
    name: "password_text",
    re: /\b(mots? de passe|mdp|password|passwd|pass ?phrase|code (?:secret|d'acc[eè]s|wi-?fi))\b([^\n.!?:=]{0,40}?)(\s*(?:[:=]|\b(?:est|c'est|sera|vaut|is|was)\b)\s*)(["'«“]?\s*)([^\s"'»”]+)/gi,
    replace: (m, g) => {
      const [value, tail] = splitTrailing(g[4] ?? "")
      const strongish = /[\d!@#$%^&*_+=?~\-]/.test(value) || /[A-Z]/.test(value.slice(1)) || (value.length >= 10 && !/[à-ÿ]/i.test(value))
      return plausibleSecret(value, false) && strongish ? `${g[0]}${g[1]}${g[2]}${g[3]}${MASK}${tail}` : null
    },
  },
  {
    name: "secret_text",
    re: /\b(cl[ée]s? (?:d'?)?api|cl[ée] secr[èe]te|api[ -]?key|secret key|access key|jeton|token|secret)\b([^\n.!?:=]{0,30}?)(\s*(?:[:=]|\b(?:est|c'est|vaut|is)\b)\s*)(["'«“]?\s*)([^\s"'»”]+)/gi,
    replace: (m, g) => {
      const [value, tail] = splitTrailing(g[4] ?? "")
      return value.length >= 12 && /\d/.test(value) && /[A-Za-z]/.test(value) && plausibleSecret(value, false)
        ? `${g[0]}${g[1]}${g[2]}${g[3]}${MASK}${tail}`
        : null
    },
  },
  {
    // Clé secrète AWS (40 caractères base64) sans nom de variable, mais annoncée juste avant (« secret », « aws », « clé »).
    name: "aws_secret",
    re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    replace: SECRET,
    check: (m, ctx) =>
      /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9/+]/.test(m) && SECRET_CONTEXT_RE.test(ctx.input.slice(Math.max(0, ctx.offset - 80), ctx.offset)),
  },
  { name: "iban", re: /\b[A-Z]{2}\d{2}(?:[ \-]?[A-Z0-9]{4}){2,7}(?:[ \-]?[A-Z0-9]{1,4})?\b/gi, replace: (m) => maskIban(m) },
  {
    name: "card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: "[numéro masqué]",
    // Un SIRET passe aussi la clé de Luhn : ce n'est pas une donnée personnelle.
    check: (m, ctx) => luhn(m) && !/\bSIRE[NT]\W{0,4}$/i.test(ctx.input.slice(Math.max(0, ctx.offset - 12), ctx.offset)),
  },
  { name: "email", re: /\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,24}\b/g, replace: "[email masqué]" },
  { name: "phone_fr", re: /(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, replace: "[téléphone masqué]" },
  { name: "phone_intl", re: /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}\b/g, replace: "[téléphone masqué]" },
  {
    // N° de sécurité sociale, y compris la Corse (département 2A / 2B).
    name: "nir",
    re: /\b[12][\s.]?\d{2}[\s.]?(?:0[1-9]|1[0-2])[\s.]?(?:\d{2}|2[AB])[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{2}\b/gi,
    replace: "[n° sécu masqué]",
  },
]

export type RedactionReport = { text: string; redactions: Record<string, number> }

export type RedactOptions = {
  /** Valeurs connues à masquer telles quelles (jeton du cerveau, clé API de la config…). Ignorées sous 8 caractères. */
  literals?: (string | undefined | null)[]
}

/** Masque secrets et données personnelles. Idempotent. */
export function redact(text: string, opts: RedactOptions = {}): RedactionReport {
  const redactions: Record<string, number> = {}
  let out = text
  const literals = [...new Set((opts.literals ?? []).filter((l): l is string => typeof l === "string" && l.trim().length >= 8))]
  for (const lit of literals.sort((a, b) => b.length - a.length)) {
    const parts = out.split(lit)
    if (parts.length > 1) {
      redactions.literal = (redactions.literal ?? 0) + parts.length - 1
      out = parts.join(SECRET)
    }
  }
  for (const r of RULES) {
    r.re.lastIndex = 0
    out = out.replace(r.re, (...args: unknown[]) => {
      const match = args[0] as string
      const input = args[args.length - 1] as string
      const offset = args[args.length - 2] as number
      const groups = args.slice(1, -2) as (string | undefined)[]
      const ctx = { input, offset }
      if (r.check && !r.check(match, ctx)) return match
      const replaced = typeof r.replace === "function" ? r.replace(match, groups, ctx) : r.replace.replace(/\$(\d)/g, (_, i) => groups[Number(i) - 1] ?? "")
      if (replaced === null || replaced === match) return match
      redactions[r.name] = (redactions[r.name] ?? 0) + 1
      return replaced
    })
  }
  return { text: out, redactions }
}

export function redactText(text: string, opts?: RedactOptions): string {
  return redact(text, opts).text
}
