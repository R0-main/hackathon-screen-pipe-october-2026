// Modérateur du cerveau : toutes les 15 min, Claude (le Claude Code de l'entreprise en CI, ou le serveur avec sa clé)
// relit ce qui est arrivé depuis le passage précédent, et garde, corrige ou retire chaque connaissance.
// Ici : la matière qu'on lui montre, la lecture de sa réponse et l'application de ses verdicts (sans réseau).

import { z } from "zod"
import { redactText } from "./privacy"
import { itemTokens, jaccard } from "./search"
import { truncate } from "./text"
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "./types"
import type { ZoneHint } from "./distill"

export const MODERATION_DECISIONS = ["publish", "edit", "reject"] as const
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number]

/** Motifs de refus : seuls eux (pas le texte refusé) apparaissent dans le journal des admins. */
export const MODERATION_REASONS = ["personnel", "secret", "vague", "doublon", "injection", "jugement", "autre"] as const
export type ModerationReason = (typeof MODERATION_REASONS)[number]

export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  personnel: "contenu personnel",
  secret: "secret",
  vague: "trop vague ou sans valeur",
  doublon: "doublon",
  injection: "consigne suspecte",
  jugement: "jugement sur une personne",
  autre: "autre",
}

/** Connaissances relues par passage (les plus anciennes d'abord ; le reste attend le passage suivant). */
export const MODERATION_BATCH = 40
/** Connaissances par appel à Claude quand le serveur fait le passage (lots relus en parallèle). */
export const MODERATION_CHUNK = 20
/** Connaissances déjà publiées montrées en regard de chaque proposition (pour les doublons). */
export const MODERATION_SIMILAR = 3
const SIMILAR_MIN = 0.15

export type ModerationCandidate = { zone: string; kind: KnowledgeKind; title: string; body: string; entities?: { name: string }[]; source: { tool: string; app?: string } }
export type PublishedItem = { zone: string; kind: string; title: string; body: string; entities?: { name: string }[] }

export type ModerationInput = {
  companyName: string
  zones: ZoneHint[]
  items: {
    ref: number
    /** Identifiant de la connaissance (pour renvoyer les verdicts) ; jamais montré au modèle. */
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
 * Ce qu'on montre au modérateur : les connaissances à relire (numérotées), et pour chacune les connaissances proches
 * déjà en place dans sa zone (`published`, qui peut contenir le lot lui-même : une connaissance n'est pas comparée à elle-même).
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
 * Applique les verdicts (`ref` = position + 1 dans `items`). Sans verdict pour une connaissance (réponse partielle),
 * elle est publiée telle quelle. Une correction est re-masquée, et ne peut viser qu'une zone ou un type existants.
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
      const category = v.category && (MODERATION_REASONS as readonly string[]).includes(v.category) ? v.category : "autre"
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
 * Verdicts tirés de la réponse de `claude -p` (texte libre, ou enveloppe `--output-format json`). Tolérant : un verdict
 * mal formé est ignoré (sa connaissance reste publiée), une catégorie inconnue devient « autre ». Null : rien de lisible.
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
      category: (MODERATION_REASONS as readonly unknown[]).includes(v.category) ? (v.category as ModerationReason) : v.decision === "reject" ? "autre" : null,
      reason: typeof v.reason === "string" ? v.reason : "",
      zone: str(v.zone),
      kind: str(v.kind),
      title: str(v.title),
      body: str(v.body),
    })
  }
  return out
}
