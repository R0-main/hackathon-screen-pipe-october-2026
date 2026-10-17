// Distillation heuristique (sans LLM) : sert de repli quand aucune clé Claude n'est disponible,
// et de garde-fou en test. La version Claude est dans claude.ts.
// « Rien de brut » : l'heuristique ne produit que des gabarits et de courts extraits re-masqués.

import type { Entity, KnowledgeItemInput, KnowledgeKind, SourceTool, Zone } from "./types"
import { scoreZones } from "./zones"
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
/** Verbe juste après le nom : « Sentry est déployé », « Notion est notre wiki », « Slack envoie les alertes ». */
const TOOL_VERB_AFTER_RE =
  /^\s+(?:est|sont|était|sera|reste|tourne|plante|crashe|remonte|envoie|notifie|alerte|synchronise|gère|héberge|stocke|permet|sert|fonctionne|marche|is|was|runs|sends|stores|lets|handles)\b/
/** En-tête d'une liste d'outils : « Outils recommandés : », « Stack : », « Intégrations ». */
const TOOL_HEADER_RE = /\b(?:outils?|stack|tools?|logiciels?|apps?|applis?|applications?|services?|int[ée]grations?|plateformes?|saas|technos?|technologies?)\b/i
const BULLET_RE = /^\s*(?:[-*•·+]|\d+[.)]|[a-z][.)])\s+/
const COORD = String.raw`\s*(?:,|/|\+|&|\bet\b|\bou\b|\band\b|\bor\b)\s*`
const TOOL_THEN_COORD_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${ANY_TOOL_SRC})${COORD}$`)
const COORD_THEN_TOOL_RE = new RegExp(`^${COORD}(?:${ANY_TOOL_SRC})(?![A-Za-z0-9])`)
/** Puce qui commence par un outil sans ambiguïté (« - Stripe pour les paiements »). */
const PLAIN_TOOL_HEAD_RE = new RegExp(
  `^(?:${KNOWN_TOOLS.filter((t) => !AMBIGUOUS_TOOLS.has(t)).map(escapeRe).sort((a, b) => b.length - a.length).join("|")})(?![A-Za-z0-9])`,
  "i",
)
/** Une liste plus longue n'est lue que sur 30 lignes autour de la puce : coût borné. */
const BLOCK_SPAN = 30

/** Lignes de la liste à puces qui contient la ligne `i` (vide si ce n'est pas une puce), et l'en-tête qui la précède. */
function bulletBlock(lines: string[], i: number): { start: number; items: string[]; header: string } {
  if (!BULLET_RE.test(lines[i])) return { start: i, items: [], header: "" }
  let a = i
  while (a > 0 && i - a < BLOCK_SPAN && BULLET_RE.test(lines[a - 1])) a--
  let b = i
  while (b + 1 < lines.length && b - i < BLOCK_SPAN && BULLET_RE.test(lines[b + 1])) b++
  let h = a - 1
  while (h >= 0 && a - h < BLOCK_SPAN && !lines[h].trim()) h--
  return { start: a, items: lines.slice(a, b + 1), header: h >= 0 && !BULLET_RE.test(lines[h]) ? lines[h] : "" }
}

/**
 * Un nom d'outil ambigu (casse exacte) à la position `at` est-il l'outil ? Il faut un indice :
 * - un numéro de version ou une extension (« Vue 3 », « Node 22 », « vue.js ») ;
 * - au milieu d'une phrase, derrière un mot qui n'est pas un déterminant (« dans Notion », « le fichier Excel », « l'API Slack ») :
 *   un nom commun prendrait un article (« la Notion de marge ») et un titre commence par ce mot (« ## 📊 Vue mensuelle ») ;
 * - une préposition et un article (« sur le Slack ») ;
 * - un verbe juste après (« Sentry est déployé en prod », « Notion est notre wiki ») ;
 * - une énumération avec un autre outil (« Notion et Slack ») ;
 * - une liste d'outils : en-tête « Outils : » / « Stack : », ou une autre puce qui commence par un outil sans ambiguïté.
 */
function ambiguousToolAt(
  tool: string,
  text: string,
  at: number,
  lines: string[],
  lineIndex: number,
  lineStart: number,
  blocks: Map<number, boolean>,
): boolean {
  const after = text.slice(at + tool.length, at + tool.length + 60)
  const before = text.slice(Math.max(lineStart, at - 200), at)
  if (/^\s?\d/.test(after) || /^\.(?:js|com|so|app|io)\b/i.test(after)) return true
  if (tool === "Vue" && /^\s+d['’]ensemble/i.test(after)) return false
  // Mot précédent, sur la même ligne : un mot ordinaire (pas un déterminant) ⇒ milieu de phrase.
  const prev = /([A-Za-zÀ-ÿ]+)['’]?\s*$/.exec(before)
  if (prev && /[A-Za-zÀ-ÿ'’]\s*$/.test(before) && !DETERMINERS.has(prev[1].toLowerCase())) return true
  if (PREP_ARTICLE_RE.test(before)) return true
  if (TOOL_VERB_AFTER_RE.test(after)) return true
  // Énumération : « Notion et Slack », « Stripe, Notion », « Slack / Linear ».
  if (TOOL_THEN_COORD_RE.test(before.slice(-40)) || COORD_THEN_TOOL_RE.test(after)) return true
  // Liste d'outils (puces) : en-tête explicite, ou une autre puce qui commence par un outil sans ambiguïté.
  if (TOOL_HEADER_RE.test(before)) return true
  const block = bulletBlock(lines, lineIndex)
  if (block.items.length === 0) return false
  // Verdict mémorisé par liste : une longue liste de « - Vue mensuelle » n'est pas relue à chaque puce.
  let listOfTools = blocks.get(block.start)
  if (listOfTools === undefined) {
    listOfTools =
      TOOL_HEADER_RE.test(block.header) || block.items.some((l) => PLAIN_TOOL_HEAD_RE.test(l.replace(BULLET_RE, "").replace(/^[*_`\s]+/, "")))
    blocks.set(block.start, listOfTools)
  }
  return listOfTools
}

