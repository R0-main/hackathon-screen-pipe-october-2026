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

/** Banques de particuliers (texte sans accents). Qonto, Shine… sont des banques pro : ce n'est pas de la vie privée. */
const BANKS = [
  "boursorama", "boursobank", "fortuneo", "banque populaire", "credit agricole", "credit mutuel", "caisse d'epargne",
  "societe generale", "bnp paribas", "bnp", "lcl", "banque postale", "hello bank", "revolut", "n26",
]

/** Apps grand public : signal faible (un vrai contexte de travail peut les citer, ex. « l'API WhatsApp Business »). */
const PERSONAL_APPS = [
  "whatsapp", "messenger", "telegram", "imessage", "snapchat", "tinder", "bumble", "hinge", "meetic", "happn", "grindr",
  "doctolib", "ameli", "mutuelle", "netflix", "youtube", "spotify", "deezer", "instagram", "facebook", "tiktok", "leboncoin",
  "vinted", ...BANKS,
]
const PERSONAL_APPS_RE = wordsRe(PERSONAL_APPS)

/** Noms d'apps ambigus dans un texte (« les messages d'erreur », « signal SIGTERM ») : bloqués seulement comme nom d'app exact. */
const PERSONAL_APP_NAMES = ["messages", "signal", "facetime", "photos", "contacts"]

/**
 * Sujets de vie privée sans ambiguïté (texte sans accents, en minuscules) : signal fort, qu'aucun mot de travail n'excuse.
 * Les sujets qu'un dossier de paie, de RH ou de compta peut aussi évoquer (« arrêt maladie » d'un salarié, « mon père »
 * associé de la boulangerie, « mon compte bancaire » Qonto) sont dans SENSITIVE : excusés par un vrai contexte de travail.
 */
