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
  SUPERSEDE_SYSTEM,
  buildExtractionPrompt,
  buildStatusPrompt,
  buildSupersedePrompt,
  buildTriagePrompt,
  renderZones,
} from "./prompts"
import { buildStatusInput, type StatusInput } from "./status"
import type { SupersedeComparable } from "./supersede"
import { classifyZones, slugify } from "./zones"
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
  // Zone inconnue : mots-clés, et à égalité la zone de repli (celle de la conversation) plutôt que la première de la liste.
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

const SupersedeSchema = z.object({ replaced: z.array(z.number().int()) })

/**
 * Parmi `older` (candidates déjà choisies par supersedeCandidates), lesquelles `item` remplace : leurs identifiants.
 * Null si Claude n'a pas répondu (l'appelant retombe sur l'heuristique).
 */
export async function judgeSupersession(client: Anthropic, item: SupersedeComparable, older: SupersedeComparable[]): Promise<string[] | null> {
  if (older.length === 0) return []
  const view = (i: SupersedeComparable) => ({ title: i.title, body: i.body, at: i.source?.at || i.created_at })
  try {
    const response = await client.messages.parse({
      model: TRIAGE_MODEL,
      max_tokens: 2000,
      system: SUPERSEDE_SYSTEM,
      messages: [{ role: "user", content: buildSupersedePrompt(view(item), older.map(view)) }],
      output_config: { effort: "low", format: zodOutputFormat(SupersedeSchema) },
    })
    if (response.stop_reason === "refusal" || !response.parsed_output) return null
    return [...new Set(response.parsed_output.replaced)].filter((n) => n >= 1 && n <= older.length).map((n) => older[n - 1].id)
  } catch (err) {
    logError("remplacement", err)
    return null
  }
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

/** Résumé d'état à partir de la matière déjà préparée (serveur, ou poste d'un admin avec une clé API). */
export async function summarizeStatusInput(client: Anthropic, input: StatusInput): Promise<CompanyStatus | null> {
  try {
    const parsed = await parseWithSonnet(client, StatusSchema, STATUS_SYSTEM, buildStatusPrompt(input), "medium")
    if (!parsed) return null
    const known = new Set(input.zones.map((z) => z.id))
    const zones = new Map<string, (typeof parsed.zones)[number]>()
    for (const z of parsed.zones) if (known.has(z.zone) && !zones.has(z.zone)) zones.set(z.zone, z)
    return { headline: parsed.headline, zones: [...zones.values()], generated_at: new Date().toISOString(), generator: "claude" }
  } catch (err) {
    logError("résumé d'état", err)
    return null
  }
}

/** Résumé d'état côté serveur : même matière (30 jours, 400 connaissances) et même prompt que sur un poste. */
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
 * Identifiants de zone propres (slug sans accents, « service_client » → « service-client », sans doublon) et
 * correspondance depuis ce que Claude a pu écrire dans les items (id d'origine, nom de zone, variantes de casse).
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
  // Les identifiants d'abord, les noms ensuite : un nom ne masque jamais l'identifiant d'une autre zone.
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
    const { zones, zoneId } = normalizeOnboardingZones(parsed.zones)
    const hints = zones.map((z) => ({ ...z }))
    const source = { app: "dashboard", tool: "onboarding" as const, at: new Date().toISOString() }
    return {
      company_name: parsed.company_name,
      description: parsed.description,
      zones,
      // Les items citent les identifiants d'origine (« service_client ») : on les fait suivre le renommage.
      items: parsed.items.map((i) => toKnowledgeInput({ ...i, zone: zoneId(i.zone) ?? i.zone }, hints, source, zones[0]?.id ?? "direction")),
    }
  } catch (err) {
    logError("onboarding", err)
    return null
  }
}
