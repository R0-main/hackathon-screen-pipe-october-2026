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

/** Décisions explicites. Pas de « retenu » ni de « décision » nus (« la retenue à la source », « il faudra une décision »). */
const DECISION_RE =
  /\b(?:on (?:part|est parti|partira) sur|on a (?:d[ée]cid[ée]|tranch[ée]|choisi|retenu|opt[ée] pour|valid[ée])|nous avons (?:d[ée]cid[ée]|choisi|retenu)|j'ai (?:d[ée]cid[ée]|tranch[ée])|il a [ée]t[ée] d[ée]cid[ée]|c'est d[ée]cid[ée]|d[ée]cision\s*:|d[ée]cision prise|on garde|on choisit|on opte|on retient|(?:solution|option|approche|piste|offre) retenue|retenu\s*:|on va utiliser|on utilisera|we(?:'ll| will) (?:use|go with)|let'?s (?:use|go with)|we decided|decided to|we chose|go avec|valid[ée]\s*:)/i
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

/** Noms d'outils qui sont aussi des mots courants (« vue d'ensemble », « aucune notion », « make sure ») : casse exacte, hors début de phrase. */
const AMBIGUOUS_TOOLS = new Set([
  "Vue", "Node", "Bun", "Deno", "Linear", "Notion", "Slack", "Excel", "Make", "Alan", "Mistral", "Codex", "React", "Drizzle",
  "Tailwind", "Prisma", "Swile", "Sentry", "Claude",
])
/** Outils retenus seulement avec un indice de contexte (Alan est aussi un prénom). */
const TOOL_CONTEXT: Record<string, RegExp> = {
  Alan: /\b(?:mutuelle|assurance|sant[ée]|pr[ée]voyance|insurance)\b/i,
  Make: /\b(?:make\.com|integromat|zapier|n8n|sc[ée]nario|automatisation|automation|workflow)\b/i,
}

function toolMentioned(tool: string, text: string): boolean {
  const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (!AMBIGUOUS_TOOLS.has(tool)) return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(text)
  if (new RegExp(`(^|[^A-Za-z0-9])${esc}\\.js\\b`, "i").test(text)) return true
  const context = TOOL_CONTEXT[tool]
  if (context && !context.test(text)) return false
  for (const m of text.matchAll(new RegExp(`(^|[^A-Za-z0-9\\-])${esc}(?![A-Za-z0-9\\-'’])`, "g"))) {
    const at = (m.index ?? 0) + m[1].length
    if (/^\s?\d/.test(text.slice(at + tool.length))) return true // « Vue 3 », « Node 22 »
    const before = text.slice(0, at).replace(/[\s"'«(*_`>#\-]+$/, "")
    if (before === "" || /[.!?:\n]$/.test(before)) continue // début de phrase : « Vue d'ensemble… », « Make sure… »
    return true
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

/**
 * Distille une conversation en items de connaissance, sans LLM.
 * Rien de brut : titres et corps sont de courts extraits re-masqués (≤ 140 / 240 caractères) ou des gabarits.
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
  const ask = askText ? excerpt(firstSentence(askText, 200), 120) : ""
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
  const context = ask ? `\nContexte : ${excerpt(ask, 100)}` : ""
  const usable = (s: string) => !looksPersonal(s)
  const items: KnowledgeItemInput[] = []
  const seen = new Set<string>()
  const push = (kind: KnowledgeKind, title: string, body: string, confidence: number) => {
    const key = `${kind}:${title.toLowerCase()}`
    if (seen.has(key) || title.length < 8) return
    seen.add(key)
    items.push({ zone: zoneFor(`${title} ${body}`), kind, title: truncate(title, 140), body: truncate(body, 1500), entities, source, confidence })
  }

  // 1. Résumé de la session : le sujet + deux phrases clés de la réponse finale (extraits courts, pas la demande brute).
  const gist = sentences(asstMsgs[asstMsgs.length - 1].text)
    .filter(usable)
    .slice(0, 2)
    .map((s) => excerpt(s, 160))
  if (ask && gist.length) {
    const where = project ? ` (${conv.tool}, projet ${project})` : ` (${conv.tool})`
    push("fact", ask, `Ce qui en est ressorti${where} : ${gist.join(" ")}`, 0.45)
  }

  // 2. Décisions explicites (une question n'est pas une décision : « on garde combien de temps ? »).
  for (const m of conv.messages) {
    for (const s of sentences(m.text)) {
      if (s.trimEnd().endsWith("?") || !usable(s)) continue
      if (PENDING_RE.test(s)) push("question", excerpt(s, 140), `${excerpt(s, 240)}${context}`, 0.5)
      else if (DECISION_RE.test(s)) push("decision", excerpt(s, 140), `${excerpt(s, 240)}${context}`, 0.6)
    }
  }

  // 3. Tâches.
  for (const m of conv.messages) {
    for (const line of stripCode(m.text).split("\n")) {
      if (!TASK_RE.test(line) || PENDING_RE.test(line) || !usable(line)) continue
      const clean = line.replace(TASK_RE, "").replace(/^[-*\s]+/, "").trim()
      if (clean.length >= 8) push("task", excerpt(clean, 140), `${excerpt(clean, 240)}${context}`, 0.55)
    }
  }

  // 4. Procédures : une réponse avec au moins 3 étapes numérotées (8 au plus, chacune raccourcie).
  for (const m of asstMsgs) {
    const steps = stripCode(m.text)
      .split("\n")
      .filter((l) => STEP_RE.test(l) && usable(l))
    if (steps.length >= 3) {
      const title = `Procédure : ${ask || excerpt(steps[0].replace(/^\s*\d+[.)]\s+/, ""), 100)}`
      push("procedure", title, steps.slice(0, 8).map((s) => excerpt(s, 140)).join("\n"), 0.6)
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
  const meeting = conv.tool === "meeting"
  const label = (role: string) => (meeting ? (role === "user" ? "Transcription de la réunion" : "Notes enregistrées") : role === "user" ? "Employé" : "Assistant IA")
  const body = conv.messages.map((m) => `### ${label(m.role)}\n${m.text.trim()}`).join("\n\n")
  return `${head}\n\n${body}`
}
