// Appels Claude (SDK officiel) : tri, extraction, résumé d'état, onboarding.
// Chaque fonction renvoie null en cas d'échec ou de refus : l'appelant retombe alors sur l'heuristique.

import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import { z } from "zod"
import type { Conversation, ZoneHint } from "./distill"
import type { CompanyStatus, KnowledgeItem, KnowledgeItemInput, Profile, Task, Zone } from "./types"
import { ENTITY_TYPES, KNOWLEDGE_KINDS } from "./types"
import {
  DISTILL_SYSTEM,
  ONBOARDING_SYSTEM,
  STATUS_SYSTEM,
  buildExtractionPrompt,
  buildTriagePrompt,
  renderZones,
} from "./prompts"
import { classifyZones } from "./zones"
import { truncate } from "./text"

/** Haiku pour trier le volume, Sonnet pour extraire et résumer (cf. ARCHITECTURE.md). */
export const TRIAGE_MODEL = "claude-haiku-5-5"
export const EXTRACT_MODEL = "claude-sonnet-5-5"

export function hasClaudeCredentials(apiKey?: string): boolean {
  return Boolean(apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

export function createClaude(apiKey?: string): Anthropic | null {
  if (!hasClaudeCredentials(apiKey)) return null
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic()
}

const EntitySchema = z.object({ type: z.enum(ENTITY_TYPES), name: z.string() })
const ItemSchema = z.object({
  zone: z.string(),
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string(),
  body: z.string(),
  entities: z.array(EntitySchema),
  confidence: z.number(),
})
const ExtractionSchema = z.object({ items: z.array(ItemSchema) })
const TriageSchema = z.object({ useful: z.boolean(), zone: z.string(), reason: z.string() })

type ParsedItem = z.infer<typeof ItemSchema>

function logError(where: string, err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) console.error(`[claude] ${where} : clé API invalide`)
  else if (err instanceof Anthropic.RateLimitError) console.error(`[claude] ${where} : limite de débit atteinte`)
  else if (err instanceof Anthropic.APIError) console.error(`[claude] ${where} : erreur API ${err.status} — ${err.message}`)
  else console.error(`[claude] ${where} :`, err instanceof Error ? err.message : err)
}

/** Appel Sonnet avec repli serveur automatique en cas de refus (paramètre `fallbacks`). */
async function parseWithSonnet<T extends z.ZodType>(
  client: Anthropic,
  schema: T,
  system: string,
  prompt: string,
  effort: "low" | "medium" | "high",
): Promise<z.infer<T> | null> {
  const response = await client.beta.messages.parse({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort, format: zodOutputFormat(schema) },
  })
  if (response.stop_reason === "refusal") return null
  return (response.parsed_output as z.infer<T> | null) ?? null
}

export function toKnowledgeInput(
  parsed: ParsedItem,
  zones: ZoneHint[],
  source: KnowledgeItemInput["source"],
  fallbackZone: string,
): KnowledgeItemInput {
  const zoneIds = new Set(zones.map((z) => z.id))
  const zone = zoneIds.has(parsed.zone) ? parsed.zone : (classifyZones(`${parsed.title} ${parsed.body}`, zones, 1)[0] ?? fallbackZone)
  return {
    zone,
    kind: parsed.kind,
    title: truncate(parsed.title.trim(), 140),
    body: truncate(parsed.body.trim(), 2000),
    entities: parsed.entities.filter((e) => e.name.trim()).slice(0, 10),
    source,
    confidence: Math.max(0, Math.min(1, Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5)),
  }
}

export async function triageConversation(
  client: Anthropic,
  conv: Conversation,
  zones: ZoneHint[],
): Promise<{ useful: boolean; zone: string; reason: string } | null> {
  try {
    const response = await client.messages.parse({
      model: TRIAGE_MODEL,
      max_tokens: 2000,
      system: DISTILL_SYSTEM,
      messages: [{ role: "user", content: buildTriagePrompt(conv, zones) }],
      output_config: { effort: "low", format: zodOutputFormat(TriageSchema) },
    })
    if (response.stop_reason === "refusal") return null
    return response.parsed_output ?? null
  } catch (err) {
    logError("tri", err)
    return null
  }
}

export async function extractKnowledge(
  client: Anthropic,
  conv: Conversation,
  zones: ZoneHint[],
  fallbackZone: string,
): Promise<KnowledgeItemInput[] | null> {
  try {
    const parsed = await parseWithSonnet(client, ExtractionSchema, DISTILL_SYSTEM, buildExtractionPrompt(conv, zones), "medium")
    if (!parsed) return null
    const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, screenpipe_ref: conv.screenpipe_ref }
    return parsed.items.slice(0, 6).map((i) => toKnowledgeInput(i, zones, source, fallbackZone))
  } catch (err) {
    logError("extraction", err)
    return null
  }
}

