// Distillation heuristique (sans LLM) : sert de repli quand aucune clé Claude n'est disponible,
// et de garde-fou en test. La version Claude est dans claude.ts.

import type { Entity, KnowledgeItemInput, KnowledgeKind, SourceTool, Zone } from "./types"
import { classifyZones } from "./zones"
import { firstSentence, truncate } from "./text"

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

const DECISION_RE =
  /\b(on part sur|on a d[ée]cid[ée]|d[ée]cision|on garde|on choisit|on opte|on retient|retenu|on va utiliser|on utilisera|we('ll| will) (use|go with)|let'?s (use|go with)|decided|we chose|go avec|valid[ée] :)/i
const TASK_RE =
  /^\s*(?:[-*]\s*\[ \]\s*|TODO[:\s]|[àa] faire\s*:|reste [àa]\s|next steps?\s*:?|prochaines? [ée]tapes?\s*:?|il faudra\s|penser [àa]\s)/i
const STEP_RE = /^\s*(\d+)[.)]\s+\S/

function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400)
}

export function extractEntities(text: string, cwd?: string): Entity[] {
  const found = new Map<string, Entity>()
  const add = (e: Entity) => found.set(`${e.type}:${e.name.toLowerCase()}`, e)
  for (const tool of KNOWN_TOOLS) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i")
    if (re.test(text)) add({ type: "tool", name: tool })
  }
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

/** Distille une conversation en items de connaissance, sans LLM. */
export function distillHeuristic(conv: Conversation, zones: ZoneHint[], fallbackZone?: string): KnowledgeItemInput[] {
  const userMsgs = conv.messages.filter((m) => m.role === "user" && m.text.trim())
  const asstMsgs = conv.messages.filter((m) => m.role === "assistant" && m.text.trim())
  if (userMsgs.length === 0 || asstMsgs.length === 0) return []

  const all = conv.messages.map((m) => m.text).join("\n")
  const zone = classifyZones(all, zones, 1)[0] ?? fallbackZone ?? zones[0]?.id ?? "general"
  const entities = extractEntities(all, conv.cwd)
  const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, screenpipe_ref: conv.screenpipe_ref }
  const items: KnowledgeItemInput[] = []
  const seen = new Set<string>()
  const push = (kind: KnowledgeKind, title: string, body: string, confidence: number) => {
    const key = `${kind}:${title.toLowerCase()}`
    if (seen.has(key) || title.length < 8) return
    seen.add(key)
    const itemZone = classifyZones(`${title} ${body}`, zones, 1)[0] ?? zone
    items.push({ zone: itemZone, kind, title: truncate(title, 140), body: truncate(body, 1500), entities, source, confidence })
  }

  // 1. Résumé de la session : la demande + l'essentiel de la réponse finale.
  const ask = firstSentence(conv.title || userMsgs[0].text, 120)
  const lastAnswer = asstMsgs[asstMsgs.length - 1].text
  const answerGist = sentences(lastAnswer).slice(0, 3).join(" ")
  if (answerGist) push("fact", ask, `Demande : ${truncate(userMsgs[0].text.trim(), 300)}\n\nCe qui en est ressorti : ${answerGist}`, 0.45)

  // 2. Décisions explicites.
  for (const m of conv.messages) {
    for (const s of sentences(m.text)) {
      if (DECISION_RE.test(s)) push("decision", firstSentence(s, 140), s, 0.6)
    }
  }

  // 3. Tâches.
  for (const m of conv.messages) {
    for (const line of m.text.split("\n")) {
      if (TASK_RE.test(line)) {
        const clean = line.replace(TASK_RE, "").replace(/^[-*\s]+/, "").trim()
        if (clean.length >= 8) push("task", truncate(clean, 140), clean, 0.55)
      }
    }
  }

  // 4. Procédures : une réponse avec au moins 3 étapes numérotées.
  for (const m of asstMsgs) {
    const steps = m.text.split("\n").filter((l) => STEP_RE.test(l))
    if (steps.length >= 3) {
      push("procedure", `Procédure : ${ask}`, steps.slice(0, 12).map((s) => s.trim()).join("\n"), 0.6)
      break
    }
  }

  return items.slice(0, 6)
}

/** Découpe une conversation trop longue en segments (par messages entiers) pour la distillation. */
export function chunkConversation(conv: Conversation, maxChars = 24000): Conversation[] {
  const chunks: Conversation[] = []
  let current: ConversationMessage[] = []
  let size = 0
  for (const m of conv.messages) {
    const len = m.text.length
    if (size + len > maxChars && current.length > 0) {
      chunks.push({ ...conv, id: `${conv.id}#${chunks.length}`, messages: current })
      current = []
      size = 0
    }
    current.push(len > maxChars ? { ...m, text: m.text.slice(0, maxChars) } : m)
    size += Math.min(len, maxChars)
  }
  if (current.length) chunks.push({ ...conv, id: chunks.length ? `${conv.id}#${chunks.length}` : conv.id, messages: current })
  return chunks
}

/** Rend une conversation lisible pour un LLM. */
export function renderConversation(conv: Conversation): string {
  const head = [`Outil : ${conv.tool} (${conv.app})`, conv.cwd ? `Projet / dossier : ${conv.cwd}` : "", `Période : ${conv.started_at} → ${conv.ended_at}`]
    .filter(Boolean)
    .join("\n")
  const body = conv.messages.map((m) => `### ${m.role === "user" ? "Employé" : "Assistant IA"}\n${m.text.trim()}`).join("\n\n")
  return `${head}\n\n${body}`
}
