// Validation des charges utiles reçues par l'API du cerveau.

import { z } from "zod"
import { AGENTS, ENTITY_TYPES, EVENT_TYPES, KNOWLEDGE_KINDS, SOURCE_TOOLS } from "./types"

export const KnowledgeItemInputSchema = z.object({
  zone: z.string().min(1).max(64),
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().min(1).max(300),
  body: z.string().max(8000).default(""),
  entities: z
    .array(z.object({ type: z.enum(ENTITY_TYPES), name: z.string().min(1).max(120) }))
    .max(20)
    .default([]),
  source: z.object({
    app: z.string().max(120).default("unknown"),
    tool: z.enum(SOURCE_TOOLS).default("agent"),
    at: z.string().max(40).default(() => new Date().toISOString()),
    screenpipe_ref: z.string().max(200).optional(),
    session_id: z.string().max(200).optional(),
  }),
  confidence: z.number().min(0).max(1).default(0.6),
})

export const IngestPayloadSchema = z.object({ items: z.array(KnowledgeItemInputSchema).min(1).max(200) })

export const AgentEventInputSchema = z.object({
  agent: z.enum(AGENTS),
  type: z.enum(EVENT_TYPES),
  zones: z.array(z.string().max(64)).max(10).optional(),
  summary: z.string().max(500).optional(),
  fingerprint: z.string().max(64).optional(),
  session_id: z.string().max(200).optional(),
  at: z.string().max(40).optional(),
})

export const EventsPayloadSchema = z.union([
  AgentEventInputSchema,
  z.object({ events: z.array(AgentEventInputSchema).min(1).max(200) }),
])

export const QueryPayloadSchema = z.object({
  query: z.string().min(1).max(500),
  zones: z.array(z.string().max(64)).max(20).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  agent: z.enum(AGENTS).optional(),
})

/** Compte rendu de synchronisation d'un poste (POST /api/sync/report). */
export const SyncReportSchema = z.object({
  at: z.string().max(40),
  ok: z.boolean(),
  duration_ms: z.number().int().min(0).max(86_400_000),
  items_sent: z.number().int().min(0).max(100_000),
  duplicates: z.number().int().min(0).max(100_000).default(0),
  conversations: z.record(z.string().max(32), z.number().int().min(0).max(100_000)).default({}),
  distiller: z.string().max(40).default("heuristic"),
  failed: z.number().int().min(0).max(100_000).default(0),
  deferred: z.number().int().min(0).max(100_000).default(0),
  error: z.string().max(1000).optional(),
  client_version: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
  screenpipe: z.boolean().optional(),
})

/** Un résumé de zone produit hors du serveur (poste d'un admin, `claude -p`). */
export const ZoneStatusSchema = z.object({
  zone: z.string().min(1).max(64),
  summary: z.string().max(4000).default(""),
  objectives: z.array(z.string().max(1000)).max(20).default([]),
  progress: z.string().max(2000).default(""),
  next_steps: z.array(z.string().max(1000)).max(20).default([]),
  who_did_what: z.array(z.object({ person: z.string().max(200), did: z.string().max(1000) })).max(30).default([]),
})

/** POST /api/status avec un résumé déjà généré : { status: { headline, zones } }. */
export const StatusPayloadSchema = z.object({
  status: z.object({ headline: z.string().min(1).max(2000), zones: z.array(ZoneStatusSchema).max(64) }),
})