/** Tri Haiku puis extraction Sonnet. `null` = Claude indisponible (l'appelant utilise l'heuristique). */
export async function distillWithClaude(
  client: Anthropic,
  conv: Conversation,
  zones: ZoneHint[],
  fallbackZone: string,
): Promise<KnowledgeItemInput[] | null> {
  const triage = await triageConversation(client, conv, zones)
  if (triage && !triage.useful) return []
  const zone = triage && zones.some((z) => z.id === triage.zone) ? triage.zone : fallbackZone
  return extractKnowledge(client, conv, zones, zone)
}

const StatusSchema = z.object({
  headline: z.string(),
  zones: z.array(
    z.object({
      zone: z.string(),
      summary: z.string(),
      objectives: z.array(z.string()),
      progress: z.string(),
      next_steps: z.array(z.string()),
      who_did_what: z.array(z.object({ person: z.string(), did: z.string() })),
    }),
  ),
})

export async function summarizeStatus(
  client: Anthropic,
  input: { zones: Zone[]; items: KnowledgeItem[]; tasks: Task[]; profiles: Pick<Profile, "id" | "name">[]; companyName: string },
): Promise<CompanyStatus | null> {
  const names = new Map(input.profiles.map((p) => [p.id, p.name]))
  const sections = input.zones.map((z) => {
    const items = input.items
      .filter((i) => i.zone === z.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 40)
      .map((i) => `- [${i.kind}] ${i.title} — ${truncate(i.body, 220)} (par ${names.get(i.author_id) ?? "?"}, ${i.created_at.slice(0, 10)})`)
    const tasks = input.tasks
      .filter((t) => t.zone === z.id)
      .slice(0, 20)
      .map((t) => `- [${t.status === "done" ? "fait" : "à faire"}] ${t.title}${t.assignee_id ? ` (${names.get(t.assignee_id) ?? "?"})` : ""}`)
    return `## Zone ${z.id} (${z.name})\nConnaissances récentes :\n${items.join("\n") || "(aucune)"}\nTâches :\n${tasks.join("\n") || "(aucune)"}`
  })
  try {
    const parsed = await parseWithSonnet(
      client,
      StatusSchema,
      STATUS_SYSTEM,
      `Entreprise : ${input.companyName}\nDate : ${new Date().toISOString().slice(0, 10)}\n\n${sections.join("\n\n")}`,
      "medium",
    )
    if (!parsed) return null
    const known = new Set(input.zones.map((z) => z.id))
    return {
      headline: parsed.headline,
      zones: parsed.zones.filter((z) => known.has(z.zone)),
      generated_at: new Date().toISOString(),
      generator: "claude",
    }
  } catch (err) {
    logError("résumé d'état", err)
    return null
  }
}

const OnboardingSchema = z.object({
  company_name: z.string(),
  description: z.string(),
  zones: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), keywords: z.array(z.string()) })),
  items: z.array(ItemSchema),
})

export type OnboardingDraft = {
  company_name: string
  description: string
  zones: { id: string; name: string; description: string; keywords: string[] }[]
  items: KnowledgeItemInput[]
}

export async function synthesizeOnboarding(
  client: Anthropic,
  input: { answers: { question: string; answer: string }[]; pages: { url: string; title: string; text: string }[]; existingZones: ZoneHint[] },
): Promise<OnboardingDraft | null> {
  const interview = input.answers.map((a) => `Q : ${a.question}\nR : ${a.answer}`).join("\n\n")
  const pages = input.pages.map((p) => `<page url="${p.url}" title="${p.title}">\n${p.text}\n</page>`).join("\n\n")
  try {
    const parsed = await parseWithSonnet(
      client,
      OnboardingSchema,
      ONBOARDING_SYSTEM,
      `Zones existantes :\n${renderZones(input.existingZones)}\n\n<interview>\n${interview}\n</interview>\n\n<pages>\n${pages || "(aucune)"}\n</pages>`,
      "high",
    )
    if (!parsed) return null
    const zones = parsed.zones.map((z) => ({ ...z, id: z.id.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "zone" }))
    const hints = zones.map((z) => ({ ...z }))
    const source = { app: "dashboard", tool: "onboarding" as const, at: new Date().toISOString() }
    return {
      company_name: parsed.company_name,
      description: parsed.description,
      zones,
      items: parsed.items.map((i) => toKnowledgeInput(i, hints, source, zones[0]?.id ?? "direction")),
    }
  } catch (err) {
    logError("onboarding", err)
    return null
  }
}
