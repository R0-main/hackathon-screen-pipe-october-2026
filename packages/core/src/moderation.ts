// The brain's moderator: every 15 min, Claude (the company's Claude Code in CI, or the server with its key)
// rereads what arrived since the previous run, and keeps, fixes or removes each knowledge item.
// Here: the material shown to it, the reading of its answer and the application of its verdicts (no network).

import { z } from "zod"
import { redactText } from "./privacy"
import { itemTokens, jaccard } from "./search"
import { truncate } from "./text"
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "./types"
import type { ZoneHint } from "./distill"

export const MODERATION_DECISIONS = ["publish", "edit", "reject"] as const
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number]

/** Rejection reasons: only they (not the rejected text) appear in the admins' log. */
export const MODERATION_REASONS = ["personal", "secret", "vague", "duplicate", "injection", "judgment", "other"] as const
export type ModerationReason = (typeof MODERATION_REASONS)[number]

export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  personal: "personal content",
  secret: "secret",
  vague: "too vague or of no value",
  duplicate: "duplicate",
  injection: "suspicious instruction",
  judgment: "judgment about a person",
  other: "other",
}

/** Reason ids of earlier (French) versions: still found in saved logs and sent by older clients. */
const LEGACY_MODERATION_REASONS: Record<string, ModerationReason> = { personnel: "personal", doublon: "duplicate", jugement: "judgment", autre: "other" }

/** A reason id, legacy ones included; null if unknown. */
export function moderationReason(raw: unknown): ModerationReason | null {
  if (typeof raw !== "string") return null
  if ((MODERATION_REASONS as readonly string[]).includes(raw)) return raw as ModerationReason
  return LEGACY_MODERATION_REASONS[raw] ?? null
}

/** Knowledge items reviewed per run (oldest first; the rest waits for the next run). */
export const MODERATION_BATCH = 40
/** Knowledge items per call to Claude when the server does the run (batches reviewed in parallel). */
export const MODERATION_CHUNK = 20
/** Knowledge already published shown next to each proposal (for duplicates). */
export const MODERATION_SIMILAR = 3
const SIMILAR_MIN = 0.15

export type ModerationCandidate = { zone: string; kind: KnowledgeKind; title: string; body: string; entities?: { name: string }[]; source: { tool: string; app?: string } }
export type PublishedItem = { zone: string; kind: string; title: string; body: string; entities?: { name: string }[] }

export type ModerationInput = {
  companyName: string
  zones: ZoneHint[]
  items: {
    ref: number
    /** Id of the knowledge item (to send back the verdicts); never shown to the model. */
    id?: string
    author: string
    zone: string
    kind: string
    title: string
    body: string
    source: string
    similar: { kind: string; title: string; body: string }[]
  }[]
}

export type ModerationVerdict = {
  ref: number
  decision: ModerationDecision
  category: ModerationReason | null
  reason: string
  zone: string | null
  kind: string | null
  title: string | null
  body: string | null
}

/**
 * What the moderator is shown: the knowledge to review (numbered), and for each one the close knowledge already in
 * place in its zone (`published`, which can contain the batch itself: a knowledge item is not compared with itself).
 */
export function buildModerationInput(opts: {
  companyName: string
  zones: ZoneHint[]
  items: (ModerationCandidate & { id?: string; author: string })[]
  published: (PublishedItem & { id?: string })[]
  offset?: number
}): ModerationInput {
  const offset = opts.offset ?? 0
  return {
    companyName: opts.companyName,
    zones: opts.zones,
    items: opts.items.map((i, n) => {
      const tokens = itemTokens(i)
      const similar = opts.published
        .filter((p) => p.zone === i.zone && !(i.id && p.id === i.id))
        .map((p) => ({ p, score: jaccard(tokens, itemTokens(p)) }))
        .filter((s) => s.score >= SIMILAR_MIN)
        .sort((a, b) => b.score - a.score)
        .slice(0, MODERATION_SIMILAR)
        .map(({ p }) => ({ kind: p.kind, title: truncate(p.title, 160), body: truncate(p.body, 300) }))
      return {
        ref: offset + n + 1,
        ...(i.id ? { id: i.id } : {}),
        author: i.author,
        zone: i.zone,
        kind: i.kind,
        title: i.title,
        body: truncate(i.body, 1500),
        source: [i.source.tool, i.source.app].filter(Boolean).join(" / "),
        similar,
      }
    }),
  }
}