const STRONG_PERSONAL: RegExp[] = [
  // couple
  /\b(?:ma|mon) (?:copine|copain|cheri|cherie|femme|mari|epouse|epoux|compagne|compagnon|conjoint|conjointe|mec|meuf|petite amie|petit ami|petite copine|petit copain)\b/g,
  /\bmon ex\b(?!-)/g,
  // santé (la sienne)
  /\b(?:mon|ma|chez (?:le|la|mon|ma|l'|un|une)) ?(?:medecin|docteur|generaliste|dentiste|osteo|osteopathe|kine|kinesitherapeute|psy|psychologue|psychiatre|therapeute|rhumatologue|dermatologue|cardiologue|gynecologue|gyneco|ophtalmo|ophtalmologue|pediatre|sage-femme|orthodontiste|neurologue|allergologue|urologue|radiologue)\b(?! du travail| de prevention)/g,
  /\b(?:medecin traitant|psychiatre|antidepresseurs?|anxiolytiques?|ma depression|en depression|depression nerveuse|mon burn-?out|je suis en burn-?out|mon ordonnance|ordonnance (?:medicale|du (?:medecin|docteur|psychiatre|dentiste))|analyses? (?:de sang|sanguines?)|prise de sang|ma grossesse|je suis enceinte|enceinte de \d+|fausse couche|chimiotherapie|radiotherapie|hernie discale|glycemie|diabetique|hypertension|vih|seropositi(?:f|ve)|aux urgences|mon irm|une irm|d'irm|ma therapie|je suis malade|mon arret (?:maladie|de travail)|je suis en arret|mon conge (?:maladie|maternite|paternite|parental)|on m'a diagnostique|mon traitement (?:contre|pour|medical))\b/g,
  // juridique perso (pas la fonction divorce() d'une librairie)
  /\b(?:divorce(?!\s*\()|divorcer|garde alternee|garde des enfants|juge aux affaires familiales)\b/g,
  // rencontres
  /\b(?:tinder|bumble|hinge|meetic|happn|grindr|rencard|sites? de rencontres?)\b/g,
  // finances perso
  /\b(?:mon (?:compte|livret|pret|credit) (?:perso|personnel|joint)|compte joint|mon (?:pret|credit) (?:immo|immobilier|conso|auto|etudiant)|mon livret a|mon pel|mon assurance[- ]vie|mes impots|ma declaration d'impots|mon impot sur le revenu|mon avis d'imposition)\b/g,
]

/** Sujets personnels qu'un contexte de travail peut excuser (paie, RH, compta, entreprise familiale). Comptent comme signaux faibles. */
const SENSITIVE: RegExp[] = [
  // famille (« pension alimentaire » : une saisie sur salaire passe aussi par la paie)
  /\b(?:(?:ma|mon|mes) (?:mere|pere|maman|papa|parents|fils|fille|filles|enfant|enfants|soeur|soeurs|frere|freres|grand-mere|grand-pere|grands-parents|belle-mere|beau-pere|famille|bebe)|pension alimentaire)\b/g,
  // santé, arrêts
  /\b(?:arret maladie|arret de travail|burn-?out|depression|maladie|malade|hospitalise|hospitalisee|hospitalisation|cancer|diabete|fievre|grossesse|mes regles)\b/g,
  // juridique perso
  /\b(?:mon avocat|mon avocate|ma contravention|mon amende|retrait de points|mon permis de conduire)\b/g,
  // finances perso (« mon compte bancaire pro », « mon compte BNP pro », « mon compte courant d'associé » sont de la compta)
  new RegExp(String.raw`\b(?:mon compte (?:courant(?! d'associe)|cheques?|epargne|bancaire|${BANKS.map(escapeRe).join("|")})(?! (?:pro|professionnel|d'entreprise|de l'entreprise|de la societe)\b)|ma banque|mon conseiller (?:bancaire|clientele)|ma carte (?:bancaire|bleue)|mon code d'acces|mon numero client|mon espace client|mon releve|mes releves|mon loyer|mon proprio|mon proprietaire|mon bail(?! (?:commercial|professionnel))|ma mutuelle|mes lunettes)\b`, "g"),
]

/** Vocabulaire de travail : il faut au moins deux points (un de plus par signal faible au-delà du premier). */
const WORK_HINTS = [
  "client", "clients", "projet", "projets", "project", "facture", "factures", "devis", "contrat", "code", "api", "sdk", "bug",
  "deploy", "deploiement", "deployer", "production", "prod", "staging", "serveur", "server", "endpoint", "webhook", "webhooks",
  "repo", "commit", "branche", "merge", "migration", "sql", "database", "base de donnees", "ticket", "tickets", "sprint",
  "roadmap", "spec", "specs", "maquette", "backend", "frontend", "script", "fonction", "function", "typescript", "javascript",
  "python", "react", "docker", "integration", "integrer", "bot", "prospect", "prospects", "crm", "tresorerie", "compta", "tva",
  "recrutement", "composant", "component", "business", "equipe", "reunion",
  // RH et paie
  "employe", "employes", "collaborateur", "collaborateurs", "collaboratrice",
  "rh", "dsn", "ijss", "subrogation", "payfit", "silae", "prevoyance", "process", "procedure", "handbook", "planning",
  // compta et société
  "comptable", "comptabilite", "bilan", "previsionnel", "cloture", "ecart", "ecarts", "fondateur", "fondatrice", "statuts",
  "gerant", "gerante", "commande", "commandes", "stock", "marge", "livraison", "livraisons",
  // marketing et ventes
  "campagne", "campagnes", "ads", "marketing", "audience", "abonnes", "lookalike", "visuels", "carrousel", "seo", "analytics",
  "pixel", "lancement", "produit", "produits", "vente", "ventes", "site", "newsletter", "statistiques", "kpi",
]
const WORK_HINTS_RE = wordsRe(WORK_HINTS)
/**
 * Mots de la gestion d'entreprise qu'une conversation privée emploie aussi (« mon fournisseur d'électricité », « un stage en
 * entreprise », « rapprochement familial ») : un point chacun, comme WORK_HINTS. Pas le verbe (« je paie », « il ne paie
 * plus »), pas la Société Générale, ni son propre emploi ou sa propre paie (« mon entreprise », « ma paie », « ma société »).
 */
const WORK_GENERIC_RE =
  /\b(?:(?<!\b(?:je|tu|il|elle|on|ils|elles|qui|ne|ma|ta) )paie|entreprise|societe(?! generale)|salariee?s?|fournisseurs?|associes?|rapprochement)\b/g
/**
 * Signaux nettement professionnels : deux points chacun. Des tournures (« notre boutique », « bulletin de paie », « paie
 * fournisseur », « retenue sur sa paie », « compte BNP pro », « compte courant d'associé », « rapprochement bancaire ») et les
 * outils de gestion d'entreprise (Pennylane, Qonto, URSSAF). « paie fournisseur », « virement fournisseur » et
 * « rapprochement bancaire » ne consomment que leur premier mot : « fournisseur » compte en plus comme mot de travail.
 */
const WORK_STRONG_RE =
  /\b(?:notre (?:chaine|page|compte|site|boutique|marque|equipe|entreprise|societe|boite|app|application|produit|offre|catalogue|newsletter|client|cliente|clientele)|nos (?:clients|clientes|abonnes|ventes|produits|equipes|salaries|commandes|fournisseurs|boutiques|magasins)|canal de vente|pacte d'associes|retenue a la source|(?:fiches?|bulletins?) de paie|contrat de travail|convention collective|(?:retenue|saisie)s? sur (?:la |le |sa |son )?(?:paie|salaire)|medecin du travail|visite (?:medicale|d'embauche)|(?:facebook|google|meta|instagram|linkedin|tiktok) ads|chiffre d'affaires|pennylane|qonto|urssaf|(?:paie|virement)s?(?= fournisseurs?\b)|rapprochements?(?= bancaires?\b)|compte courant d'associe|compte (?:(?:bancaire|courant|boursorama|boursobank|fortuneo|banque populaire|credit agricole|credit mutuel|caisse d'epargne|societe generale|bnp paribas|bnp|lcl|banque postale|hello bank|revolut|n26|qonto|shine) )?(?:pro|professionnel))\b/g
/** Tournures bancaires (« code client », « numéro client ») : ce ne sont pas des mots de travail. */
const BANK_IDIOMS_RE = /\b(?:code (?:d'acces|client|confidentiel|pin|secret)|(?:numero|espace|identifiant) client)\b/g

function workScore(t: string): number {
  const s = t.replace(BANK_IDIOMS_RE, " ")
  const strong = new Set(matchesAll(WORK_STRONG_RE, s)).size
  const rest = s.replace(WORK_STRONG_RE, " ")
  return strong * 2 + new Set([...matchesAll(WORK_HINTS_RE, rest), ...matchesAll(WORK_GENERIC_RE, rest)]).size
}

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

/** Apps grand public citées dans un titre de fenêtre, hors noms de fichiers ou d'hôtes (« whatsapp-webhook.ts »). */
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

/** Onglet de navigateur : accepté seulement s'il s'agit visiblement d'un assistant IA (domaine, ou titre « … - Claude »). */
export function isAiBrowserWindow(windowName: string | undefined, browserUrl?: string): boolean {
  if (browserUrl) {
    const host = hostOf(browserUrl)
    return AI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  }
  const w = normalize(windowName ?? "").trim()
  if (!w || NON_AI_PAGE_RE.test(w)) return false
  // Un vrai titre d'onglet est court : on ne découpe que ses 300 premiers caractères (la découpe sur « \s+ - \s+ » relit
  // une longue suite d'espaces depuis chacune de ses positions).
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
 * Vrai si le contenu de cette fenêtre peut être lu. Mots entiers uniquement : « messages.ts » ou un onglet « signal »
 * dans un terminal ne sont pas des messageries. `browserUrl` (optionnel) : URL de l'onglet si Screenpipe la fournit.
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

/** Signaux, plus le nombre de sujets faibles distincts (chaque app grand public, chaque famille de SENSITIVE). */
function signals(text: string): PersonalSignals & { topics: number } {
  const t = plainText(text)
  const strong = [...new Set(STRONG_PERSONAL.flatMap((re) => matchesAll(re, t)))]
  const apps = [...new Set(matchesAll(PERSONAL_APPS_RE, t))]
  const sensitive = SENSITIVE.map((re) => [...new Set(matchesAll(re, t))]).filter((hits) => hits.length > 0)
  const weak = [...new Set([...apps, ...sensitive.flat()])]
  return { strong, weak, work: workScore(t), topics: apps.length + sensitive.length }
}

/**
 * Indices de contenu personnel trouvés dans un texte (pour décider, et pour l'expliquer en simulation).
 * strong : sujet de vie privée sans ambiguïté ; weak : app grand public ou sujet sensible qu'un contexte de travail excuse ;
 * work : score de vocabulaire professionnel.
 */
export function personalSignals(text: string): PersonalSignals {
  const { strong, weak, work } = signals(text)
  return { strong, weak, work }
}

/**
 * Vrai si le texte ressemble à du contenu personnel qu'on préfère ignorer entièrement.
 * Un sujet de vie privée (santé, couple, divorce…) suffit. Un signal faible (app grand public, arrêt maladie, famille,
 * compte bancaire…) ne compte que sans vrai contexte de travail : 2 points de vocabulaire pro, un de plus par sujet
 * faible distinct au-delà du premier (« malade » et « arrêt maladie » sont un seul sujet).
 */
export function looksPersonal(text: string): boolean {
  const s = signals(text)
  if (s.strong.length > 0) return true
  return s.topics > 0 && s.work < Math.max(2, s.topics + 1)
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
/** Règle à balayage manuel : quand une regex seule avalerait la paire suivante (« user:admin,password:… »). */
type ScanRule = { name: string; scan: (text: string) => { text: string; count: number } }

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

/** N° de sécurité sociale : clé = 97 − (13 premiers chiffres mod 97), la Corse 2A / 2B comptant pour 19 / 18. */
function nirValid(raw: string): boolean {
  const s = raw.replace(/[\s.]/g, "").toUpperCase()
  if (s.length !== 15) return false
  const dept = s.slice(5, 7)
  const body = s.slice(0, 5) + (dept === "2A" ? "19" : dept === "2B" ? "18" : dept) + s.slice(7, 13)
  if (!/^\d{13}$/.test(body) || !/^\d{2}$/.test(s.slice(13))) return false
  return 97n - (BigInt(body) % 97n) === BigInt(s.slice(13))
}

const NIR_CONTEXT_RE = /(?:s[ée]cu|s[ée]curit[ée] sociale|\bNIR\b|INSEE|carte vitale|n°\s?SS\b|num[ée]ro (?:de )?SS\b)/i

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
  /^(?:\[|<|\{\{|\$\{|\$\(|\$[A-Z_][A-Z0-9_]*$|%[A-Z_(]|\*+$|[xX]{3,}$|•+$|.*\.{3}$|…|process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|env\(|env\.|secrets\.|vault:|(?:[Yy]our|YOUR|[Vv]otre|VOTRE)[-_ ]\w)/
const NON_SECRET_RE =
  /^(?:true|false|null|none|nil|undefined|str|string|number|int|integer|float|bool|boolean|bytes|any|unknown|object|optional|required|await|new|typeof|function|async|return|this|self|lambda|const|let|var|uuid|jwt|text|varchar|char|hash|hashed|bcrypt|argon2(?:id)?|include|omit|same-origin|optionnel|obligatoire|requis)$/i

function plausibleSecret(value: string, quoted: boolean): boolean {
  const v = value.trim()
  if (v.length < 3 || PLACEHOLDER_RE.test(v) || NON_SECRET_RE.test(v)) return false
  if (quoted) return true
  if (PROSE_WORDS.has(v.toLowerCase())) return false
  // Un mot français accentué (« expiré », « oublié ») n'est pas un mot de passe.
  if (/^[a-zà-ÿ]+$/i.test(v) && /[à-ÿ]/i.test(v)) return false
  // Types et appels de code : Optional[str], Promise<string>, getToken(), cfg.token, req.headers.authorization
  if (/^(?:Optional|List|Dict|Union|Record|Array|Promise|Map|Set)\b/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*$/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[,;)]*$/.test(v)) return false
  // Variable qui porte le secret : « password: hashedPassword », « token = accessToken », « pwd = db_password ».
  if ((/^[a-z]+(?:[A-Z][a-z]*)+$/.test(v) || /^[a-z]+(?:_[a-z]+)+$/.test(v)) && isSecretKey(v)) return false
  return true
}

/** Mot de passe « fort » : chiffre ou symbole, ou majuscule au milieu (« Fournil2026 », « Azerty! », « MonMdp »). */
function strongish(v: string): boolean {
  return /[A-Za-z]/.test(v) && (/[\d!@#$%^&*_+=?~\-]/.test(v) || /[A-Z]/.test(v.slice(1)))
}

/**
 * Valeur qui ressemble à un secret plutôt qu'à un mot : 6 caractères au moins, une lettre, et un chiffre ou un symbole
 * (« Fournil2026 », « S3cret!42 », « p@ssword »). La ponctuation de fin de phrase (« oublié ? », « modifié ! ») ne compte pas,
 * ni « _ » ou « - » (« created_at », « back-office »).
 */
function secretLike(v: string): boolean {
  const s = v.slice(0, trailingRunStart(v, "!?.,;:"))
  return s.length >= 6 && /[A-Za-z]/.test(s) && /[\d!@#$%^&*+=?~]/.test(s)
}

/**
 * Début de la suite de caractères de `chars` qui termine `v` (v.length s'il n'y en a pas). Une boucle depuis la fin, pas une
 * regex ancrée sur « $ » : sur une longue suite de « . » ou de « ! » qui ne termine pas la valeur, la regex la reparcourait
 * depuis chaque position (coût quadratique).
 */
function trailingRunStart(v: string, chars: string): number {
  let i = v.length
  while (i > 0 && chars.includes(v[i - 1])) i--
  return i
}

/** « incorrect! », « oublié? » : le « ! » ou le « ? » final d'un mot en minuscules ponctue la phrase. */
function sentencePunct(value: string, tail: string): [string, string] {
  const m = /^([a-zà-ÿ]+)([!?]+)$/.exec(value)
  return m ? [m[1], m[2] + tail] : [value, tail]
}

/** Mots de liaison : après « mot de passe », ils introduisent de la prose (« du compte Office365 », « est stocké dans… »). */
const LINK_WORDS = new Set([
  ...PROSE_WORDS,
  ..."sont etait était sera seront ai as avait ont were be been has had have via chez à by from at with se ne y qui que dont doit peut reste expire expiré".split(" "),
])

/** Terminaisons de mots courants (« obligatoire », « nécessaire », « incorrect »…) : pas un mot de passe. */
const WORD_SUFFIX_RE = /(?:oire|aire|able|ible|ique|ment|tion|sion|eux|euse|ant|ante|ent|ente|if|ive|age|ure|isme|iste|ee|ees|es|er|ez|ed|ing|ly)$/

const SECRET_WORDS = new Set([
  "password", "passwd", "passw", "pswd", "pwd", "pw", "pass", "mdp", "passphrase", "passwort", "kennwort", "contrasena", "contraseña", "senha",
  "wachtwoord", "motdepasse", "secret", "token", "credential", "credentials", "apikey", "cookie", "cvv", "cvc",
])
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

/** Paramètres d'URL secrets que isSecretKey ne reconnaît pas seuls (« ?key= », « &sig= »). */
const URL_SECRET_PARAMS = new Set([
  "key", "sig", "signature", "auth", "apikey", "api-key", "pass", "session", "sessionid", "session_id", "sid", "jwt",
  "x-amz-signature", "x-amz-security-token", "x-goog-signature", "code_verifier",
])

/** Sépare la ponctuation finale d'une valeur non entre guillemets (« mdp: azerty12, puis… »). */
function splitTrailing(v: string): [string, string] {
  const i = trailingRunStart(v, ",;:.)]}")
  return i < v.length && i >= 3 && !/[\n\r\u2028\u2029]/.test(v) ? [v.slice(0, i), v.slice(i)] : [v, ""]
}

const SECRET_CONTEXT_RE = /(?:aws|secret|secr[eè]te?|access[ _-]?key|cl[ée]|credential|password|mot de passe)/i

/** Chaîne aléatoire (clé AWS sans contexte) : chiffre, et nombreux passages minuscule ↔ majuscule. */
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

// --- Paires clé = valeur (env, YAML, JSON, code, en-têtes HTTP) -----------------------------------------------------

const KV_RE = /(["'`]?)\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_.\-]{0,60})\1(\??\s*(?:=>|->|:=|=|:(?!\/\/))[ \t]*)/g
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "`": "`", "«": "»", "“": "”" }
/** Dans une valeur nue, la paire suivante (« &format=csv », « ,user: x », « ; Path=/ ») ne fait pas partie du secret. */
const NEXT_PAIR_RE = /[&,;}](?=\s*["']?[A-Za-z_][\w.\-]*["']?\s*[:=])/

type KvValue = { raw: string; inner: string; open: string; close: string }

/** Longueur maximale d'une valeur (entre guillemets ou nue) : un jeton de session AWS en fait ~1 000. */
const KV_VALUE_MAX = 2000

/**
 * Dernière recherche de guillemet fermant restée vaine, par caractère fermant : jusqu'où elle a lu (`next`, la position
 * qu'elle aurait examinée ensuite) et pourquoi elle s'est arrêtée. Une recherche qui part plus loin, avant `next`, examine
 * exactement les mêmes positions (le guillemet ouvrant n'est pas une barre oblique inverse, donc les échappements restent
 * alignés) : elle reprend à `next` au lieu de relire. Sans cela, « password: « » répété relit 2 000 caractères par clé.
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
      // Même lecture que la recherche précédente jusqu'à `next` : rien à y trouver.
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
  if (PLACEHOLDER_RE.test(v.raw)) return null // « sk_test_... »
  const [value, tail] = splitTrailing(v.raw)
  if (!plausibleSecret(value, false)) return null
  // De la prose, pas une valeur : « password: min 12 caractères », « token : JWT signé », « secret : communiquer tôt ».
  const rest = input.slice(at + v.raw.length, at + v.raw.length + 40)
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
    // Clé non secrète : on reprend juste après le séparateur, sans consommer la valeur (qui peut contenir la paire suivante).
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

// --- Clés privées PEM ----------------------------------------------------------------------------------------------

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
const PEM_BODY_RE = /[A-Za-z0-9+/=\s\\]*/y

/**
 * Clé privée PEM, jusqu'à son « -----END … » (10 000 caractères au plus : une clé RSA 8192 bits en fait ~6 500), ou, tronquée,
 * jusqu'à la fin de son corps base64. Linéaire : la recherche du « END » suivant n'est jamais refaite en arrière.
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
    out += input.slice(last, m.index) + "[clé privée masquée]"
    last = stop
    PEM_BEGIN_RE.lastIndex = Math.max(stop, from)
    count++
  }
  return { text: out + input.slice(last), count }
}

// --- Règles ---------------------------------------------------------------------------------------------------------

/**
 * Options de ligne de commande qui portent un mot de passe : `mysql -pXXX`, `sshpass -p`, `redis-cli -a`, `docker login -p`…
 * Entre la commande et l'option : au plus 12 arguments de 200 caractères (balayage borné, donc linéaire, même sur une longue
 * ligne de JSON minifié qui cite « mongo » ou « mysql » des milliers de fois).
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

// --- Secrets en toutes lettres (« le mot de passe est : … ») ---------------------------------------------------------
// Toutes les répétitions sont bornées, deux répétitions qui acceptent le même caractère ne se suivent jamais (un mot ou un
// caractère obligatoire les sépare), et les branches d'une même répétition sont exclusives : le coût reste linéaire, même
// sur 32 Ko d'espaces, de retours à la ligne, d'espaces insécables ou d'abréviations (« cf.cf.cf. ») après le mot-clé.

/** Espace horizontale : toute espace sauf la fin de ligne (tabulation, espace insécable, espace fine avant « : »…). */
const H = String.raw`[^\S\r\n]`
/** Blancs, fins de ligne comprises (« mot de passe\n: … », « est :␣␣␣…␣X ») : une seule répétition par intervalle. */
const WS = String.raw`\s{0,64}`
/**
 * Un point entre le mot-clé et le séparateur : à l'intérieur d'un nom de domaine ou d'une version (« pennylane.com »,
 * « v2.1 »), ou après une abréviation (« cf. doc »). Une seule branche (l'assertion ne crée pas de choix) : pas de retour
 * arrière exponentiel sur « cf.cf.cf.… ».
 */
const GAP_DOT = String.raw`\.(?=[^\s.!?:=]|(?<=\b(?:cf|ex|env|resp|r[ée]f|etc|vs)\.))`
/**
 * Entre le mot-clé et le séparateur (`n` caractères au plus, le plus court d'abord) : ni fin de ligne ni ponctuation de
 * phrase, et il se termine sur un caractère visible, si bien que les blancs qui suivent (WS) ne recouvrent jamais les siens.
 */
const kwGap = (n: number) => String.raw`(?:(?:[^\n.!?:=]|${GAP_DOT}){0,${n - 1}}?(?:[^\s.!?:=]|${GAP_DOT}))??`
/** « : » (pas celui d'une URL, « https:// »), « = », « => », une flèche. */
const SEP_SYM = String.raw`(?:=>|:(?!\/\/)|=|[-—–]{1,3}>|→)`
const SEP_VERB = String.raw`\b(?:est|c['’]est|sera|vaut|is|was)\b`
/** Fin de mot (lettres accentuées, apostrophe et trait d'union compris) : « donc » mais pas « Donc2026 » ni « donc-là ». */
const WORD_END = String.raw`(?![\wà-ÿ'’\-])`
/** Adverbes entre le verbe et la valeur, sans « : » (« est donc Fournil2026 », « is still … »). */
const ADVERBS = String.raw`donc|bien|maintenant|d[ée]sormais|toujours|encore|actuellement|alors|aussi|now|still|currently|also`
/**
 * Mots de remplissage entre le verbe et « : » : une liste fermée de mots outils, d'adverbes et de mots qu'un mot de passe
 * n'est pas (« est donc : », « est le suivant : », « est celui-ci : », « est toujours le même : », « is as follows: »).
 * Pas n'importe quel mot : « est SoleilVert : ne le partage pas » a pour valeur SoleilVert, pas « ne ».
 */
const FILLER = String.raw`(?:${ADVERBS}|[àa]${H}{1,3}pr[ée]sent|l[ae]|les|suivante?s?|m[êe]mes?|celui-ci|celle-ci|ceux-ci|celles-ci|celui-l[àa]|celle-l[àa]|ceci|cela|[çc]a|simple|[a-zà-ÿ]{2,20}ment|tout|juste|enfin|comme|suit|en|fait|effet|par|ailleurs|pour|l['’]instant|priori|entendu|bon|bonne|nouveau|nouvelle|celui|celle|the|same|following|as|follows|below|here|just|simply|this|one|set|to|new)${WORD_END}`
/**
 * Séparateur entre le mot-clé et la valeur (un groupe, plus un groupe interne pour les adverbes), précédé de blancs :
 * - « : », « = », « => » ou une flèche ;
 * - un verbe, puis 0 à 4 mots de remplissage et « : » (« est : », « est donc : », « est le suivant : ») ;
 * - un verbe, éventuellement suivi d'un ou deux adverbes, puis la valeur (« est Fournil2026 », « est donc Fournil2026 »).
 * Chaque mot est suivi de ses propres blancs : deux répétitions de blancs ne se touchent jamais.
 */
const SEP = String.raw`(${WS}(?:${SEP_SYM}${WS}|${SEP_VERB}(?:\s{0,16}(?:${FILLER}\s{0,16}){0,4}${SEP_SYM}${WS}|\s{1,64}((?:(?:${ADVERBS})${WORD_END}\s{1,64}){1,2})?)))`
const PASSWORD_KW = String.raw`mots? de passe|mdp|password|passwd|passwort|pass ?phrase|code (?:secret|d'acc[eè]s|wi-?fi)`
const SECRET_KW = String.raw`cl[ée]s? (?:d['’]?)?api|cl[ée] secr[èe]te|api[ -]?key|secret key|access key|jeton|token|secret`
/** Valeur entre guillemets (ouvrant, contenu, fermant : le contenu garde ses espaces, cf. quotedParts) ou valeur nue. */
const QUOTED_OR_BARE = String.raw`(?:([«“"'\`])((?:${H}{0,3}\r?\n)?[^«»“”"'\`\n]{1,86}(?:\r?\n${H}{0,3})?)([»”"'\`])|([^\s"'»”\`]{1,200}))`

/** Sépare d'un contenu entre guillemets ses blancs de bord (5 au plus de chaque côté, retour à la ligne compris) : « «  Fournil 2026  » ». */
function quotedParts(inner: string): [string, string, string] {
  let a = 0
  while (a < 5 && a < inner.length - 1 && /\s/.test(inner[a])) a++
  let b = inner.length
  while (inner.length - b < 5 && b - 1 > a && /\s/.test(inner[b - 1])) b--
  return [inner.slice(0, a), inner.slice(a, b), inner.slice(b)]
}

/** « est obligatoire », « est incorrect » : un mot courant n'est pas un mot de passe ; « soleilvert » ou « Azerty123! » si. */
function looksPassword(value: string): boolean {
  return strongish(value) || /^\d{4,8}$/.test(value) || (/^[a-z]{10,}$/.test(value) && !WORD_SUFFIX_RE.test(value))
}

/** Numéro de version (« v2.3.1-beta4 », « 1.2.0 ») : pas un secret, même annoncé (« le token est maintenant v2.3.1-beta4 »). */
const VERSION_RE = /^v?\d{1,4}(?:\.\d{1,4}){1,3}(?:-[0-9A-Za-z.]{1,20})?$/i

/**
 * Où trouver le secret, pas le secret : une URL (« est ici : https://vault… », les identifiants dans une URL ont leur règle)
 * ou un chemin (« est toujours : config/db-prod.env », « is here: projects/fournil/secrets/db »).
 */
function looksLocator(value: string): boolean {
  if (/^[a-z][a-z0-9+.\-]{1,15}:\/\//i.test(value)) return true
  // Un chemin : des segments courts, sans « + » ni « = », dont au moins un mot en minuscules (« config », « secrets »).
  // Un jeton base64 a aussi des « / », mais ses segments sont longs et mélangés (« iNzzXQ…/4Wneq… »).
  const parts = value.split("/")
  if (parts.length < 2 || parts.some((p) => !/^[\w.\-]{1,40}$/.test(p))) return false
  return (parts.length > 2 || /\.[a-z]{1,5}$/i.test(value)) && parts.some((p) => /^[a-z][a-z_.\-]{2,}$/.test(p))
}

const RULES: (Rule | ScanRule)[] = [
  { name: "private_key", scan: scanPrivateKeys },
  {
    // user:motdepasse@hôte — le mot de passe peut contenir « / » ou « @ » : on va jusqu'au dernier « @ » suivi d'un hôte.
    name: "url_credentials",
    re: /\b([a-z][a-z0-9+.\-]{0,30}:\/\/)([^\s:/]{1,200}?):(\S{1,200}?)@(?=[A-Za-z0-9.\-]+(?::\d+)?(?:[/?#\s"'<>)\],;]|$))/gi,
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
    // En-tête « eyJ… », charge utile, signature. Seulement au début d'une suite de caractères base64url (pas à chaque
    // « -eyJ » d'une longue suite sans point : linéaire), segments bornés.
    name: "jwt",
    re: /(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{10,4096}\.(?:eyJ[A-Za-z0-9_\-]{5,16384}(?:\.[A-Za-z0-9_\-]{0,4096})?|[A-Za-z0-9_\-]{10,16384}\.[A-Za-z0-9_\-]{10,4096})/g,
    replace: "[jeton masqué]",
  },
  // Jeton personnel du cerveau (cb_ + 32 caractères base64url) ; « cb_on_message_handler » est un identifiant.
  {
    name: "brain_token",
    re: /\bcb_[A-Za-z0-9_\-]{16,}/g,
    replace: JETON,
    check: (m) => {
      const rest = m.slice(3)
      if (/^[a-z0-9_]+$/.test(rest) && rest.includes("_")) return false // identifiant snake_case (cb_before_commit_v2)
      return /[A-Z0-9\-]/.test(rest) || rest.length >= 24
    },
  },
  {
    name: "auth_header",
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["'`]?)(?:(Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|AWS4-HMAC-SHA256|SSWS)\s+)?(?!\[|<|\$\{|(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key|SSWS)\s)([^\s"'`,;]{6,})/gi,
    replace: (m, g) => {
      const [head, scheme, value = ""] = g
      if (PLACEHOLDER_RE.test(value)) return null // « Bearer YOUR_TOKEN »
      // Sans schéma, un mot n'est pas un jeton : « Authorization: header manquant », « authorization: required ».
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
    re: /\b(Bearer|Token|Jeton)\s+(?!\[)([A-Za-z0-9._~+/\-]{16,}=*)/gi,
    replace: (m, g) => (/^bearer$/i.test(g[0] ?? "") || /\d/.test(g[1] ?? "") ? `${g[0]} ${JETON}` : null),
  },
  {
    // ?api_key=…, &access_token=…, &pwd=…, ?sig=… (avant les paires clé=valeur, qui ne savent pas où s'arrête une URL).
    name: "url_param",
    re: /([?&;]([A-Za-z][A-Za-z0-9_.\-]{0,40})=)([^&#;\s"'`<>]+)/g,
    replace: (m, g) => {
      const key = g[1] ?? ""
      const value = g[2] ?? ""
      const secretKey = isSecretKey(key)
      if (!secretKey && !URL_SECRET_PARAMS.has(key.toLowerCase())) return null
      // « ?key=created_at », « ?auth=google », « ?pass=true », « ?key=value » : des valeurs ordinaires. Un secret a un chiffre
      // ou un symbole ; un long mot sans chiffre ne compte que derrière un vrai nom de secret (« ?token=abcdefghijkl »).
      const shaped = value.length >= 6 && /[A-Za-z0-9]/.test(value) && /[\d%+/=~!@#$*]/.test(value)
      const longWord = secretKey && /^[A-Za-z]{8,}$/.test(value)
      return (shaped || longWord) && plausibleSecret(value, true) ? `${g[0]}${MASK}` : null
    },
  },
  // CLE=valeur, clé: "valeur", "clé": "valeur", --clé=valeur, clé => valeur, clé -> valeur.
  { name: "env_secret", scan: scanKeyValues },
  {
    // <password>…</password>
    name: "xml_secret",
    re: /<([A-Za-z_][\w.\-:]{0,60})>([^<\n]{1,200})<\/\1>/g,
    replace: (m, g) => (isSecretKey((g[0] ?? "").split(":").pop() ?? "") && plausibleSecret((g[1] ?? "").trim(), true) ? `<${g[0]}>${MASK}</${g[0]}>` : null),
  },
  {
    // auth=('admin', 'motdepasse'), HTTPBasicAuth("admin", "motdepasse")
    name: "auth_tuple",
    re: /\b((?:HTTPBasicAuth|HTTPDigestAuth|BasicAuth|auth)\s*(?:=\s*)?\(\s*)(["'])([^"'\n]{0,100})\2(\s*,\s*)(["'])([^"'\n]{1,200})\5/g,
    replace: (m, g) => (plausibleSecret(g[5] ?? "", true) ? `${g[0]}${g[1]}${g[2]}${g[1]}${g[3]}${g[4]}${MASK}${g[4]}` : null),
  },
  {
    // --password s3cret, --token xyz (la forme --clé=valeur est traitée par les paires clé=valeur).
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
    // « identifiants : admin / Fournil2026! », « login admin / S3cret! »
    name: "credentials_pair",
    re: /\b(identifiants?|credentials|logins?|acc[eè]s|user\s{0,8}\/\s{0,8}pass(?:word)?)\b(\s{0,64}[:=]\s{0,64}|\s{1,64})([^\s/:,;]{1,64})(\s{0,64}\/\s{0,64})([^\s"',;]{1,200})/gi,
    replace: (m, g) => {
      const [value, tail] = splitTrailing(g[4] ?? "")
      // un chemin (« acces/admin/index.js ») n'est pas une paire identifiant / mot de passe
      if (/\.[a-z]{1,5}$/i.test(value) || value.includes("/")) return null
      // « identifiants : SIRET / TVA », « Logins : Google / Microsoft » : des mots, pas un mot de passe.
      return plausibleSecret(value, false) && secretLike(value) ? `${g[0]}${g[1]}${g[2]}${g[3]}${MASK}${tail}` : null
    },
  },
  {
    // En toutes lettres : « le mot de passe ssh root est Azerty123! », « mdp : … », « the password is … »,
    // « le mot de passe est donc : … », « le mot de passe de pennylane.com : … », « est le suivant : … ».
    name: "password_text",
    re: new RegExp(String.raw`\b(${PASSWORD_KW})\b(${kwGap(60)})${SEP}${QUOTED_OR_BARE}`, "gi"),
    replace: (m, g) => {
      const [kw, mid, sep, adverbs, open, inner, close, bare] = g
      if (inner !== undefined) {
        const [lead, quoted, trail] = quotedParts(inner)
        return plausibleSecret(quoted, true) ? `${kw}${mid}${sep}${open}${lead}${MASK}${trail}${close}` : null
      }
      const [value, tail] = sentencePunct(...splitTrailing(bare ?? ""))
      // Après un adverbe sans « : » (« est donc … »), la valeur doit ressembler à un secret (« est donc obligatoire » reste lisible).
      const shaped = adverbs ? secretLike(value) : looksPassword(value)
      return plausibleSecret(value, false) && shaped && !VERSION_RE.test(value) && !looksLocator(value) ? `${kw}${mid}${sep}${MASK}${tail}` : null
    },
  },
  {
    // Code PIN : « code PIN : 4589 », « PIN = "4589" », « Mon code PIN est « 4589 » », « mon pin c'est 4589 », « Pin : 4589 ».
    // « PIN » en capitales, « code pin », un déterminant + « pin », ou « Pin » / « pin » collé au séparateur, puis 4 à 8
    // chiffres : « Pin the react version: react@18.3.1 », « We pin dependencies: … » restent lisibles, comme une date
    // (« PIN: 2024-10-17 »).
    name: "password_text",
    re: new RegExp(
      String.raw`\b((?:[Cc]ode|CODE)\s{1,3}(?:[Pp]in|PIN)|PIN|(?:[Mm][oa]n|[Tt][oa]n|[Ss][oa]n|[Ll]e|[Vv]otre|[Nn]otre)${H}{1,3}[Pp]in|[Pp]in(?=${H}{0,3}[:=]))\b(${kwGap(30)})${SEP}` +
        String.raw`(?:([«“"'\`]${H}{0,3})(\d{4,8})(${H}{0,3}[»”"'\`])|(\d{4,8})(?!\w|[-/.:]\d))`,
      "g",
    ),
    replace: (m, g) => (g[4] !== undefined ? `${g[0]}${g[1]}${g[2]}${g[4]}${MASK}${g[6]}` : `${g[0]}${g[1]}${g[2]}${MASK}`),
  },
  {
    // Sans séparateur : « avec le mot de passe Fournil2026! », « MDP Fournil2026 », « mot de passe root S3cret!42 ».
    // Une valeur qui ressemble à un secret (chiffre, ou symbole à l'intérieur), juste après le mot-clé ou après un ou deux
    // qualificatifs (« root », « wifi », « provisoire ») ; « du compte Office365 », « sur Windows11 », « est stocké dans
    // 1Password », « oublié ? », « modifié ! » restent de la prose.
    name: "password_text",
    re: /\b(mots? de passe|mdp|password|passwd|passwort)([ \t]{1,64}(?:[a-zà-ÿ'’\-]{1,15}[ \t]{1,64}){0,2}?)(?!(?:sha|md|bcrypt|argon|scrypt|pbkdf|aes|rsa|hs|rs|es|utf|iso|rfc|tls|ssl|wpa|wep|v)[-_]?\d)(?=[^\s"'»”]{0,200}(?:\d|[!@#$%^&*+=?~][^\s"'»”,.;:!?)\]]))(?=[^\s"'»”]{0,200}[A-Za-z])([^\s"'»”]{6,200})/gi,
    replace: (m, g) => {
      const [kw, mid, raw] = g
      const words = (mid ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (words.some((w) => LINK_WORDS.has(w) || /^(?:d|l|n|j|s|qu)['’]/.test(w))) return null
      const [value, tail] = splitTrailing(raw ?? "")
      return secretLike(value) && plausibleSecret(value, false) ? `${kw}${mid}${MASK}${tail}` : null
    },
  },
  {
    // « La clé API est : … », « le token est le suivant : … », « the secret is … » : une valeur longue, lettres et chiffres.
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
    // Clé secrète AWS (40 caractères base64) : annoncée juste avant (« secret », « aws », « clé »), ou visiblement aléatoire.
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
    replace: "[numéro masqué]",
    // Un SIRET passe aussi la clé de Luhn : ce n'est pas une donnée personnelle.
    check: (m, ctx) => luhn(m) && !/\bSIRE[NT]\W{0,4}$/i.test(ctx.input.slice(Math.max(0, ctx.offset - 12), ctx.offset)),
  },
  // Partie locale lue depuis le début de sa suite de caractères (et non depuis chaque « . » ou « - ») : linéaire.
  { name: "email", re: /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,24}\b/g, replace: "[email masqué]" },
  { name: "phone_fr", re: /(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, replace: "[téléphone masqué]" },
  { name: "phone_intl", re: /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}\b/g, replace: "[téléphone masqué]" },
  {
    // N° de sécurité sociale : clé de contrôle valide, format corse (2A / 2B), ou annoncé comme tel (« n° sécu »).
    // Un numéro de lot ou de commande de 15 chiffres à la clé fausse est gardé.
    name: "nir",
    re: /\b[12][\s.]?\d{2}[\s.]?(?:0[1-9]|1[0-2])[\s.]?(?:\d{2}|2[AB])[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{2}\b/gi,
    replace: "[n° sécu masqué]",
    check: (m, ctx) => nirValid(m) || /2[AB]/i.test(m) || NIR_CONTEXT_RE.test(ctx.input.slice(Math.max(0, ctx.offset - 60), ctx.offset)),
  },
]

export type RedactionReport = { text: string; redactions: Record<string, number> }

export type RedactOptions = {
  /** Valeurs connues à masquer telles quelles (jeton du cerveau, clé API de la config…). Ignorées sous 8 caractères. */
  literals?: (string | undefined | null)[]
}

/** Masque secrets et données personnelles. Idempotent. */
/**
 * Suite d'une valeur plus longue que la borne d'une règle (200 caractères, segments d'un JWT) : collée au masque, elle est
 * masquée avec lui (« [masqué]M8gaf0Wa… » → « [masqué] »). Un point n'est absorbé qu'à l'intérieur d'un jeton.
 */
const MASK_TAIL_RE = /(\[(?:masqué|secret masqué|jeton masqué)\])(?:[A-Za-z0-9+/=_\-]|\.(?=[A-Za-z0-9_\-]))+/g

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
