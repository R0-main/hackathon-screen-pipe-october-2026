// Claude calls (official SDK): triage, extraction, status summary, onboarding.
// Each function returns null on failure or refusal: the caller then falls back to the heuristic.

import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import { z } from "zod"
import type { Conversation, ZoneHint } from "./distill"
import type { CompanyStatus, KnowledgeItem, KnowledgeItemInput, Profile, Task, Zone } from "./types"
import { ENTITY_TYPES, KNOWLEDGE_KINDS } from "./types"
import {
  DISTILL_SYSTEM,
  MODERATION_SYSTEM,
  NEW_ZONES_SYSTEM,
  ONBOARDING_SYSTEM,
  STATUS_SYSTEM,
  buildExtractionPrompt,
  buildModerationPrompt,
  buildNewZonesPrompt,
  buildStatusPrompt,
  buildTriagePrompt,
  renderZones,
} from "./prompts"
import { buildStatusInput, type StatusInput } from "./status"
import type { NewZoneProposal, NewZonesInput } from "./new-zones"
import { ModerationVerdictsSchema, type ModerationInput, type ModerationVerdict } from "./moderation"
import { CORE_ZONE, classifyZones, isCoreZone, slugify } from "./zones"
import { truncate } from "./text"

/** Haiku to triage the volume, Sonnet to extract and summarize (see ARCHITECTURE.md). */
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
  if (err instanceof Anthropic.AuthenticationError) console.error(`[claude] ${where}: invalid API key`)
  else if (err instanceof Anthropic.RateLimitError) console.error(`[claude] ${where}: rate limit reached`)
  else if (err instanceof Anthropic.APIError) console.error(`[claude] ${where}: API error ${err.status} — ${err.message}`)
  else console.error(`[claude] ${where}:`, err instanceof Error ? err.message : err)
}

/** Sonnet call with automatic server-side fallback on refusal (`fallbacks` parameter). */
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
  // Unknown zone: keywords, and on a tie the fallback zone (the conversation's) rather than the first of the list.
  const zone = zoneIds.has(parsed.zone) ? parsed.zone : (classifyZones(`${parsed.title} ${parsed.body}`, zones, 1, { prefer: [fallbackZone] })[0] ?? fallbackZone)
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
    logError("triage", err)
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

/** Haiku triage then Sonnet extraction. `null` = Claude unavailable (the caller uses the heuristic). */
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

/** Status summary from already prepared material (server, or an admin's workstation with an API key). */
export async function summarizeStatusInput(client: Anthropic, input: StatusInput): Promise<CompanyStatus | null> {
  try {
    const parsed = await parseWithSonnet(client, StatusSchema, STATUS_SYSTEM, buildStatusPrompt(input), "medium")
    if (!parsed) return null
    const known = new Set(input.zones.map((z) => z.id))
    const zones = new Map<string, (typeof parsed.zones)[number]>()
    for (const z of parsed.zones) if (known.has(z.zone) && !zones.has(z.zone)) zones.set(z.zone, z)
    return { headline: parsed.headline, zones: [...zones.values()], generated_at: new Date().toISOString(), generator: "claude" }
  } catch (err) {
    logError("status summary", err)
    return null
  }
}

/** Server-side status summary: same material (30 days, 400 items) and same prompt as on a workstation. */
export async function summarizeStatus(
  client: Anthropic,
  input: { zones: Zone[]; items: KnowledgeItem[]; tasks: Task[]; profiles: Pick<Profile, "id" | "name">[]; companyName: string },
): Promise<CompanyStatus | null> {
  return summarizeStatusInput(client, buildStatusInput(input))
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

/**
 * Clean zone ids (slug without accents, "customer_service" → "customer-service", no duplicates) and
 * mapping from what Claude may have written in the items (original id, zone name, case variants).
 */
export function normalizeOnboardingZones<Z extends { id: string; name: string }>(
  raw: Z[],
): { zones: (Z & { id: string })[]; zoneId: (ref: string) => string | undefined } {
  const used = new Set<string>()
  const map = new Map<string, string>()
  const zones = raw.map((z) => {
    const base = slugify(z.id || z.name)
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 29).replace(/-+$/, "")}-${n}`
    used.add(id)
    return { ...z, id }
  })
  // Ids first, names second: a name never shadows another zone's id.
  const keys = (z: Z) => [[z.id, z.id.trim().toLowerCase(), slugify(z.id || z.name)], [z.name.trim().toLowerCase(), slugify(z.name)]]
  for (const pass of [0, 1]) {
    raw.forEach((z, i) => {
      for (const k of keys(z)[pass]) if (k && !map.has(k)) map.set(k, zones[i].id)
    })
  }
  const zoneId = (ref: string) => map.get(ref) ?? map.get(ref.trim().toLowerCase()) ?? map.get(slugify(ref))
  return { zones, zoneId }
}

export async function synthesizeOnboarding(
  client: Anthropic,
  input: { answers: { question: string; answer: string }[]; pages: { url: string; title: string; text: string }[]; existingZones: ZoneHint[] },
): Promise<OnboardingDraft | null> {
  const interview = input.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
  const pages = input.pages.map((p) => `<page url="${p.url}" title="${p.title}">\n${p.text}\n</page>`).join("\n\n")
  try {
    const parsed = await parseWithSonnet(
      client,
      OnboardingSchema,
      ONBOARDING_SYSTEM,
      `Existing zones:\n${renderZones(input.existingZones)}\n\n<interview>\n${interview}\n</interview>\n\n<pages>\n${pages || "(none)"}\n</pages>`,
      "high",
    )
    if (!parsed) return null
    // The core is in every brain: never a proposed zone, always a zone its items may go to.
    const { zones, zoneId } = normalizeOnboardingZones(parsed.zones.filter((z) => !isCoreZone(slugify(z.id || z.name))))
    const hints = [...zones.map((z) => ({ ...z })), CORE_ZONE]
    const source = { app: "dashboard", tool: "onboarding" as const, at: new Date().toISOString() }
    return {
      company_name: parsed.company_name,
      description: parsed.description,
      zones,
      // Items cite the original ids ("customer_service"): they follow the renaming.
      items: parsed.items.map((i) =>
        toKnowledgeInput({ ...i, zone: isCoreZone(slugify(i.zone)) ? CORE_ZONE.id : (zoneId(i.zone) ?? i.zone) }, hints, source, zones[0]?.id ?? "leadership"),
      ),
    }
  } catch (err) {
    logError("onboarding", err)
    return null
  }
}

const NewZonesSchema = z.object({
  zones: z.array(z.object({ name: z.string(), description: z.string(), keywords: z.array(z.string()), items: z.array(z.number()) })),
})

/** New zones to create from recent knowledge ([] most of the time). Null if Claude did not answer. */
export async function proposeNewZones(client: Anthropic, input: NewZonesInput): Promise<NewZoneProposal[] | null> {
  try {
    const parsed = await parseWithSonnet(client, NewZonesSchema, NEW_ZONES_SYSTEM, buildNewZonesPrompt(input), "medium")
    return parsed ? parsed.zones : null
  } catch (err) {
    logError("new zones", err)
    return null
  }
}

/** The moderator's verdicts on a batch of knowledge (Sonnet, low effort). Null if Claude did not answer. */
export async function moderateKnowledge(client: Anthropic, input: ModerationInput): Promise<ModerationVerdict[] | null> {
  try {
    const parsed = await parseWithSonnet(client, ModerationVerdictsSchema, MODERATION_SYSTEM, buildModerationPrompt(input), "low")
    return parsed ? parsed.verdicts : null
  } catch (err) {
    logError("moderation", err)
    return null
  }
}