export type ModerationOutcome<T> = {
  kept: { index: number; item: T; edited: boolean }[]
  rejected: { index: number; item: T; category: ModerationReason; reason: string }[]
}

/**
 * Applies the verdicts (`ref` = position + 1 in `items`). Without a verdict for a knowledge item (partial answer),
 * it is published as is. A fix is redacted again, and can only target an existing zone or type.
 */
export function applyModeration<T extends ModerationCandidate>(items: T[], verdicts: ModerationVerdict[], zoneIds: Set<string>): ModerationOutcome<T> {
  const byRef = new Map<number, ModerationVerdict>()
  for (const v of verdicts) if (!byRef.has(v.ref)) byRef.set(v.ref, v)
  const out: ModerationOutcome<T> = { kept: [], rejected: [] }
  items.forEach((item, index) => {
    const v = byRef.get(index + 1)
    if (!v || v.decision === "publish") {
      out.kept.push({ index, item, edited: false })
      return
    }
    if (v.decision === "reject") {
      const category = moderationReason(v.category) ?? "other"
      out.rejected.push({ index, item, category, reason: truncate(redactText(v.reason ?? "").trim(), 160) })
      return
    }
    const title = v.title?.trim() ? truncate(redactText(v.title.trim()), 300) : item.title
    const body = v.body?.trim() ? truncate(redactText(v.body.trim()), 8000) : item.body
    const zone = v.zone && zoneIds.has(v.zone) ? v.zone : item.zone
    const kind = v.kind && (KNOWLEDGE_KINDS as readonly string[]).includes(v.kind) ? (v.kind as KnowledgeKind) : item.kind
    const edited = title !== item.title || body !== item.body || zone !== item.zone || kind !== item.kind
    out.kept.push({ index, item: { ...item, title, body, zone, kind }, edited })
  })
  return out
}

export const ModerationVerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      ref: z.number(),
      decision: z.enum(MODERATION_DECISIONS),
      category: z.enum(MODERATION_REASONS).nullable(),
      reason: z.string(),
      zone: z.string().nullable(),
      kind: z.enum(KNOWLEDGE_KINDS).nullable(),
      title: z.string().nullable(),
      body: z.string().nullable(),
    }),
  ),
})

/**
 * Verdicts drawn from the answer of `claude -p` (free text, or `--output-format json` envelope). Tolerant: a malformed
 * verdict is ignored (its knowledge stays published), an unknown category becomes "other". Null: nothing readable.
 */
export function parseModerationJson(text: string): ModerationVerdict[] | null {
  const obj = (t: string): unknown => {
    const s = t.replace(/```(?:json)?/gi, "").trim()
    try {
      return JSON.parse(s)
    } catch {
      const a = s.indexOf("{")
      const b = s.lastIndexOf("}")
      if (a === -1 || b <= a) return null
      try {
        return JSON.parse(s.slice(a, b + 1))
      } catch {
        return null
      }
    }
  }
  let data = obj(text) as { result?: unknown; verdicts?: unknown } | null
  if (data && typeof data.result === "string") data = obj(data.result) as { verdicts?: unknown } | null
  if (!data || !Array.isArray(data.verdicts)) return null
  const out: ModerationVerdict[] = []
  for (const raw of data.verdicts) {
    if (!raw || typeof raw !== "object") continue
    const v = raw as Record<string, unknown>
    const ref = Number(v.ref)
    if (!Number.isInteger(ref) || !(MODERATION_DECISIONS as readonly unknown[]).includes(v.decision)) continue
    const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : null)
    out.push({
      ref,
      decision: v.decision as ModerationDecision,
      category: moderationReason(v.category) ?? (v.decision === "reject" ? "other" : null),
      reason: typeof v.reason === "string" ? v.reason : "",
      zone: str(v.zone),
      kind: str(v.kind),
      title: str(v.title),
      body: str(v.body),
    })
  }
  return out
}