function toolMentioned(tool: string, text: string): boolean {
  const esc = escapeRe(tool)
  if (!AMBIGUOUS_TOOLS.has(tool)) return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(text)
  if (new RegExp(`(^|[^A-Za-z0-9])${esc}\\.js\\b`, "i").test(text)) return true
  const context = TOOL_CONTEXT[tool]
  if (context && !context.test(text)) return false
  let lines: string[] | null = null
  const blocks = new Map<number, boolean>()
  // Numéro de ligne tenu à jour au fil des occurrences (croissantes) : pas de recomptage depuis le début du texte.
  let lineIndex = 0
  let scanned = 0
  for (const m of text.matchAll(new RegExp(`(^|[^A-Za-z0-9\\-])${esc}(?![A-Za-z0-9\\-'’])`, "g"))) {
    const at = (m.index ?? 0) + m[1].length
    for (let i = text.indexOf("\n", scanned); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) {
      lineIndex++
      scanned = i + 1
    }
    lines ??= text.split("\n")
    if (ambiguousToolAt(tool, text, at, lines, lineIndex, scanned, blocks)) return true
  }
  return false
}

export function extractEntities(text: string, cwd?: string): Entity[] {
  const found = new Map<string, Entity>()
  const add = (e: Entity) => found.set(`${e.type}:${e.name.toLowerCase()}`, e)
  for (const tool of KNOWN_TOOLS) if (toolMentioned(tool, text)) add({ type: "tool", name: tool })
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

/** Fenêtres de `max + 1` caractères des textes de l'employé (espaces normalisés, déjà masqués) : un passage plus long recopié s'y retrouve. */
function verbatimWindows(texts: string[], max: number): Set<string> {
  const out = new Set<string>()
  for (const t of texts) {
    const s = redactText(t.replace(/\s+/g, " ").trim())
    for (let i = 0; i + max < s.length; i++) out.add(s.slice(i, i + max + 1))
  }
  return out
}

/** Raccourcit tout passage de plus de `max` caractères recopié tel quel (garde-fou final, quel que soit le gabarit). */
function clipVerbatim(field: string, windows: Set<string>, max: number): string {
  const w = max + 1
  if (windows.size === 0 || field.length < w) return field
  let out = ""
  let from = 0
  for (let i = 0; i + w <= field.length; ) {
    if (!windows.has(field.slice(i, i + w))) {
      i++
      continue
    }
    let end = i + w
    while (end < field.length && windows.has(field.slice(end + 1 - w, end + 1))) end++
    out += `${field.slice(from, i + max - 1).trimEnd()}… `
    from = end
    i = end
  }
  // « …car la l… … — » : une coupe juste avant l'ellipse d'un extrait déjà raccourci n'en ajoute pas une seconde.
  return (out + field.slice(from)).replace(/…\s*…/g, "…").trim()
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
  const askZone = askText ? scoreZones(askText, zones)[0]?.zone : undefined
  const zone =
    scoreZones(`${conv.title ?? ""}\n${conv.ask ?? ""}\n${all}`, zones, { prefer: [askZone, fallbackZone] })[0]?.zone ??
    fallbackZone ??
    zones[0]?.id ??
    "general"
  // Une ligne isolée ne change de zone que sur un indice net (≥ 2 mots-clés et 1 point d'avance), jamais sur une égalité.
  const zoneFor = (text: string): string => {
    const scores = scoreZones(text, zones, { prefer: [zone] })
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
  const gist = sentences(asstMsgs[asstMsgs.length - 1].text)
    .filter(usable)
    .slice(0, 2)
    .map((s) => excerpt(s, screen ? MAX_PROMPT_VERBATIM : 160))
  if (ask && gist.length) push("fact", ask, `Ce qui en est ressorti (${where}) : ${gist.join(" — ")}`, 0.45, `${ask} ${gist.join(" ")}`)

  // 2. Décisions explicites (une question ou une hypothèse n'est pas une décision : « on garde combien de temps ? », « si on garde… »).
  for (const m of conv.messages) {
    const max = limitFor(m.role)
    for (const s of sentences(m.text)) {
      if (s.trimEnd().endsWith("?") || !usable(s)) continue
      if (PENDING_RE.test(s)) push("question", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Question ouverte, session ${where})`, 0.5, s)
      else if (isDecision(s)) push("decision", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Décision, session ${where})`, 0.6, s)
    }
  }

  // 3. Tâches.
  for (const m of conv.messages) {
    const max = limitFor(m.role)
    for (const line of stripCode(m.text).split("\n")) {
      if (!TASK_RE.test(line) || PENDING_RE.test(line) || !usable(line)) continue
      const clean = line.replace(TASK_RE, "").replace(/^[-*\s]+/, "").trim()
      if (clean.length >= 8) push("task", excerpt(clean, Math.min(max, 140)), `${excerpt(clean, max)}\n(À faire, session ${where})`, 0.55, clean)
    }
  }

  // 4. Procédures : une réponse avec au moins 3 étapes numérotées (8 au plus, chacune raccourcie).
  for (const m of asstMsgs) {
    const steps = stripCode(m.text)
      .split("\n")
      .filter((l) => STEP_RE.test(l) && usable(l))
    if (steps.length >= 3) {
      const subject = ask || excerpt(steps[0].replace(/^\s*\d+[.)]\s+/, ""), screen ? MAX_PROMPT_VERBATIM : 100)
      const title = /^proc[ée]dure\b/i.test(subject) ? subject : `Procédure : ${subject}`
      const body = steps.slice(0, 8).map((s) => excerpt(s, screen ? MAX_PROMPT_VERBATIM : 140)).join("\n")
      push("procedure", title, body, 0.6, `${ask} ${body}`)
      break
    }
  }

  return items.slice(0, 6)
}

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
  const body = conv.messages.map((m) => `### ${m.role === "user" ? "Employé" : "Assistant IA"}\n${m.text.trim()}`).join("\n\n")
  return `${head}\n\n${body}`
}
