// Privacy filter applied ON THE WORKSTATION, before any distillation or upload (and replayed on the server).
// Principle: an app allowlist + redaction of secrets and personal data.

import { normalize } from "./text"

/** Apps whose content is accepted (AI sessions). Case-insensitive, matched by inclusion in the app name. */
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
  "code", // VS Code (Claude Code in the integrated terminal)
  "cursor",
  "windsurf",
  "zed",
]

/** AI products (kept for compatibility; strict tab recognition goes through AI_TITLE_RE / AI_HOSTS). */
export const AI_WINDOW_HINTS = ["claude", "chatgpt", "codex", "openai", "anthropic", "mistral", "gemini", "perplexity"]

/** AI assistant domains, when Screenpipe provides the tab URL. */
export const AI_HOSTS = [
  "claude.ai", "chatgpt.com", "chat.openai.com", "platform.openai.com", "gemini.google.com", "aistudio.google.com",
  "chat.mistral.ai", "perplexity.ai", "console.anthropic.com", "copilot.microsoft.com", "chat.deepseek.com",
]

export const BROWSERS = ["chrome", "arc", "safari", "firefox", "brave", "edge", "opera", "vivaldi", "chromium"]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordsRe = (list: string[]) => new RegExp(`\\b(?:${list.map(escapeRe).join("|")})\\b`, "g")

const BROWSERS_RE = wordsRe(BROWSERS)

/** Retail banks (text without accents). Qonto, Mercury… are business banks: that is not private life. */
const BANKS = [
  "chase bank", "bank of america", "wells fargo", "citibank", "capital one", "barclays", "hsbc", "lloyds", "natwest", "santander",
  "monzo", "starling", "revolut", "n26", "chime", "ally bank",
]

/** Consumer apps: a weak signal (a real work context can mention them, e.g. "the WhatsApp Business API"). */
const PERSONAL_APPS = [
  "whatsapp", "messenger", "telegram", "imessage", "snapchat", "tinder", "bumble", "hinge", "grindr", "okcupid",
  "zocdoc", "netflix", "youtube", "spotify", "instagram", "facebook", "tiktok", "craigslist", "venmo", ...BANKS,
]
const PERSONAL_APPS_RE = wordsRe(PERSONAL_APPS)

/** App names that are ambiguous in a text ("error messages", "SIGTERM signal"): blocked only as an exact app name. */
const PERSONAL_APP_NAMES = ["messages", "signal", "facetime", "photos", "contacts"]

/**
 * Unambiguous private-life topics (text without accents, lowercase): a strong signal no work word excuses.
 * Topics a payroll, HR or accounting file may also mention (an employee's "sick leave", "my father" as a partner of the
 * bakery, "my bank account" at Qonto) are in SENSITIVE: excused by a real work context.
 */
