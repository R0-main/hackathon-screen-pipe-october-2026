// Distillation heuristique (sans LLM) : sert de repli quand aucune clé Claude n'est disponible,
// et de garde-fou en test. La version Claude est dans claude.ts.
// « Rien de brut » : l'heuristique ne produit que des gabarits et de courts extraits re-masqués.

import type { Entity, KnowledgeItemInput, KnowledgeKind, SourceTool, Zone } from "./types"
import { zoneScorer } from "./zones"
import { firstSentence, truncate } from "./text"
import { looksPersonal, redactText } from "./privacy"

export type ConversationMessage = { role: "user" | "assistant"; text: string; at?: string }

/** Une session IA reconstituée sur le poste (logs Claude Code, Codex, ou capture Screenpipe). */
export type Conversation = {
  id: string
  tool: SourceTool
  app: string
  title?: string
  cwd?: string
  started_at: string
  ended_at: string
  messages: ConversationMessage[]
  screenpipe_ref?: string
  /** Rappel (court, déjà masqué) de la demande initiale quand ce segment ne la contient pas (cf. chunkConversation). */
  ask?: string
}

export type ZoneHint = Pick<Zone, "id" | "name" | "keywords" | "description">

export const KNOWN_TOOLS = [
  "Stripe", "Supabase", "Postgres", "PostgreSQL", "Next.js", "React", "Vue", "Svelte", "Node", "Bun", "Deno", "Python",
  "TypeScript", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Vercel", "Netlify", "Cloudflare", "GitHub", "GitLab",
  "Linear", "Jira", "Notion", "Slack", "Figma", "HubSpot", "Salesforce", "Pipedrive", "Pennylane", "Qonto", "Stripe",
  "Shopify", "Zapier", "Make", "n8n", "Airtable", "Google Sheets", "Excel", "Todoist", "Intercom", "Zendesk", "Sentry",
  "Datadog", "Redis", "MongoDB", "Prisma", "Drizzle", "Tailwind", "Screenpipe", "Claude", "Claude Code", "Codex", "ChatGPT",
  "OpenAI", "Anthropic", "Mistral", "Brevo", "Sendgrid", "Twilio", "Alan", "Swile", "Payfit", "Lemlist", "Calendly",
]

/**
 * Décisions explicites. Pas de « retenu » ni de « décision » nus (« la retenue à la source », « il faudra une décision »),
 * ni de libellé de calcul (« Taux retenu : 7,5 % », « Montant retenu : 187 € »). « On retient » est traité à part (RETAIN_RE) :
 * c'est aussi le verbe de la retenue sur salaire.
 */