const STRONG_PERSONAL: RegExp[] = [
  // relationships
  /\bmy (?:girlfriend|boyfriend|wife|husband|fiancee?|spouse|partner'?s? (?:birthday|parents)|significant other|ex-?(?:wife|husband|girlfriend|boyfriend))\b/g,
  /\bmy ex\b(?!-)/g,
  // health (one's own)
  /\b(?:my|see(?:ing)? (?:a|the|my)) (?:doctor|gp|dentist|physio|physiotherapist|chiropractor|osteopath|shrink|therapist|psychologist|psychiatrist|dermatologist|cardiologist|gynecologist|ob-?gyn|ophthalmologist|optometrist|pediatrician|midwife|orthodontist|neurologist|allergist|urologist|radiologist)\b(?! at work| for the team)/g,
  /\b(?:antidepressants?|anti-anxiety (?:meds|medication)|my depression|i'?m depressed|nervous breakdown|my burn-?out|i'?m burnt out|my prescription|blood (?:test|work)|my pregnancy|i'?m pregnant|\d+ (?:weeks|months) pregnant|miscarriage|chemotherapy|chemo|radiotherapy|herniated disc|blood sugar|diabetic|hypertension|hiv|hiv-positive|in the er|at the er|emergency room|my mri|an mri|my therapy|i'?m (?:sick|ill)|my sick (?:leave|day)|(?:i'?ve been|i'?m|i am) on (?:sick|medical) leave|(?:doctor|dentist|gp|physio|therapist|dermatologist|gynecologist|psychiatrist)(?:'s)? appointment|appointment with (?:my|the|a) (?:doctor|dentist|gp|physio|therapist)|my (?:maternity|paternity|parental) leave|(?:i was|got) diagnosed|my treatment for)\b/g,
  // personal legal matters (not a library's divorce() function)
  /\b(?:divorce(?!\s*\()|getting divorced|custody of (?:the|my) kids|child custody|family court)\b/g,
  // dating
  /\b(?:tinder|bumble|hinge|grindr|okcupid|dating (?:app|site|profile)|first date)\b/g,
  // personal finances
  /\b(?:my (?:personal|joint) (?:account|loan|credit card)|joint account|my mortgage|my (?:student|car|personal) loan|my savings account|my 401k|my ira|my roth|my (?:tax return|taxes)|my income tax|my credit score)\b/g,
]

/** Personal topics a work context can excuse (payroll, HR, accounting, family business). They count as weak signals. */
const SENSITIVE: RegExp[] = [
  // family ("child support": a wage garnishment also goes through payroll)
  /\b(?:my (?:mother|father|mom|mum|dad|parents|son|daughter|daughters|kid|kids|child|children|sister|sisters|brother|brothers|grandmother|grandfather|grandma|grandpa|grandparents|mother-in-law|father-in-law|in-laws|family|baby)|child support|alimony)\b/g,
  // health, leave
  /\b(?:sick leave|medical leave|burn-?out|depression|illness|sick|hospitali[sz]ed|hospitali[sz]ation|cancer|diabetes|fever|pregnancy|my period)\b/g,
  // personal legal matters
  /\b(?:my lawyer|my attorney|my (?:speeding|parking) ticket|my fine|points on my license|my driver'?s license)\b/g,
  // personal finances ("my business bank account", "my Chase business account", "my shareholder loan account" are accounting)
  new RegExp(String.raw`\bmy (?:checking|current|savings|bank|${BANKS.map(escapeRe).join("|")}) account(?! (?:for (?:the )?(?:business|company)|at work)\b)|\bmy (?:bank|banker|bank adviser|credit card|debit card|access code|customer number|online banking|bank statements?|rent|landlord|lease(?! (?:for the (?:shop|store|office)))|apartment|flat|house|home|health insurance|glasses)\b`, "g"),
]

/** Work vocabulary: it takes at least two points (one more per weak signal beyond the first). */
const WORK_HINTS = [
  "client", "clients", "customer", "customers", "project", "projects", "invoice", "invoices", "quote", "contract", "code", "api",
  "sdk", "bug", "deploy", "deployment", "production", "prod", "staging", "server", "endpoint", "webhook", "webhooks",
  "repo", "commit", "branch", "merge", "migration", "sql", "database", "ticket", "tickets", "sprint",
  "roadmap", "spec", "specs", "mockup", "backend", "frontend", "script", "function", "typescript", "javascript",
  "python", "react", "docker", "integration", "integrate", "bot", "prospect", "prospects", "crm", "cash flow", "accounting", "vat",
  "hiring", "component", "business", "team", "meeting",
  // HR and payroll
  "employee", "employees", "staff", "colleague", "colleagues",
  "hr", "benefits", "gusto", "rippling", "payfit", "deel", "process", "procedure", "handbook", "schedule",
  // accounting and corporate
  "accountant", "bookkeeping", "balance sheet", "forecast", "closing", "variance", "variances", "founder", "founders", "bylaws",
  "manager", "order", "orders", "inventory", "stock", "margin", "delivery", "deliveries",
  // marketing and sales
  "campaign", "campaigns", "ads", "marketing", "audience", "subscribers", "lookalike", "creatives", "carousel", "seo", "analytics",
  "pixel", "launch", "product", "products", "sale", "sales", "website", "newsletter", "statistics", "kpi",
]
const WORK_HINTS_RE = wordsRe(WORK_HINTS)
/**
 * Business-management words a private conversation also uses ("my electricity supplier", "an internship at a company",
 * "the payroll of my nanny"): one point each, like WORK_HINTS. Not one's own pay ("my pay"); "my company" counts: for a
 * founder, it is the business itself ("my company sells on Instagram").
 */
const WORK_GENERIC_RE = /\b(?:payroll|company|employer|suppliers?|vendors?|partners?|reconciliation|reconcile)\b/g
/**
 * Clearly professional signals: two points each. Phrases ("our store", "payslip", "supplier payment", "garnishment on their
 * pay", "business account", "shareholder loan account", "bank reconciliation") and business-management tools (Pennylane,
 * Qonto, QuickBooks, Xero). "supplier payment", "vendor transfer" and "bank reconciliation" only consume their first word:
 * "supplier" and "reconciliation" also count as work words.
 */
const WORK_STRONG_RE =
  /\b(?:our (?:[a-z]+ )?(?:channel|page|account|site|website|shop|store|brand|team|company|startup|app|application|product|offer|catalog|newsletter|client|clients|customers?)|our (?:subscribers|sales|products|teams|employees|staff|orders|suppliers|vendors|stores|shops)|sales channel|shareholders'? agreement|withholding tax|tax withholding|payroll tax(?:es)?|pay ?slips?|pay stubs?|employment contract|collective agreement|wage garnishments?|(?:supplier|vendor) (?:payments?|transfers?|invoices?)|garnishments? (?:on|from) (?:the |their |his |her )?(?:pay|salary|wages)|occupational (?:health|doctor)|pre-employment (?:medical|check)|(?:facebook|google|meta|instagram|linkedin|tiktok) ads|revenue|pennylane|qonto|quickbooks|xero|(?:payment|transfer)s?(?= (?:to )?(?:suppliers?|vendors?)\b)|bank(?= reconciliations?\b)|shareholder loan account|(?:business|company|corporate) (?:bank )?account)\b/g
/** Banking idioms ("customer number", "access code"): not work words. */
const BANK_IDIOMS_RE = /\b(?:(?:access|customer|pin|secret|security) code|(?:customer|client) (?:number|area|id))\b/g

function workScore(t: string): number {
  const s = t.replace(BANK_IDIOMS_RE, " ")
  const strong = new Set(matchesAll(WORK_STRONG_RE, s)).size
  const rest = s.replace(WORK_STRONG_RE, " ")
  return strong * 2 + new Set([...matchesAll(WORK_HINTS_RE, rest), ...matchesAll(WORK_GENERIC_RE, rest)]).size
}

/** Web pages that are not AI sessions, even when their title mentions Claude or Gemini. */
const NON_AI_PAGE_RE =
  /\b(?:gmail|outlook|inbox|webmail|mailbox|yahoo|proton ?mail|wikipedia|youtube|linkedin|reddit|twitter|facebook|horoscope|astrology)\b/

const AI_TITLE_RE =
  /^(?:claude(?:\.ai)?|claude code|chatgpt|chat ?gpt|chatgpt codex|codex|openai(?: platform| playground)?|anthropic console|google gemini|gemini|google ai studio|mistral(?: ai)?|le chat(?: mistral)?|perplexity(?: ai)?|copilot|microsoft copilot|deepseek)$/

const BROWSER_SUFFIX_RE =
  /\s[-–—|]\s(?:google chrome|chrome|chromium|mozilla firefox|firefox|safari|brave|microsoft edge|edge|opera|vivaldi|arc)\s*$/

function matchesAll(re: RegExp, text: string): string[] {
  re.lastIndex = 0
  return [...text.matchAll(re)].map((m) => m[0])
}

/** Consumer apps mentioned in a window title, excluding file or host names ("whatsapp-webhook.ts"). */
function appNamesInTitle(w: string): string[] {
  PERSONAL_APPS_RE.lastIndex = 0
  return [...w.matchAll(PERSONAL_APPS_RE)]
    .filter((m) => {
      const before = w[(m.index ?? 0) - 1] ?? ""
      const after = w[(m.index ?? 0) + m[0].length] ?? ""
      return !/[-_./]/.test(before) && !/[-_./]/.test(after)
    })
    .map((m) => m[0])
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

const TITLE_MAX = 300

/** Browser tab: accepted only when it is visibly an AI assistant (domain, or a "… - Claude" title). */
export function isAiBrowserWindow(windowName: string | undefined, browserUrl?: string): boolean {
  if (browserUrl) {
    const host = hostOf(browserUrl)
    return AI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  }
  const w = normalize(windowName ?? "").trim()
  if (!w || NON_AI_PAGE_RE.test(w)) return false
  // A real tab title is short: only its first 300 characters are split (splitting on "\s+ - \s+" re-reads
  // a long run of spaces from each of its positions).
  const segments = w
    .replace(BROWSER_SUFFIX_RE, "")
    .slice(0, TITLE_MAX)
    .split(/\s+[-–—|·:]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return false
  return AI_TITLE_RE.test(segments[0]) || AI_TITLE_RE.test(segments[segments.length - 1])
}

/**
 * True if the content of this window may be read. Whole words only: "messages.ts" or a "signal" tab
 * in a terminal are not messaging apps. `browserUrl` (optional): the tab URL when Screenpipe provides it.
 */
export function isAllowedApp(app: string | undefined, windowName: string | undefined, whitelist = DEFAULT_APP_WHITELIST, browserUrl?: string): boolean {
  const a = normalize(app ?? "").trim()
  const w = normalize(windowName ?? "").trim()
  if (!a && !w) return false
  if (PERSONAL_APP_NAMES.includes(a)) return false
  if (matchesAll(PERSONAL_APPS_RE, a).length || appNamesInTitle(w).length) return false
  if (STRONG_PERSONAL.some((re) => matchesAll(re, plainText(w)).length > 0)) return false
  if (matchesAll(BROWSERS_RE, a).length) return isAiBrowserWindow(windowName, browserUrl)
  return whitelist.some((x) => a.includes(normalize(x)))
}

export type PersonalSignals = { strong: string[]; weak: string[]; work: number }

const plainText = (text: string) => normalize(text).replace(/[’`]/g, "'")

/** Signals, plus the number of distinct weak topics (each consumer app, each SENSITIVE family). */
function signals(text: string): PersonalSignals & { topics: number } {
  const t = plainText(text)
  const strong = [...new Set(STRONG_PERSONAL.flatMap((re) => matchesAll(re, t)))]
  const apps = [...new Set(matchesAll(PERSONAL_APPS_RE, t))]
  const sensitive = SENSITIVE.map((re) => [...new Set(matchesAll(re, t))]).filter((hits) => hits.length > 0)
  const weak = [...new Set([...apps, ...sensitive.flat()])]
  return { strong, weak, work: workScore(t), topics: apps.length + sensitive.length }
}

/**
 * Personal-content cues found in a text (to decide, and to explain it in simulation).
 * strong: unambiguous private-life topic; weak: consumer app or sensitive topic a work context excuses;
 * work: professional vocabulary score.
 */
export function personalSignals(text: string): PersonalSignals {
  const { strong, weak, work } = signals(text)
  return { strong, weak, work }
}

/**
 * True if the text looks like personal content we would rather ignore entirely.
 * One private-life topic (health, relationship, divorce…) is enough. A weak signal (consumer app, sick leave, family,
 * bank account…) only counts without a real work context: 2 points of work vocabulary, one more per distinct weak topic
 * beyond the first ("sick" and "sick leave" are one topic).
 */
export function looksPersonal(text: string): boolean {
  const s = signals(text)
  if (s.strong.length > 0) return true
  return s.topics > 0 && s.work < Math.max(2, s.topics + 1)
}

// ---------------------------------------------------------------------------------------------------------------------
// Redaction of secrets and personal data.

type Ctx = { input: string; offset: number }
type Rule = {
  name: string
  re: RegExp
  /** Replacement text ($1… = groups), or a function; `null` = false positive, the text is kept. */
  replace: string | ((match: string, groups: (string | undefined)[], ctx: Ctx) => string | null)
  check?: (match: string, ctx: Ctx) => boolean
}
/** Rule with a manual scan: when a regex alone would swallow the next pair ("user:admin,password:…"). */
type ScanRule = { name: string; scan: (text: string) => { text: string; count: number } }

const MASK = "[redacted]"
const SECRET = "[secret redacted]"
const TOKEN = "[token redacted]"

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

/** IBAN: look for the longest valid prefix (mod 97 check), so as not to swallow the next word. */
function maskIban(match: string): string | null {
  const parts = match.split(/(?=[\s-][A-Z0-9])/i)
  for (let n = parts.length; n >= 1; n--) {
    const head = parts.slice(0, n).join("")
    if (ibanValid(head)) return "[IBAN redacted]" + parts.slice(n).join("")
  }
  // IBAN format in uppercase but a wrong check digit (typo): redact anyway.
  for (let n = parts.length; n >= 4; n--) {
    const head = parts.slice(0, n).join("")
    if (/^[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){3,}(?: [A-Z0-9]{1,4})?$/.test(head)) return "[IBAN redacted]" + parts.slice(n).join("")
  }
  return null
}

/** French social security number (NIR): key = 97 − (first 13 digits mod 97), Corsica 2A / 2B counting as 19 / 18. */
function nirValid(raw: string): boolean {
  const s = raw.replace(/[\s.]/g, "").toUpperCase()
  if (s.length !== 15) return false
  const dept = s.slice(5, 7)
  const body = s.slice(0, 5) + (dept === "2A" ? "19" : dept === "2B" ? "18" : dept) + s.slice(7, 13)
  if (!/^\d{13}$/.test(body) || !/^\d{2}$/.test(s.slice(13))) return false
  return 97n - (BigInt(body) % 97n) === BigInt(s.slice(13))
}

const NIR_CONTEXT_RE = /(?:social security|\bNIR\b|INSEE|\bSSN\b|national insurance)/i

/** US social security number (123-45-6789), announced as such: a bare 3-2-4 group of digits can be anything. */
const SSN_CONTEXT_RE = /(?:social security|\bSSN\b|\bSS#|\bSS no)/i

function basicAuthLooksReal(b64: string): boolean {
  try {
    const decoded = Buffer.from(b64, "base64").toString("latin1")
    return /^[\x20-\x7e]{1,200}:[\x20-\x7e]{1,200}$/.test(decoded)
  } catch {
    return false
  }
}

/** Words that often follow "password:" or "token:" without being a secret. */
const PROSE_WORDS = new Set(
  (
    "the a an is are was were to in on at of for and or not see here none yes no it this that its my your our their his her " +
    "be by with without from as same empty identical below above"
  ).split(/\s+/),
)

/** Values that are not secrets: types, keywords, environment variables, templates, already redacted values. */
const PLACEHOLDER_RE =
  /^(?:\[|<|\{\{|\$\{|\$\(|\$[A-Z_][A-Z0-9_]*$|%[A-Z_(]|\*+$|[xX]{3,}$|•+$|.*\.{3}$|…|process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|env\(|env\.|secrets\.|vault:|(?:[Yy]our|YOUR)[-_ ]\w)/
const NON_SECRET_RE =
  /^(?:true|false|null|none|nil|undefined|str|string|number|int|integer|float|bool|boolean|bytes|any|unknown|object|optional|required|await|new|typeof|function|async|return|this|self|lambda|const|let|var|uuid|jwt|text|varchar|char|hash|hashed|bcrypt|argon2(?:id)?|include|omit|same-origin|mandatory)$/i

function plausibleSecret(value: string, quoted: boolean): boolean {
  const v = value.trim()
  if (v.length < 3 || PLACEHOLDER_RE.test(v) || NON_SECRET_RE.test(v)) return false
  if (quoted) return true
  if (PROSE_WORDS.has(v.toLowerCase())) return false
  // An accented word ("café", "résumé") is not a password.
  if (/^[a-zà-ÿ]+$/i.test(v) && /[à-ÿ]/i.test(v)) return false
  // Types and code calls: Optional[str], Promise<string>, getToken(), cfg.token, req.headers.authorization
  if (/^(?:Optional|List|Dict|Union|Record|Array|Promise|Map|Set)\b/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*$/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[,;)]*$/.test(v)) return false
  // A variable holding the secret: "password: hashedPassword", "token = accessToken", "pwd = db_password".
  if ((/^[a-z]+(?:[A-Z][a-z]*)+$/.test(v) || /^[a-z]+(?:_[a-z]+)+$/.test(v)) && isSecretKey(v)) return false
  return true
}

/** A "strong" password: a digit or a symbol, or a capital in the middle ("Fournil2026", "Qwerty!", "MyPass"). */
function strongish(v: string): boolean {
  return /[A-Za-z]/.test(v) && (/[\d!@#$%^&*_+=?~\-]/.test(v) || /[A-Z]/.test(v.slice(1)))
}

/**
 * A value that looks like a secret rather than a word: at least 6 characters, a letter, and a digit or a symbol
 * ("Fournil2026", "S3cret!42", "p@ssword"). End-of-sentence punctuation ("forgotten?", "changed!") does not count,
 * nor "_" or "-" ("created_at", "back-office").
 */
function secretLike(v: string): boolean {
  const s = v.slice(0, trailingRunStart(v, "!?.,;:"))
  return s.length >= 6 && /[A-Za-z]/.test(s) && /[\d!@#$%^&*+=?~]/.test(s)
}

/**
 * Start of the run of `chars` characters that ends `v` (v.length if there is none). A loop from the end, not a regex
 * anchored on "$": on a long run of "." or "!" that does not end the value, the regex would re-scan it
 * from every position (quadratic cost).
 */
function trailingRunStart(v: string, chars: string): number {
  let i = v.length
  while (i > 0 && chars.includes(v[i - 1])) i--
  return i
}

/** "incorrect!", "forgotten?": the final "!" or "?" of a lowercase word punctuates the sentence. */
function sentencePunct(value: string, tail: string): [string, string] {
  const m = /^([a-zà-ÿ]+)([!?]+)$/.exec(value)
  return m ? [m[1], m[2] + tail] : [value, tail]
}

/** Linking words: after "password", they introduce prose ("for the Office365 account", "is stored in…"). */
const LINK_WORDS = new Set([
  ...PROSE_WORDS,
  ..."has had have been being will would should can could must may might via into onto through who which that expires expired stored kept saved changed reset".split(" "),
])

/** Common word endings ("mandatory", "necessary", "incorrect"…): not a password. */
const WORD_SUFFIX_RE = /(?:ory|ary|able|ible|ment|tion|sion|ness|ful|less|ous|ive|ing|ed|ly|ure|ism|ist|ity|ant|ent|al|er|es)$/

const SECRET_WORDS = new Set([
  "password", "passwd", "passw", "pswd", "pwd", "pw", "pass", "passphrase", "passwort", "kennwort", "contrasena", "contraseña", "senha",
  "wachtwoord", "secret", "token", "credential", "credentials", "apikey", "cookie", "cvv", "cvc",
])
const KEY_PREFIXES = new Set([
  "api", "access", "secret", "private", "auth", "signing", "encryption", "master", "license", "licence", "client", "app",
  "service", "account", "consumer", "session", "storage", "subscription", "sas", "webhook", "deploy", "ssh", "gpg", "pgp", "admin", "root",
])
const KEY_SUFFIXES = new Set(["base", "value", "b64", "base64", "hex", "raw", "enc", "encoded", "plain"])

/** Does the key name denote a secret? (DB_PASSWORD, clientSecret, x-api-key, aws_secret_access_key…) */
export function isSecretKey(key: string): boolean {
  if (key === "PWD" || key === "OLDPWD") return false // the shell's current directory
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
  if (SECRET_WORDS.has(last) || /(?:password|passwd|passphrase|secret|token|apikey)$/.test(last)) return true
  if (last === "key" && prev && KEY_PREFIXES.has(prev)) return true
  if (last === "id" && prev === "key" && parts[parts.length - 3] === "private") return true
  return /^[A-Z][A-Z0-9_]*_KEY\d*$/.test(key)
}

/** Secret URL parameters isSecretKey does not recognize on its own ("?key=", "&sig="). */
const URL_SECRET_PARAMS = new Set([
  "key", "sig", "signature", "auth", "apikey", "api-key", "pass", "session", "sessionid", "session_id", "sid", "jwt",
  "x-amz-signature", "x-amz-security-token", "x-goog-signature", "code_verifier",
])

/** Splits the trailing punctuation off an unquoted value ("pwd: qwerty12, then…"). */
function splitTrailing(v: string): [string, string] {
  const i = trailingRunStart(v, ",;:.)]}")
  return i < v.length && i >= 3 && !/[\n\r\u2028\u2029]/.test(v) ? [v.slice(0, i), v.slice(i)] : [v, ""]
}

const SECRET_CONTEXT_RE = /(?:aws|secret|access[ _-]?key|\bkey\b|credential|password)/i

/** Random string (AWS key without context): a digit, and many lowercase ↔ uppercase switches. */
function looksRandom(s: string): boolean {
  if (!/\d/.test(s)) return false
  let switches = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]
    const b = s[i]
    if ((/[a-z]/.test(a) && /[A-Z]/.test(b)) || (/[A-Z]/.test(a) && /[a-z]/.test(b))) switches++
  }
  return switches >= 8
}

// --- Key = value pairs (env, YAML, JSON, code, HTTP headers) --------------------------------------------------------

const KV_RE = /(["'`]?)\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_.\-]{0,60})\1(\??\s*(?:=>|->|:=|=|:(?!\/\/))[ \t]*)/g
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "`": "`", "«": "»", "“": "”" }
/** In a bare value, the next pair ("&format=csv", ",user: x", "; Path=/") is not part of the secret. */
const NEXT_PAIR_RE = /[&,;}](?=\s*["']?[A-Za-z_][\w.\-]*["']?\s*[:=])/

type KvValue = { raw: string; inner: string; open: string; close: string }

/** Maximum length of a value (quoted or bare): an AWS session token is ~1,000. */
const KV_VALUE_MAX = 2000

/**
 * Last unsuccessful search for a closing quote, per closing character: how far it read (`next`, the position
 * it would have examined next) and why it stopped. A search starting further on, before `next`, examines
 * exactly the same positions (the opening quote is not a backslash, so escapes stay aligned): it resumes at `next`
 * instead of re-reading. Without this, a repeated `password: "` re-reads 2,000 characters per key.
 */
type QuoteMiss = { from: number; next: number; limited: boolean }

function readValue(input: string, at: number, misses: Map<string, QuoteMiss> = new Map()): KvValue | null {
  const open = input[at] ?? ""
  const close = QUOTES[open]
  if (close) {
    const limit = Math.min(input.length, at + KV_VALUE_MAX)
    let i = at + 1
    const miss = misses.get(close)
    if (miss && miss.from < at && at < miss.next) {
      // Same reading as the previous search up to `next`: nothing to find there.
      if (!miss.limited) return null
      i = miss.next
    }
    for (; i < limit; i++) {
      const c = input[i]
      if (c === "\n") {
        misses.set(close, { from: at, next: i, limited: false })
        return null
      }
      if (c === "\\") {
        i++
        continue
      }
      if (c === close) return { raw: input.slice(at, i + 1), inner: input.slice(at + 1, i), open, close }
    }
    misses.set(close, { from: at, next: i, limited: i < input.length })
    return null
  }
  const m = /^[^\s"'`<>]+/.exec(input.slice(at, at + KV_VALUE_MAX))
  if (!m) return null
  let raw = m[0]
  const cut = NEXT_PAIR_RE.exec(raw)
  if (cut && cut.index > 0) raw = raw.slice(0, cut.index)
  return { raw, inner: raw, open: "", close: "" }
}

function maskKvValue(input: string, at: number, v: KvValue): string | null {
  if (v.open) return plausibleSecret(v.inner, true) ? `${v.open}${MASK}${v.close}` : null
  if (PLACEHOLDER_RE.test(v.raw)) return null // "sk_test_..."
  const [value, tail] = splitTrailing(v.raw)
  if (!plausibleSecret(value, false)) return null
  // A link, not the value ("Forgot password: https://app…/reset"); credentials inside a URL have their own rule.
  if (/^[a-z][a-z0-9+.\-]{1,15}:\/\//i.test(value)) return null
  const rest = input.slice(at + v.raw.length, at + v.raw.length + 40)
  // "credentials: admin / S3cret!": a login / password pair, handled by credentials_pair (the login stays readable).
  if (/^[ \t]{0,64}\/[ \t]/.test(rest)) return null
  // Prose, not a value: "password: min 12 characters", "token: signed JWT", "secret: share it early".
  if ((/^[a-zà-ÿ]+$/.test(value) || /^[A-Z]{2,5}$/.test(value)) && /^[ \t]+[A-Za-zÀ-ÿ0-9]/.test(rest)) return null
  return `${MASK}${tail}`
}

function scanKeyValues(input: string): { text: string; count: number } {
  let out = ""
  let last = 0
  let count = 0
  const misses = new Map<string, QuoteMiss>()
  KV_RE.lastIndex = 0
  for (let m = KV_RE.exec(input); m; m = KV_RE.exec(input)) {
    // Non-secret key: resume right after the separator, without consuming the value (which may contain the next pair).
    if (!isSecretKey(m[2])) continue
    const at = m.index + m[0].length
    const v = readValue(input, at, misses)
    if (!v) continue
    const masked = maskKvValue(input, at, v)
    if (masked === null) continue
    out += input.slice(last, at) + masked
    last = at + v.raw.length
    KV_RE.lastIndex = last
    count++
  }
  return { text: out + input.slice(last), count }
}

// --- PEM private keys -----------------------------------------------------------------------------------------------

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
const PEM_BODY_RE = /[A-Za-z0-9+/=\s\\]*/y

/**
 * PEM private key, up to its "-----END …" (10,000 characters at most: an 8192-bit RSA key is ~6,500), or, when truncated,
 * up to the end of its base64 body. Linear: the search for the next "END" is never redone backwards.
 */
function scanPrivateKeys(input: string): { text: string; count: number } {
  let out = ""
  let last = 0
  let count = 0
  let end: RegExpExecArray | null = null
  let noMoreEnd = false
  PEM_BEGIN_RE.lastIndex = 0
  for (let m = PEM_BEGIN_RE.exec(input); m; m = PEM_BEGIN_RE.exec(input)) {
    const from = m.index + m[0].length
    if (!noMoreEnd && (!end || end.index < from)) {
      PEM_END_RE.lastIndex = from
      end = PEM_END_RE.exec(input)
      noMoreEnd = end === null
    }
    let stop: number
    if (end && end.index >= from && end.index - from <= 10000) stop = end.index + end[0].length
    else {
      PEM_BODY_RE.lastIndex = from
      stop = from + (PEM_BODY_RE.exec(input)?.[0].length ?? 0)
    }
    out += input.slice(last, m.index) + "[private key redacted]"
    last = stop
    PEM_BEGIN_RE.lastIndex = Math.max(stop, from)
    count++
  }
  return { text: out + input.slice(last), count }
}

// --- Rules ----------------------------------------------------------------------------------------------------------

/**
 * Command-line options carrying a password: `mysql -pXXX`, `sshpass -p`, `redis-cli -a`, `docker login -p`…
 * Between the command and the option: at most 12 arguments of 200 characters (bounded scan, hence linear, even on a long
 * line of minified JSON that mentions "mongo" or "mysql" thousands of times).
 */
const CLI_ARGS = String.raw`(?:[ \t]+[^\s|;&]{1,200}){0,12}?`
const cliRe = (cmd: string, flag: string) => new RegExp(String.raw`\b((?:${cmd})\b${CLI_ARGS}[ \t]+${flag})(["']?)([^\s"']+)\2`, "g")
const CLI_PASSWORD_RES = [
  cliRe("mysql|mysqldump|mysqladmin|mariadb|mariadb-dump", String.raw`-p(?![\s-])`),
  /\b(sshpass\s+-p\s*)(["']?)([^\s"']+)\2/g,
  cliRe("redis-cli|keydb-cli", String.raw`-a[ \t]+`),
  cliRe(String.raw`(?:docker|podman|nerdctl|helm)[ \t]+(?:registry[ \t]+)?login`, String.raw`-p[ \t]+`),
  cliRe("mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport", String.raw`-p[ \t]+`),
  cliRe("sqlcmd", String.raw`-P[ \t]*`),
]

// --- Secrets spelled out ("the password is: …") -----------------------------------------------------------------------
// Every repetition is bounded, two repetitions accepting the same character never follow each other (a word or a
// mandatory character separates them), and the branches of one repetition are exclusive: the cost stays linear, even
// on 32 KB of spaces, line breaks, non-breaking spaces or abbreviations ("cf.cf.cf.") after the keyword.

/** Horizontal space: any whitespace except a line end (tab, non-breaking space, thin space before ":"…). */
const H = String.raw`[^\S\r\n]`
/** Whitespace, line ends included ("password\n: …", "is:␣␣␣…␣X"): a single repetition per gap. */
const WS = String.raw`\s{0,64}`
/**
 * A dot between the keyword and the separator: inside a domain name or a version ("pennylane.com", "v2.1"), or after an
 * abbreviation ("cf. docs", "e.g."). One branch only (the assertion creates no choice): no exponential backtracking
 * on "cf.cf.cf.…".
 */
const GAP_DOT = String.raw`\.(?=[^\s.!?:=]|(?<=\b(?:cf|ex|env|resp|ref|etc|vs|eg|ie|e\.g|i\.e)\.))`
/**
 * Between the keyword and the separator (`n` characters at most, shortest first): neither a line end nor sentence
 * punctuation, and it ends on a visible character, so the following whitespace (WS) never overlaps its own.
 */
const kwGap = (n: number) => String.raw`(?:(?:[^\n.!?:=]|${GAP_DOT}){0,${n - 1}}?(?:[^\s.!?:=]|${GAP_DOT}))??`
/** ":" (not a URL's, "https://"), "=", "=>", an arrow. */
const SEP_SYM = String.raw`(?:=>|:(?!\/\/)|=|[-—–]{1,3}>|→)`
const SEP_VERB = String.raw`(?:\b(?:is|was|will be|remains|reads)\b|(?<=[A-Za-z])['’]s\b)`
/** End of a word (accented letters, apostrophe and hyphen included): "now" but not "Now2026" nor "now-ish". */
const WORD_END = String.raw`(?![\wà-ÿ'’\-])`
/** Adverbs between the verb and the value, without ":" ("is now Fournil2026", "is still …"). */
const ADVERBS = String.raw`now|still|currently|also|then|actually|always|again`
/**
 * Filler words between the verb and ":": a closed list of function words, adverbs and words a password is not
 * ("is now:", "is the following:", "is still the same:", "is as follows:").
 * Not just any word: "is SunnyGreen: don't share it" has SunnyGreen as its value, not "don't".
 */
const FILLER = String.raw`(?:${ADVERBS}|the|same|following|as|follows|below|here|just|simply|this|one|set|to|new|[a-z]{2,20}ly|simple|for|a|an|by|default|currently|at|moment|of|course)${WORD_END}`
/**
 * Separator between the keyword and the value (a group, plus an inner group for the adverbs), preceded by whitespace:
 * - ":", "=", "=>" or an arrow;
 * - a verb, then 0 to 4 filler words and ":" ("is:", "is now:", "is the following:");
 * - a verb, optionally followed by one or two adverbs, then the value ("is Fournil2026", "is now Fournil2026").
 * Each word is followed by its own whitespace: two whitespace repetitions never touch.
 */
const SEP = String.raw`(${WS}(?:${SEP_SYM}${WS}|${SEP_VERB}(?:\s{0,16}(?:${FILLER}\s{0,16}){0,4}${SEP_SYM}${WS}|\s{1,64}((?:(?:${ADVERBS})${WORD_END}\s{1,64}){1,2})?)))`
const PASSWORD_KW = String.raw`passwords?|passwd|pwd|passwort|pass ?phrase|(?:secret|access|wi-?fi) code|wi-?fi password`
const SECRET_KW = String.raw`api keys?|api[ -]?key|secret key|access key|client secret|token|secret`
/** Quoted value (opening, content, closing: the content keeps its spaces, see quotedParts) or bare value. */
const QUOTED_OR_BARE = String.raw`(?:([«“"'\`])((?:${H}{0,3}\r?\n)?[^«»“”"'\`\n]{1,86}(?:\r?\n${H}{0,3})?)([»”"'\`])|([^\s"'»”\`]{1,200}))`

/** Splits the edge whitespace off a quoted content (5 at most on each side, line break included): `"  Fournil 2026  "`. */
function quotedParts(inner: string): [string, string, string] {
  let a = 0
  while (a < 5 && a < inner.length - 1 && /\s/.test(inner[a])) a++
  let b = inner.length
  while (inner.length - b < 5 && b - 1 > a && /\s/.test(inner[b - 1])) b--
  return [inner.slice(0, a), inner.slice(a, b), inner.slice(b)]
}

/** "is mandatory", "is incorrect": a common word is not a password; "sunnygreenhill" or "Qwerty123!" is. */
function looksPassword(value: string): boolean {
  return strongish(value) || /^\d{4,8}$/.test(value) || (/^[a-z]{10,}$/.test(value) && !WORD_SUFFIX_RE.test(value))
}

/** Version number ("v2.3.1-beta4", "1.2.0"): not a secret, even when announced ("the token is now v2.3.1-beta4"). */
const VERSION_RE = /^v?\d{1,4}(?:\.\d{1,4}){1,3}(?:-[0-9A-Za-z.]{1,20})?$/i

/**
 * Where to find the secret, not the secret: a URL ("is here: https://vault…", credentials inside a URL have their own rule)
 * or a path ("is still: config/db-prod.env", "is here: projects/fournil/secrets/db").
 */
function looksLocator(value: string): boolean {
  if (/^[a-z][a-z0-9+.\-]{1,15}:\/\//i.test(value)) return true
  // A path: short segments, without "+" or "=", at least one of them a lowercase word ("config", "secrets").
  // A base64 token also has "/", but its segments are long and mixed ("iNzzXQ…/4Wneq…").
  const parts = value.split("/")
  if (parts.length < 2 || parts.some((p) => !/^[\w.\-]{1,40}$/.test(p))) return false
  return (parts.length > 2 || /\.[a-z]{1,5}$/i.test(value)) && parts.some((p) => /^[a-z][a-z_.\-]{2,}$/.test(p))
}

const RULES: (Rule | ScanRule)[] = [
  { name: "private_key", scan: scanPrivateKeys },
  {
    // user:password@host — the password may contain "/" or "@": go up to the last "@" followed by a host.
    name: "url_credentials",
    re: /\b([a-z][a-z0-9+.\-]{0,30}:\/\/)([^\s:/]{1,200}?):(\S{1,200}?)@(?=[A-Za-z0-9.\-]+(?::\d+)?(?:[/?#\s"'<>)\],;]|$))/gi,
    replace: (m, g) => (/^\d{1,5}\//.test(g[2] ?? "") ? null : `${g[0]}[credentials redacted]@`),
  },
  { name: "webhook_url", re: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/\-]+/g, replace: "[webhook redacted]" },
  { name: "webhook_url", re: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_\-]+/g, replace: "[webhook redacted]" },
  { name: "webhook_url", re: /https?:\/\/[a-z0-9.\-]*webhook\.office\.com\/[^\s"'<>]+/gi, replace: "[webhook redacted]" },
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
    // "eyJ…" header, payload, signature. Only at the start of a run of base64url characters (not at every
    // "-eyJ" of a long run without a dot: linear), bounded segments.
    name: "jwt",
    re: /(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{10,4096}\.(?:eyJ[A-Za-z0-9_\-]{5,16384}(?:\.[A-Za-z0-9_\-]{0,4096})?|[A-Za-z0-9_\-]{10,16384}\.[A-Za-z0-9_\-]{10,4096})/g,
    replace: TOKEN,
  },
  // The brain's personal token (cb_ + 32 base64url characters); "cb_on_message_handler" is an identifier.
  {
    name: "brain_token",
    re: /\bcb_[A-Za-z0-9_\-]{16,}/g,
    replace: TOKEN,
    check: (m) => {
      const rest = m.slice(3)
      if (/^[a-z0-9_]+$/.test(rest) && rest.includes("_")) return false // snake_case identifier (cb_before_commit_v2)
      return /[A-Z0-9\-]/.test(rest) || rest.length >= 24
    },
  },
  {
    name: "auth_header",
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["'`]?)(?:(Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|AWS4-HMAC-SHA256|SSWS)\s+)?(?!\[|<|\$\{|(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|SSWS)\s)([^\s"'`,;]{6,})/gi,
    replace: (m, g) => {
      const [head, scheme, value = ""] = g
      if (PLACEHOLDER_RE.test(value)) return null // "Bearer YOUR_TOKEN"
      // Without a scheme, a word is not a token: "Authorization: header missing", "authorization: required".
      if (!scheme && (!plausibleSecret(value, false) || (/^[A-Za-zÀ-ÿ]+$/.test(value) && !/[A-Z]/.test(value.slice(1))))) return null
      return `${head}${scheme ? `${scheme} ` : ""}${MASK}`
    },
  },
  {
    name: "basic_auth",
    re: /\b(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g,
    replace: (m, g) => (basicAuthLooksReal(g[1] ?? "") ? `${g[0]}${MASK}` : null),
  },
  {
    name: "bearer",
    re: /\b(Bearer|Token)\s+(?!\[)([A-Za-z0-9._~+/\-]{16,}=*)/gi,
    replace: (m, g) => (/^bearer$/i.test(g[0] ?? "") || /\d/.test(g[1] ?? "") ? `${g[0]} ${TOKEN}` : null),
  },
  {
    // ?api_key=…, &access_token=…, &pwd=…, ?sig=… (before key=value pairs, which do not know where a URL ends).
    name: "url_param",
    re: /([?&;]([A-Za-z][A-Za-z0-9_.\-]{0,40})=)([^&#;\s"'`<>]+)/g,
    replace: (m, g) => {
      const key = g[1] ?? ""
      const value = g[2] ?? ""
      const secretKey = isSecretKey(key)
      if (!secretKey && !URL_SECRET_PARAMS.has(key.toLowerCase())) return null
      // "?key=created_at", "?auth=google", "?pass=true", "?key=value": ordinary values. A secret has a digit
      // or a symbol; a long word without a digit only counts behind a real secret name ("?token=abcdefghijkl").
      const shaped = value.length >= 6 && /[A-Za-z0-9]/.test(value) && /[\d%+/=~!@#$*]/.test(value)
      const longWord = secretKey && /^[A-Za-z]{8,}$/.test(value)
      return (shaped || longWord) && plausibleSecret(value, true) ? `${g[0]}${MASK}` : null
    },
  },
  // KEY=value, key: "value", "key": "value", --key=value, key => value, key -> value.
  { name: "env_secret", scan: scanKeyValues },
  {
    // <password>…</password>
    name: "xml_secret",
    re: /<([A-Za-z_][\w.\-:]{0,60})>([^<\n]{1,200})<\/\1>/g,
    replace: (m, g) => (isSecretKey((g[0] ?? "").split(":").pop() ?? "") && plausibleSecret((g[1] ?? "").trim(), true) ? `<${g[0]}>${MASK}</${g[0]}>` : null),
  },
  {
    // auth=('admin', 'password'), HTTPBasicAuth("admin", "password")
    name: "auth_tuple",
    re: /\b((?:HTTPBasicAuth|HTTPDigestAuth|BasicAuth|auth)\s*(?:=\s*)?\(\s*)(["'])([^"'\n]{0,100})\2(\s*,\s*)(["'])([^"'\n]{1,200})\5/g,
    replace: (m, g) => (plausibleSecret(g[5] ?? "", true) ? `${g[0]}${g[1]}${g[2]}${g[1]}${g[3]}${g[4]}${MASK}${g[4]}` : null),
  },
  {
    // --password s3cret, --token xyz (the --key=value form is handled by key=value pairs).
    name: "cli_secret",
    re: /(--?(?:password|passwd|pass|pwd|token|secret|api-key|apikey|api_key|access-token|auth-token|client-secret)\s+)(["']?)(?!-)([^\s"']+)\2/gi,
    replace: (m, g) => (plausibleSecret(g[2] ?? "", Boolean(g[1])) ? `${g[0]}${g[1]}${MASK}${g[1]}` : null),
  },
  {
    name: "cli_secret",
    re: /(\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g,
    replace: (m, g) => (plausibleSecret(g[2] ?? "", true) ? `${g[0]}${g[1]}:${MASK}` : null),
  },
  ...CLI_PASSWORD_RES.map(
    (re): Rule => ({ name: "cli_secret", re, replace: (m, g) => (plausibleSecret(g[2] ?? "", true) ? `${g[0]}${g[1]}${MASK}${g[1]}` : null) }),
  ),
  {
    // "credentials: admin / Fournil2026!", "login admin / S3cret!"
    name: "credentials_pair",
    re: /\b(credentials|logins?|access|user\s{0,8}\/\s{0,8}pass(?:word)?)\b(\s{0,64}[:=]\s{0,64}|\s{1,64})([^\s/:,;]{1,64})(\s{0,64}\/\s{0,64})([^\s"',;]{1,200})/gi,
    replace: (m, g) => {
      const [value, tail] = splitTrailing(g[4] ?? "")
      // a path ("access/admin/index.js") is not a login / password pair
      if (/\.[a-z]{1,5}$/i.test(value) || value.includes("/")) return null
      // "credentials: EIN / VAT", "Logins: Google / Microsoft": words, not a password.
      return plausibleSecret(value, false) && secretLike(value) ? `${g[0]}${g[1]}${g[2]}${g[3]}${MASK}${tail}` : null
    },
  },
  {
    // Spelled out: "the ssh root password is Qwerty123!", "pwd: …" is a key=value pair, "the password is now: …",
    // "the password for pennylane.com: …", "is the following: …".
    name: "password_text",
    re: new RegExp(String.raw`\b(${PASSWORD_KW})\b(${kwGap(60)})${SEP}${QUOTED_OR_BARE}`, "gi"),
    replace: (m, g) => {
      const [kw, mid, sep, adverbs, open, inner, close, bare] = g
      if (inner !== undefined) {
        const [lead, quoted, trail] = quotedParts(inner)
        return plausibleSecret(quoted, true) ? `${kw}${mid}${sep}${open}${lead}${MASK}${trail}${close}` : null
      }
      const [value, tail] = sentencePunct(...splitTrailing(bare ?? ""))
      // After an adverb without ":" ("is now …"), the value must look like a secret ("is now mandatory" stays readable).
      const shaped = adverbs ? secretLike(value) : looksPassword(value)
      return plausibleSecret(value, false) && shaped && !VERSION_RE.test(value) && !looksLocator(value) ? `${kw}${mid}${sep}${MASK}${tail}` : null
    },
  },
  {
    // PIN code: "PIN code: 4589", "PIN = "4589"", "My PIN is "4589"", "my pin's 4589", "Pin: 4589".
    // "PIN" in capitals, "pin code", a determiner + "pin", or "Pin" / "pin" glued to the separator, then 4 to 8
    // digits: "Pin the react version: react@18.3.1", "We pin dependencies: …" stay readable, like a date
    // ("PIN: 2024-10-17").
    name: "password_text",
    re: new RegExp(
      String.raw`\b((?:[Pp]in|PIN)\s{1,3}(?:[Cc]ode|CODE|[Nn]umber)|PIN|(?:[Mm]y|[Yy]our|[Oo]ur|[Tt]he|[Hh]is|[Hh]er|[Tt]heir)${H}{1,3}[Pp]in|[Pp]in(?=${H}{0,3}[:=]))\b(${kwGap(30)})${SEP}` +
        String.raw`(?:([«“"'\`]${H}{0,3})(\d{4,8})(${H}{0,3}[»”"'\`])|(\d{4,8})(?!\w|[-/.:]\d))`,
      "g",
    ),
    replace: (m, g) => (g[4] !== undefined ? `${g[0]}${g[1]}${g[2]}${g[4]}${MASK}${g[6]}` : `${g[0]}${g[1]}${g[2]}${MASK}`),
  },
  {
    // Without a separator: "with the password Fournil2026!", "password root S3cret!42".
    // A value that looks like a secret (a digit, or a symbol inside), right after the keyword or after one or two
    // qualifiers ("root", "wifi", "temporary"); "for the Office365 account", "on Windows11", "is stored in
    // 1Password", "forgotten?", "changed!" stay prose.
    name: "password_text",
    re: /\b(passwords?|passwd|passwort)([ \t]{1,64}(?:[a-zà-ÿ'’\-]{1,15}[ \t]{1,64}){0,2}?)(?!(?:sha|md|bcrypt|argon|scrypt|pbkdf|aes|rsa|hs|rs|es|utf|iso|rfc|tls|ssl|wpa|wep|v)[-_]?\d)(?=[^\s"'»”]{0,200}(?:\d|[!@#$%^&*+=?~][^\s"'»”,.;:!?)\]]))(?=[^\s"'»”]{0,200}[A-Za-z])([^\s"'»”]{6,200})/gi,
    replace: (m, g) => {
      const [kw, mid, raw] = g
      const words = (mid ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (words.some((w) => LINK_WORDS.has(w) || /['’]/.test(w))) return null
      const [value, tail] = splitTrailing(raw ?? "")
      return secretLike(value) && plausibleSecret(value, false) ? `${kw}${mid}${MASK}${tail}` : null
    },
  },
  {
    // "The API key is: …", "the token is the following: …", "the secret is …": a long value, letters and digits.
    name: "secret_text",
    re: new RegExp(String.raw`\b(${SECRET_KW})\b(${kwGap(30)})${SEP}(["'«“\`]\s{0,3})?([^\s"'»”\`]{1,200})`, "gi"),
    replace: (m, g) => {
      const [kw, mid, sep, , open = "", raw = ""] = g
      const [value, tail] = splitTrailing(raw)
      return value.length >= 12 && /\d/.test(value) && /[A-Za-z]/.test(value) && plausibleSecret(value, false) && !VERSION_RE.test(value) && !looksLocator(value)
        ? `${kw}${mid}${sep}${open}${MASK}${tail}`
        : null
    },
  },
  {
    // AWS secret key (40 base64 characters): announced right before ("secret", "aws", "key"), or visibly random.
    name: "aws_secret",
    re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    replace: SECRET,
    check: (m, ctx) =>
      /[A-Z]/.test(m) &&
      /[a-z]/.test(m) &&
      /[0-9/+]/.test(m) &&
      (SECRET_CONTEXT_RE.test(ctx.input.slice(Math.max(0, ctx.offset - 80), ctx.offset)) || looksRandom(m)),
  },
  { name: "iban", re: /\b[A-Z]{2}\d{2}(?:[ \-]?[A-Z0-9]{4}){2,7}(?:[ \-]?[A-Z0-9]{1,4})?\b/gi, replace: (m) => maskIban(m) },
  {
    name: "card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: "[number redacted]",
    // A French SIRET company number also passes the Luhn check: not personal data.
    check: (m, ctx) => luhn(m) && !/\bSIRE[NT]\W{0,4}$/i.test(ctx.input.slice(Math.max(0, ctx.offset - 12), ctx.offset)),
  },
  // Local part read from the start of its run of characters (not from each "." or "-"): linear.
  { name: "email", re: /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,24}\b/g, replace: "[email redacted]" },
  { name: "phone_fr", re: /(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, replace: "[phone redacted]" },
  { name: "phone_intl", re: /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}\b/g, replace: "[phone redacted]" },
  { name: "phone_us", re: /(?<![\d-])\(?\b[2-9]\d{2}\)?[\s.\-][2-9]\d{2}[\s.\-]\d{4}\b/g, replace: "[phone redacted]" },
  {
    // US social security number, announced as such ("SSN: 123-45-6789").
    name: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: "[SSN redacted]",
    check: (m, ctx) => SSN_CONTEXT_RE.test(ctx.input.slice(Math.max(0, ctx.offset - 40), ctx.offset)),
  },
  {
    // French social security number (NIR): valid check key, Corsican format (2A / 2B), or announced as such.
    // A 15-digit batch or order number with a wrong key is kept.
    name: "nir",
    re: /\b[12][\s.]?\d{2}[\s.]?(?:0[1-9]|1[0-2])[\s.]?(?:\d{2}|2[AB])[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{2}\b/gi,
    replace: "[SSN redacted]",
    check: (m, ctx) => nirValid(m) || /2[AB]/i.test(m) || NIR_CONTEXT_RE.test(ctx.input.slice(Math.max(0, ctx.offset - 60), ctx.offset)),
  },
]

export type RedactionReport = { text: string; redactions: Record<string, number> }

export type RedactOptions = {
  /** Known values to redact verbatim (brain token, API key from the config…). Ignored under 8 characters. */
  literals?: (string | undefined | null)[]
}

/**
 * Continuation of a value longer than a rule's bound (200 characters, JWT segments): glued to the mask, it is
 * redacted with it ("[redacted]M8gaf0Wa…" → "[redacted]"). A dot is only absorbed inside a token.
 */
const MASK_TAIL_RE = /(\[(?:redacted|secret redacted|token redacted)\])(?:[A-Za-z0-9+/=_\-]|\.(?=[A-Za-z0-9_\-]))+/g

/** Redacts secrets and personal data. Idempotent. */
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
    if ("scan" in r) {
      const res = r.scan(out)
      if (res.count) redactions[r.name] = (redactions[r.name] ?? 0) + res.count
      out = res.text
      continue
    }
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
  out = out.replace(MASK_TAIL_RE, "$1")
  return { text: out, redactions }
}

export function redactText(text: string, opts?: RedactOptions): string {
  return redact(text, opts).text
}