const DECISION_RE =
  /\b(?:on (?:part|est parti|partira) sur|on a (?:d[ée]cid[ée]|tranch[ée]|choisi|opt[ée] pour|valid[ée])|nous avons (?:d[ée]cid[ée]|choisi)|j'ai (?:d[ée]cid[ée]|tranch[ée])|il a [ée]t[ée] d[ée]cid[ée]|c'est d[ée]cid[ée]|d[ée]cision\s*:|d[ée]cision prise|on garde(?! (?:[àa] l['’]esprit|en t[êe]te|en m[ée]moire|un [œo]e?il))|on choisit|on opte|(?:solution|option|approche|piste|offre|choix|sc[ée]nario|prestataire|fournisseur|outil|formule|variante)s? retenue?s?\b|on va utiliser|on utilisera|we(?:'ll| will) (?:use|go with)|let'?s (?:use|go with)|we decided|decided to|we chose|go avec|valid[ée]\s*:)/i
/** Hypothèse avant le verbe de décision (« Si on garde ce rythme… », « Quand on choisit… ») : pas une décision. */
const HYPOTHETICAL_RE =
  /(?:^|[\s,;(«"])(?:si|s'il|s'ils|if|quand|lorsqu['’]?|au cas o[uù]|dans le cas o[uù]|dans l['’]hypoth[èe]se o[uù]|en supposant|imaginons|admettons|peut-[êe]tre|à moins qu|a moins qu|sauf si)(?![a-zà-ÿ])[^.;!?]*$/i
/**
 * « On retient » / « nous retenons » / « on a retenu » : une décision seulement si l'objet est un choix — un nom propre
 * (« On retient Stripe Billing ») ou un nom de choix (« la solution B », « l'offre de Qonto ») —, pas une retenue
 * (« on retient donc 187 € sur le salaire », « le prélèvement à la source », « la TVA à 20 % »).
 */
const RETAIN_RE = /\b(?:on retient|nous retenons|je retiens|on a retenu|nous avons retenu|j'ai retenu)\s+/i
const RETAINED_CHOICE_RE =
  /^(?:(?:donc|finalement|plut[ôo]t|alors|bien|d[ée]finitivement)\s+)?(?:[A-Z][A-Za-zÀ-ÿ0-9]*[a-zà-ÿ0-9]|(?:la|le|l['’]|les|cette|ce|cet|notre|votre|leur)\s*(?:solution|option|offre|formule|proposition|approche|piste|version|variante|sc[ée]nario|prestataire|fournisseur|outil|choix|id[ée]e|m[ée]thode|strat[ée]gie|plan|devis|candidat|candidate|candidature|maquette|architecture|stack|librairie|biblioth[èe]que|framework|banque|premi[èe]re|deuxi[èe]me|seconde|troisi[èe]me|derni[èe]re)\b)/

function isDecision(s: string): boolean {
  const m = DECISION_RE.exec(s)
  if (m && !HYPOTHETICAL_RE.test(s.slice(0, m.index))) return true
  const r = RETAIN_RE.exec(s)
  return Boolean(r) && RETAINED_CHOICE_RE.test(s.slice((r?.index ?? 0) + (r?.[0].length ?? 0))) && !HYPOTHETICAL_RE.test(s.slice(0, r?.index ?? 0))
}

/** Décision encore à prendre : c'est une question ouverte, pas une décision. */
const PENDING_RE =
  /\b(?:il (?:faudra|faut|reste [àa]) (?:prendre )?une d[ée]cision|d[ée]cision (?:[àa] prendre|en attente)|reste [àa] (?:trancher|d[ée]cider)|[àa] trancher|to be decided)/i
const TASK_RE =
  /^\s*(?:[-*]\s*\[ \]\s*|TODO[:\s]|[àa] faire\s*:|reste [àa]\s|next steps?\s*:?|prochaines? [ée]tapes?\s*:?|il faudra\s|penser [àa]\s)/i
const STEP_RE = /^\s*(\d+)[.)]\s+\S/

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ")
}

function sentences(text: string): string[] {
  return stripCode(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400)
}

/** Court extrait re-masqué : l'heuristique ne recopie jamais plus de quelques dizaines de mots d'affilée. */
function excerpt(s: string, max: number): string {
  return truncate(redactText(s.replace(/\s+/g, " ").trim()), max)
}

/**
 * Noms d'outils qui sont aussi des mots courants ou des prénoms (« Vue mensuelle », « Notion de marge », « Slack de 2 jours »,
 * « Make sure », « Alan ») : casse exacte, et retenus seulement sur un indice d'outil (cf. ambiguousToolAt).
 */
const AMBIGUOUS_TOOLS = new Set([
  "Vue", "Node", "Bun", "Deno", "Linear", "Notion", "Slack", "Excel", "Make", "Alan", "Mistral", "Codex", "React", "Drizzle",
  "Tailwind", "Prisma", "Swile", "Sentry", "Claude",
])
/** Outils retenus seulement avec un indice de contexte dans le texte (Alan est aussi un prénom, Make un verbe anglais). */
const TOOL_CONTEXT: Record<string, RegExp> = {
  Alan: /\b(?:mutuelle|assurance|sant[ée]|pr[ée]voyance|insurance)\b/i,
  Make: /\b(?:make\.com|integromat|zapier|n8n|sc[ée]nario|automatisation|automation|workflow)\b/i,
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Toutes les écritures d'outils connus, pour reconnaître une énumération (« Notion et Slack », « Stripe, Notion »). */
const ANY_TOOL_SRC = KNOWN_TOOLS.map(escapeRe).sort((a, b) => b.length - a.length).join("|")
/** Déterminants : « la Notion de marge », « du Slack dans le planning » sont des noms communs, pas des outils. */
const DETERMINERS = new Set(
  (
    "le la les l un une des du de d au aux ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs quel " +
    "quelle quels quelles chaque aucun aucune tout toute tous toutes the a an this that these those my your our their its some " +
    "any no each every et ou ni and or nor"
  ).split(" "),
)
/** Préposition + article devant le nom (« sur le Slack de l'équipe », « dans la Notion partagée » reste rare mais valide). */
const PREP_ARTICLE_RE = /(?:^|[^A-Za-zÀ-ÿ])(?:dans|sur|via|avec|depuis|vers|chez|sous|par|in|on|with|into|from)\s+(?:le|la|l['’]|the)\s*$/i
/**
 * Verbes qui font d'un nom en tête de phrase un outil : « Sentry est déployé », « Notion est notre wiki ». Pas « a », « va »,
 * « fait » : « Claude a validé la facture » parle d'une personne.
 */
const TOOL_VERBS =
  "est sont était sera reste tourne plante crashe remonte envoie notifie alerte synchronise gère héberge stocke permet sert fonctionne marche is was runs sends stores lets handles".split(" ")
const TOOL_VERB_AFTER_RE = new RegExp(`^\\s+(?:${TOOL_VERBS.join("|")})\\b`)
/** Mots en minuscules qui peuvent suivre un outil : verbes, prépositions, conjonctions (« Vue pour le front », « Make relance »). */
const TOOL_FOLLOWERS = new Set([
  ...TOOL_VERBS,
  ..."relance déclenche a ont va vont peut doit fait has will can does".split(" "),
  ..."à au aux avec chez dans depuis en entre par pour sans sous sur vers via contre après avant pendant selon comme côté du des et ou mais donc car ni puis quand si que qu qui lorsque ne n and or but for with in on to from into at by".split(" "),
])
const DETERMINER_AHEAD_RE = /^(?:l['’]|(?:la|le|les|notre|votre|leur|leurs|mon|ma|mes|ton|ta|tes|son|sa|ses|nos|vos|ce|cet|cette|ces)(?![a-zà-ÿ]))/

/** Outils dont le nom, majuscule comprise, est aussi un mot ordinaire en tête de libellé (« Vue mensuelle », « Make un point »). */
const LABEL_WORD_TOOLS = new Set(["Vue", "Make", "Linear"])
/** Outils dont le nom est aussi un prénom : sujet d'un verbe, c'est d'abord une personne (« Léo et Claude sont en congé »). */
const FIRST_NAME_TOOLS = new Set(["Claude", "Alan"])

/**
 * Un nom commun suit le nom de l'outil, qui est alors un mot ordinaire :
 * - « de » sans article (« Notion de marge », « Vue d'ensemble », « Slack de 2 jours », « Alan de vérifier ») ; avec un article,
 *   c'est un complément (« le Slack de l'équipe » reste un outil) ;
 * - pour Vue, Make et Linear, tout mot en minuscules qui n'est ni un verbe, ni une préposition, ni une conjonction (« Vue
 *   mensuelle », « Vue client », « Make un point », « Make sure »). Les autres outils gardent leur complément (« React
 *   components », « Node built-ins », « page Notion publique »).
 */
function commonNounAfter(tool: string, after: string): boolean {
  const m = /^[^\S\n]{1,3}([a-zà-ÿ][a-zà-ÿ\-]*)(['’])?/.exec(after)
  if (!m) return false
  if (m[1] === "de" || (m[1] === "d" && m[2])) {
    const next = after.slice(m[0].length).trimStart()
    // « le Notion de Fournil », « l'espace Notion de Fournil » : « de » + nom propre est un complément, comme « de l'équipe ».
    return !DETERMINER_AHEAD_RE.test(next) && !(m[1] === "de" && /^[A-ZÀ-Ý]/.test(next))
  }
  return LABEL_WORD_TOOLS.has(tool) && !TOOL_FOLLOWERS.has(m[1])
}
/** En-tête d'une liste d'outils : « Outils recommandés : », « Stack : », « Intégrations ». */
const TOOL_HEADER_RE = /\b(?:outils?|stack|tools?|logiciels?|apps?|applis?|applications?|services?|int[ée]grations?|plateformes?|saas|technos?|technologies?)\b/i
const BULLET_RE = /^\s*(?:[-*•·+]|\d+[.)]|[a-z][.)])\s+/
const COORD = String.raw`\s*(?:,|/|\+|&|\bet\b|\bou\b|\band\b|\bor\b)\s*`
const TOOL_THEN_COORD_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${ANY_TOOL_SRC})${COORD}$`)
const COORD_THEN_TOOL_RE = new RegExp(`^${COORD}(?:${ANY_TOOL_SRC})(?![A-Za-z0-9])`)
const TOOL_HEAD_RE = new RegExp(`^(?:${ANY_TOOL_SRC})(?![A-Za-z0-9])`, "i")

/**
 * Puce qui commence par un outil connu (« - Stripe pour les paiements », « - **Notion** : la doc ») ; un outil ambigu compte
 * seulement avec sa casse exacte et s'il n'est pas suivi d'un nom commun (« - Vue globale : … », « - Make un point »).
 */
function toolBullet(line: string): "plain" | "ambiguous" | null {
  const body = line.replace(BULLET_RE, "").replace(/^[*_`\s]+/, "")
  const head = TOOL_HEAD_RE.exec(body)?.[0]
  if (!head) return null
  const name = KNOWN_TOOLS.find((t) => t.toLowerCase() === head.toLowerCase()) ?? head
  if (!AMBIGUOUS_TOOLS.has(name)) return "plain"
  return head === name && !commonNounAfter(name, body.slice(head.length)) ? "ambiguous" : null
}

type ToolBulletKind = ReturnType<typeof toolBullet>

/**
 * Lecture d'un texte, mémorisée par ligne : est-ce une puce, par quel genre d'outil commence-t-elle (cf. toolBullet), et le
 * verdict de chaque liste. Une longue liste de « - Notion » ou de « - Vue mensuelle » n'est pas relue à chaque occurrence.
 */
type ListMemo = { lines: string[]; bullet: Map<number, boolean>; kind: Map<number, ToolBulletKind>; blocks: Map<number, boolean> }

function isBulletLine(memo: ListMemo, k: number): boolean {
  let v = memo.bullet.get(k)
  if (v === undefined) memo.bullet.set(k, (v = BULLET_RE.test(memo.lines[k])))
  return v
}

/**
 * Liste d'outils sans en-tête (lignes `start` à `end`) : au moins deux puces, chacune commence par un outil, dont un outil
 * sans ambiguïté (« - Stripe pour les paiements\n- Notion pour la doc »). Des noms seulement ambigus sont des personnes ou
 * des mots (« Équipe :\n- Claude : gérant\n- Alan : comptable », « - Node A\n- Node B »).
 */
function toolList(memo: ListMemo, start: number, end: number): boolean {
  if (end - start < 1) return false
  let plain = false
  for (let k = start; k <= end; k++) {
    let kind = memo.kind.get(k)
    if (kind === undefined) memo.kind.set(k, (kind = toolBullet(memo.lines[k])))
    if (kind === null) return false
    plain ||= kind === "plain"
  }
  return plain
}

/** Dernier mot de `before` (avant une apostrophe et des blancs finals), lu depuis la fin : « dans l'espace » → « espace ». */
function lastWord(before: string): string {
  let end = before.length
  while (end > 0 && /\s/.test(before[end - 1])) end--
  if (end > 0 && /['’]/.test(before[end - 1])) end--
  let start = end
  while (start > 0 && /[A-Za-zÀ-ÿ]/.test(before[start - 1])) start--
  return before.slice(start, end).toLowerCase()
}
/** Une liste plus longue n'est lue que sur 30 lignes autour de la puce : coût borné. */
const BLOCK_SPAN = 30

/** Lignes de la liste à puces qui contient la ligne `i` (aucune si ce n'est pas une puce), et l'en-tête qui la précède. */
function bulletBlock(memo: ListMemo, i: number): { start: number; end: number; header: string } | null {
  if (!isBulletLine(memo, i)) return null
  let a = i
  while (a > 0 && i - a < BLOCK_SPAN && isBulletLine(memo, a - 1)) a--
  let b = i
  while (b + 1 < memo.lines.length && b - i < BLOCK_SPAN && isBulletLine(memo, b + 1)) b++
  let h = a - 1
  while (h >= 0 && a - h < BLOCK_SPAN && !memo.lines[h].trim()) h--
  return { start: a, end: b, header: h >= 0 && !isBulletLine(memo, h) ? memo.lines[h] : "" }
}

/**
 * Un nom d'outil ambigu (casse exacte) à la position `at` est-il l'outil ? Jamais s'il est suivi d'un nom commun (« Vue
 * mensuelle », « Notion de marge », cf. commonNounAfter). Sinon, il faut un indice :
 * - un numéro de version ou une extension (« Vue 3 », « Node 22 », « vue.js ») ;
 * - au milieu d'une phrase, derrière un mot qui n'est pas un déterminant (« dans Notion », « le fichier Excel », « l'API Slack ») :
 *   un nom commun prendrait un article (« la Notion de marge ») et un titre commence par ce mot (« ## 📊 Vue mensuelle ») ;
 * - une préposition et un article (« sur le Slack ») ;
 * - un verbe juste après, sans article devant (« Sentry est déployé en prod », « Notion est notre wiki ») ;
 * - une énumération avec un autre outil (« Notion et Slack ») ;
 * - une liste d'outils : en-tête « Outils : » / « Stack : », ou une liste dont chaque puce commence par un outil
 *   (« - Stripe pour les paiements\n- Notion pour la doc ») ; une seule puce « - Qonto : … » ne suffit pas.
 */
function ambiguousToolAt(
  tool: string,
  text: string,
  at: number,
  memo: ListMemo,
  lineIndex: number,
  lineStart: number,
): boolean {
  const after = text.slice(at + tool.length, at + tool.length + 60)
  const before = text.slice(Math.max(lineStart, at - 200), at)
  if (/^\s?\d/.test(after) || /^\.(?:js|com|so|app|io)\b/i.test(after)) return true
  if (commonNounAfter(tool, after)) return false
  // Mot précédent, sur la même ligne : un mot ordinaire (pas un déterminant) ⇒ milieu de phrase.
  const prevWord = lastWord(before)
  if (prevWord && !DETERMINERS.has(prevWord)) return true
  if (PREP_ARTICLE_RE.test(before)) return true
  // Sujet d'un verbe (« Sentry est déployé », « Le Sentry est déployé », « Ce Slack sert aux alertes », « … et Slack envoie »).
  // Vue, Make et Linear sont aussi des mots ordinaires : derrière un déterminant, « la Vue est claire » est un nom commun.
  if ((!prevWord || !(LABEL_WORD_TOOLS.has(tool) || FIRST_NAME_TOOLS.has(tool))) && TOOL_VERB_AFTER_RE.test(after)) return true
  // Énumération : « Notion et Slack », « Stripe, Notion », « Slack / Linear ».
  if (TOOL_THEN_COORD_RE.test(before.slice(-40)) || COORD_THEN_TOOL_RE.test(after)) return true
  // Liste d'outils (puces) : en-tête explicite, ou chaque puce commence par un outil.
  if (TOOL_HEADER_RE.test(before)) return true
  const block = bulletBlock(memo, lineIndex)
  if (!block) return false
  // Verdict mémorisé par ligne (et partagé entre outils) : une longue liste de « - Vue » n'est pas relue à chaque occurrence.
  let listOfTools = memo.blocks.get(lineIndex)
  if (listOfTools === undefined) {
    listOfTools = TOOL_HEADER_RE.test(block.header) || toolList(memo, block.start, block.end)
    memo.blocks.set(lineIndex, listOfTools)
  }
  return listOfTools
}

/** Mémo de lecture d'un texte (cf. ListMemo), créé au premier outil ambigu rencontré et partagé par tous les outils. */
type MemoRef = { memo: ListMemo | null }

function toolMentioned(tool: string, text: string, ref: MemoRef = { memo: null }): boolean {
  const esc = escapeRe(tool)
  if (!AMBIGUOUS_TOOLS.has(tool)) return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(text)
  if (new RegExp(`(^|[^A-Za-z0-9])${esc}\\.js\\b`, "i").test(text)) return true
  const context = TOOL_CONTEXT[tool]
  if (context && !context.test(text)) return false
  // Numéro de ligne tenu à jour au fil des occurrences (croissantes) : pas de recomptage depuis le début du texte, et la
  // position du prochain « \n » est gardée d'une occurrence à l'autre (pas de relecture de la ligne à chaque occurrence).
  let lineIndex = 0
  let scanned = 0
  let nextNl = text.indexOf("\n")
  for (const m of text.matchAll(new RegExp(`(^|[^A-Za-z0-9\\-])${esc}(?![A-Za-z0-9\\-'’])`, "g"))) {
    const at = (m.index ?? 0) + m[1].length
    while (nextNl !== -1 && nextNl < at) {
      lineIndex++
      scanned = nextNl + 1
      nextNl = text.indexOf("\n", scanned)
    }
    ref.memo ??= { lines: text.split("\n"), bullet: new Map(), kind: new Map(), blocks: new Map() }
    if (ambiguousToolAt(tool, text, at, ref.memo, lineIndex, scanned)) return true
  }
  return false
}

export function extractEntities(text: string, cwd?: string): Entity[] {
  const found = new Map<string, Entity>()
  const add = (e: Entity) => found.set(`${e.type}:${e.name.toLowerCase()}`, e)
  const ref: MemoRef = { memo: null }
  for (const tool of KNOWN_TOOLS) if (toolMentioned(tool, text, ref)) add({ type: "tool", name: tool })
  if (cwd) {
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (base && base.length > 1 && !["src", "home", "Users", "user", "tmp", "Desktop"].includes(base)) add({ type: "project", name: base })
  }
  for (const m of text.matchAll(/\b(?:client|chez|pour le client|prospect)\s+([A-Z][\w&'-]+(?:\s+[A-Z][\w&'-]+){0,2})/g)) {
    add({ type: "client", name: m[1] })
  }
  for (const m of text.matchAll(/\b(?:projet|project)\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)/g)) add({ type: "project", name: m[1] })
  for (const m of text.matchAll(/@([A-Z][a-zà-ÿ]+(?:\s[A-Z][a-zà-ÿ]+)?)/g)) add({ type: "person", name: m[1] })
  return [...found.values()].slice(0, 8)
}

/** Passage le plus long recopié tel quel depuis ce que l'employé a écrit (demande, messages), dans tout champ envoyé. */
export const MAX_PROMPT_VERBATIM = 80
/** Extrait le plus long tiré d'une réponse de l'assistant. */
const MAX_ANSWER_EXCERPT = 200

/**
 * Session lue à l'écran (Screenpipe) ou dans un assistant web : l'OCR mélange la demande tapée par l'employé et la réponse
 * dans le texte « assistant ». Seuls les journaux Claude Code et Codex séparent vraiment ce que l'employé a écrit.
 */
export function isScreenCapture(conv: Pick<Conversation, "id" | "tool" | "screenpipe_ref">): boolean {
  return !(conv.tool === "claude-code" || conv.tool === "codex") || conv.id.startsWith("screenpipe:") || Boolean(conv.screenpipe_ref)
}

/** Ensemble de fenêtres de texte (cf. verbatimWindows) ; un Set<string> convient aussi. */
export type VerbatimWindows = { has(window: string): boolean; readonly size: number }

const HASH_MOD = 1_000_000_007
const HASH_BASE = 131

/** Empreinte polynomiale d'une fenêtre (modulo un nombre premier < 2^30 : un petit entier, rapide comme clé de Map). */
function windowHash(s: string, from: number, len: number): number {
  let h = 0
  for (let i = from; i < from + len; i++) h = (h * HASH_BASE + s.charCodeAt(i)) % HASH_MOD
  return h
}

/**
 * Fenêtres de `max + 1` caractères des textes de l'employé (espaces normalisés, déjà masqués) : un passage plus long recopié
 * s'y retrouve. Indexées par empreinte glissante (la position de chaque fenêtre, chaînée par empreinte, au lieu de 320 000
 * chaînes de 81 caractères) ; une recherche vérifie caractère par caractère : même réponse qu'un Set des fenêtres.
 * `size` compte les fenêtres (doublons compris) : seul « aucune fenêtre » sert.
 */
export function verbatimWindows(texts: string[], max: number): VerbatimWindows {
  const w = max + 1
  // Les textes, mis bout à bout ; « \n » (absent d'un texte aux espaces normalisés) les sépare, et aucune fenêtre ne le contient.
  const all = texts.map((t) => redactText(t.replace(/\s+/g, " ").trim())).join("\n")
  const n = Math.max(0, all.length - w + 1)
  let bits = 10
  while (1 << bits < 2 * n) bits++
  const mask = (1 << bits) - 1
  const head = new Int32Array(1 << bits) // empreinte & mask → dernière position + 1 (0 : vide)
  const next = new Int32Array(n) // position → position précédente du même seau + 1
  const hashes = new Int32Array(n)
  let size = 0
  let top = 1
  for (let i = 1; i < w; i++) top = (top * HASH_BASE) % HASH_MOD
  let h = 0
  let start = 0 // début du texte courant
  for (let i = 0; i < all.length; i++) {
    if (all.charCodeAt(i) === 10) {
      start = i + 1
      h = 0
      continue
    }
    if (i - start >= w) h = (h - ((all.charCodeAt(i - w) * top) % HASH_MOD) + HASH_MOD) % HASH_MOD
    h = (h * HASH_BASE + all.charCodeAt(i)) % HASH_MOD
    if (i - start + 1 < w) continue
    const at = i + 1 - w
    hashes[at] = h
    next[at] = head[h & mask]
    head[h & mask] = at + 1
    size++
  }
  return {
    size,
    has(window: string) {
      if (window.length !== w || size === 0) return false
      const wh = windowHash(window, 0, w)
      for (let p = head[wh & mask]; p !== 0; p = next[p - 1]) if (hashes[p - 1] === wh && all.startsWith(window, p - 1)) return true
      return false
    },
  }
}

/**
 * Raccourcit tout passage de plus de `max` caractères recopié tel quel (garde-fou final, quel que soit le gabarit).
 * La comparaison se fait espaces normalisés, comme les fenêtres : un champ sur plusieurs lignes (étapes jointes par « \n »)
 * est vu comme la source, où ces lignes se suivent. La coupe est reportée sur le texte du champ, retours à la ligne compris.
 */
export function clipVerbatim(field: string, windows: VerbatimWindows, max: number): string {
  const w = max + 1
  if (windows.size === 0 || field.length < w) return field
  // norm : le champ aux espaces normalisés ; at[k] : position dans `field` du k-ième caractère de norm.
  let norm = ""
  const at: number[] = []
  for (let i = 0; i < field.length; i++) {
    const space = /\s/.test(field[i])
    if (space && norm.endsWith(" ")) continue
    norm += space ? " " : field[i]
    at.push(i)
  }
  let out = ""
  let from = 0
  for (let i = 0; i + w <= norm.length; ) {
    if (!windows.has(norm.slice(i, i + w))) {
      i++
      continue
    }
    let end = i + w
    while (end < norm.length && windows.has(norm.slice(end + 1 - w, end + 1))) end++
    const cut = at[i + max - 1]
    const next = end < norm.length ? at[end] : field.length
    // La partie coupée enjambe une fin de ligne (une étape et la suivante) : la suite reste sur sa propre ligne.
    const rest = field.slice(next)
    out += `${field.slice(from, cut).trimEnd()}…${field.slice(cut, next).includes("\n") ? "\n" : /^\s/.test(rest) ? "" : " "}`
    from = next
    i = end
  }
  // « …car la l… … — » : une coupe juste avant l'ellipse d'un extrait déjà raccourci n'en ajoute pas une seconde.
  return (out + field.slice(from)).replace(/…(\s*)…/g, (_, s: string) => (s.includes("\n") ? "…\n" : "…")).trim()
}

/**
 * Distille une conversation en items de connaissance, sans LLM.
 * Rien de brut : la demande de l'employé n'apparaît qu'en extrait de 80 caractères au plus (titre), jamais en « contexte » ;
 * les phrases de l'assistant sont des extraits courts et re-masqués. Un garde-fou final raccourcit tout passage de plus de
 * 80 caractères recopié depuis ce que l'employé a écrit. Pour une capture d'écran (cf. isScreenCapture), tout le texte
 * capturé compte comme écrit par l'employé : aucun champ ne recopie plus de 80 caractères d'affilée de la source.
 * La zone de chaque item est celle de la conversation, sauf indice nettement plus fort pour une autre zone.
 */
export function distillHeuristic(conv: Conversation, zones: ZoneHint[], fallbackZone?: string): KnowledgeItemInput[] {
  const userMsgs = conv.messages.filter((m) => m.role === "user" && m.text.trim())
  const asstMsgs = conv.messages.filter((m) => m.role === "assistant" && m.text.trim())
  if (asstMsgs.length === 0) return []

  const all = conv.messages.map((m) => m.text).join("\n")
  // Garde-fou : applyPrivacy écarte déjà ces sessions, mais l'heuristique sert aussi de repli quand le LLM échoue.
  if (looksPersonal(`${conv.title ?? ""}\n${conv.ask ?? ""}\n${all}`)) return []

  // La demande : titre de session, rappel de la demande initiale (segment de fin), ou premier message.
  const askText = conv.title || conv.ask || userMsgs[0]?.text || ""
  const ask = askText ? excerpt(firstSentence(askText, 200), MAX_PROMPT_VERBATIM) : ""
  // Mots-clés des zones normalisés une fois pour toute la distillation (pas à chaque item).
  const score = zoneScorer(zones)
  const askZone = askText ? score(askText)[0]?.zone : undefined
  const zone =
    score(`${conv.title ?? ""}\n${conv.ask ?? ""}\n${all}`, { prefer: [askZone, fallbackZone] })[0]?.zone ??
    fallbackZone ??
    zones[0]?.id ??
    "general"
  // Une ligne isolée ne change de zone que sur un indice net (≥ 2 mots-clés et 1 point d'avance), jamais sur une égalité.
  const zoneFor = (text: string): string => {
    const scores = score(text, { prefer: [zone] })
    const top = scores[0]
    if (!top || top.zone === zone) return zone
    const own = scores.find((s) => s.zone === zone)?.score ?? 0
    return top.score >= 2 && top.score >= own + 1 ? top.zone : zone
  }

  const entities = extractEntities(all, conv.cwd)
  const project = entities.find((e) => e.type === "project")?.name
  const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, screenpipe_ref: conv.screenpipe_ref }
  const where = project ? `${conv.tool}, projet ${project}` : conv.tool
  const screen = isScreenCapture(conv)
  const typed = [conv.title, conv.ask, ...(screen ? conv.messages : userMsgs).map((m) => m.text)].filter((t): t is string => Boolean(t))
  const windows = verbatimWindows(typed, MAX_PROMPT_VERBATIM)
  const clip = (t: string) => clipVerbatim(t, windows, MAX_PROMPT_VERBATIM)
  const usable = (s: string) => !looksPersonal(s)
  const items: KnowledgeItemInput[] = []
  const seen = new Set<string>()
  // La zone d'un item se lit sur l'extrait lui-même, pas sur le gabarit (« session claude-code » n'est pas un indice Dev).
  const push = (kind: KnowledgeKind, title: string, body: string, confidence: number, zoneText = `${title} ${body}`) => {
    const t = clip(truncate(title, 140))
    const key = `${kind}:${t.toLowerCase()}`
    if (seen.has(key) || t.length < 8) return
    seen.add(key)
    items.push({ zone: zoneFor(zoneText), kind, title: t, body: clip(truncate(body, 1500)), entities, source, confidence })
  }
  // Ce que l'employé a écrit n'est repris qu'en extrait de 80 caractères ; une phrase de l'assistant, 200 au plus.
  const limitFor = (role: ConversationMessage["role"]) => (screen || role === "user" ? MAX_PROMPT_VERBATIM : MAX_ANSWER_EXCERPT)

  // 1. Résumé de la session : le sujet + deux phrases clés de la réponse finale (extraits séparés, pas la demande brute).
  const gist: string[] = []
  for (const s of sentences(asstMsgs[asstMsgs.length - 1].text)) {
    if (gist.length >= 2) break
    if (usable(s)) gist.push(excerpt(s, screen ? MAX_PROMPT_VERBATIM : 160))
  }
  if (ask && gist.length) push("fact", ask, `Ce qui en est ressorti (${where}) : ${gist.join(" — ")}`, 0.45, `${ask} ${gist.join(" ")}`)

  // Seuls les MAX_ITEMS premiers items sont gardés : au-delà, plus rien n'est lu (ni masqué, ni classé, ni vérifié).
  const full = () => items.length >= MAX_ITEMS

  // 2. Décisions explicites (une question ou une hypothèse n'est pas une décision : « on garde combien de temps ? », « si on garde… »).
  for (const m of conv.messages) {
    if (full()) break
    const max = limitFor(m.role)
    for (const s of sentences(m.text)) {
      if (full()) break
      if (s.trimEnd().endsWith("?")) continue
      const pending = PENDING_RE.test(s)
      if ((!pending && !isDecision(s)) || !usable(s)) continue
      if (pending) push("question", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Question ouverte, session ${where})`, 0.5, s)
      else push("decision", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Décision, session ${where})`, 0.6, s)
    }
  }

  // 3. Tâches.
  for (const m of conv.messages) {
    if (full()) break
    const max = limitFor(m.role)
    for (const line of stripCode(m.text).split("\n")) {
      if (full()) break
      if (!TASK_RE.test(line) || PENDING_RE.test(line) || !usable(line)) continue
      const clean = line.replace(TASK_RE, "").replace(/^[-*\s]+/, "").trim()
      if (clean.length >= 8) push("task", excerpt(clean, Math.min(max, 140)), `${excerpt(clean, max)}\n(À faire, session ${where})`, 0.55, clean)
    }
  }

  // 4. Procédures : une réponse avec au moins 3 étapes numérotées (8 au plus, chacune raccourcie), cf. procedureBody.
  for (const m of full() ? [] : asstMsgs) {
    const steps: string[] = []
    for (const l of stripCode(m.text).split("\n")) {
      if (steps.length >= MAX_STEPS) break
      if (STEP_RE.test(l) && usable(l)) steps.push(l.replace(/^\s*\d+[.)]\s+/, ""))
    }
    if (steps.length >= 3) {
      const subject = ask || excerpt(steps[0], screen ? MAX_PROMPT_VERBATIM : 100)
      const title = /^proc[ée]dure\b/i.test(subject) ? subject : `Procédure : ${subject}`
      const body = procedureBody(steps.map((s) => excerpt(s, screen ? MAX_PROMPT_VERBATIM : 140)))
      push("procedure", title, body, 0.6, `${ask} ${body}`)
      break
    }
  }

  return items.slice(0, MAX_ITEMS)
}

/** Items gardés par session, étapes gardées par procédure. */
const MAX_ITEMS = 6
const MAX_STEPS = 8

/**
 * Corps d'une procédure, une étape par ligne, numérotée « Étape N/M : » (la source a perdu son propre numéro « 1. »).
 * Ni la numérotation de la source (« 1. … »), ni celle qu'un employé tape souvent (« Étape 1 : … ») : la suite des étapes
 * ne recopie pas un bloc de la source (texte capturé, ou demande que l'assistant reprend), et le garde-fou ne coupe qu'une
 * étape trop longue, pas toute la procédure. Une étape qui se nomme déjà (« Étape 1 du runbook ») n'est pas renumérotée.
 */
function procedureBody(steps: string[]): string {
  return steps
    .map((s) => s.replace(STEP_LABEL_RE, "") || s)
    .map((s, i) => (/^(?:[ÉéEe]tape|step)\s?\d/i.test(s) ? s : `Étape ${i + 1}/${steps.length} : ${s}`))
    .join("\n")
}
/** Libellé d'étape déjà présent, gras compris : « Étape 1 : », « **Étape 2 :** », « Step 3. », « Étape 1/5 — ». */
const STEP_LABEL_RE = /^[*_]{0,3}(?:[ÉéEe]tape|step)[ \t]?\d{1,3}(?:\/\d{1,3})?[ \t]?[*_]{0,3}[ \t]?[:.)—–-][ \t]?[*_]{0,3}[ \t]?/i

/** Coupe un texte trop long en morceaux, de préférence en fin de paragraphe, de ligne ou de phrase. */
function splitLong(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const head = rest.slice(0, max)
    let cut = head.lastIndexOf("\n\n")
    if (cut < max / 2) cut = head.lastIndexOf("\n")
    if (cut < max / 2) cut = head.lastIndexOf(". ") + 1
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  out.push(rest.trim())
  return out.filter(Boolean)
}

/**
 * Découpe une conversation trop longue en segments (par messages entiers) pour la distillation.
 * Un message trop long est coupé en morceaux, pas tronqué : la fin d'une longue réponse porte souvent les décisions et
 * les tâches. Les segments qui ne contiennent pas la demande initiale en reçoivent un rappel (`ask`).
 */
export function chunkConversation(conv: Conversation, maxChars = 24000): Conversation[] {
  const pieces = conv.messages.flatMap((m) => (m.text.length > maxChars ? splitLong(m.text, maxChars).map((text) => ({ ...m, text })) : [m]))
  const groups: ConversationMessage[][] = []
  let current: ConversationMessage[] = []
  let size = 0
  for (const m of pieces) {
    if (size + m.text.length > maxChars && current.length > 0) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(m)
    size += m.text.length
  }
  if (current.length) groups.push(current)
  if (groups.length <= 1) return groups.map((messages) => ({ ...conv, messages }))
  const first = conv.messages.find((m) => m.role === "user" && m.text.trim())
  const ask = conv.ask ?? (first ? truncate(first.text.replace(/\s+/g, " ").trim(), 300) : undefined)
  return groups.map((messages, i) => {
    const chunk: Conversation = { ...conv, id: `${conv.id}#${i}`, messages }
    if (ask && !(first && messages.includes(first))) chunk.ask = ask
    return chunk
  })
}

/** Rend une conversation lisible pour un LLM. */
export function renderConversation(conv: Conversation): string {
  const head = [
    `Outil : ${conv.tool} (${conv.app})`,
    conv.cwd ? `Projet / dossier : ${conv.cwd}` : "",
    `Période : ${conv.started_at} → ${conv.ended_at}`,
    conv.ask ? `Demande initiale (rappel, hors de ce segment) : ${conv.ask}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const meeting = conv.tool === "meeting"
  const label = (role: string) => (meeting ? (role === "user" ? "Transcription de la réunion" : "Notes enregistrées") : role === "user" ? "Employé" : "Assistant IA")
  const body = conv.messages.map((m) => `### ${label(m.role)}\n${m.text.trim()}`).join("\n\n")
  return `${head}\n\n${body}`
}
