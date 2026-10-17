// Nouvelles zones créées automatiquement : chaque jour, Claude relit les connaissances récentes et repère un domaine de
// travail qui n'a pas de zone à lui (du juridique rangé faute de mieux dans « Direction »…). Rien n'attend de validation :
// les garde-fous ci-dessous décident seuls de ce qui est créé, et l'ordre des zones existantes n'est jamais touché.

import { z } from "zod"
import type { KnowledgeItem, KnowledgeKind, Zone } from "./types"
import type { ZoneHint } from "./distill"
import { jsonObjects } from "./status"
import { normalize, truncate } from "./text"
import { slugify } from "./zones"

/** Matière relue : les connaissances des 30 derniers jours, 300 au plus (les plus récentes). */
export const NEW_ZONES_WINDOW_DAYS = 30
export const NEW_ZONES_MAX_ITEMS = 300
/** En dessous, il n'y a pas de quoi voir émerger un domaine : Claude n'est pas appelé. */
export const NEW_ZONES_MIN_CORPUS = 12
/** Une nouvelle zone doit rassembler au moins ce nombre de connaissances déjà dans le cerveau. */
export const NEW_ZONE_MIN_ITEMS = 4
export const NEW_ZONES_PER_RUN = 2
/** Au-delà, le cerveau devient illisible : plus aucune zone n'est créée automatiquement. */
export const MAX_ZONES = 12

export type NewZonesInput = {
  company_name: string
  zones: ZoneHint[]
  /** `ref` : numéro court que Claude cite (moins de jetons qu'un UUID, et pas d'identifiant inventé). */
  items: { ref: number; id: string; author_id: string; zone: string; kind: KnowledgeKind; title: string; body: string }[]
}

/** Ce que Claude propose : `items` = numéros (`ref`) des connaissances à ranger dans la nouvelle zone. */
export type NewZoneProposal = { name: string; description: string; keywords: string[]; items: number[] }

export type NewZonePlan = {
  zone: { id: string; name: string; description: string; keywords: string[] }
  /** Connaissances déplacées, avec leur zone d'origine (pour reporter les droits de lecture). */
  items: { id: string; author_id: string; from: string }[]
}

export function buildNewZonesInput(input: { companyName: string; zones: Zone[]; items: KnowledgeItem[] }): NewZonesInput {
  return {
    company_name: input.companyName,
    zones: input.zones.map(({ id, name, description, keywords }) => ({ id, name, description, keywords })),
    items: input.items.slice(0, NEW_ZONES_MAX_ITEMS).map((i, n) => ({
      ref: n + 1,
      id: i.id,
      author_id: i.author_id,
      zone: i.zone,
      kind: i.kind,
      title: truncate(i.title, 140),
      body: truncate(i.body.replace(/\s+/g, " "), 240),
    })),
  }
}

/**
 * Garde-fous appliqués à la proposition de Claude, puisque personne ne la relit :
 * - jamais plus de NEW_ZONES_PER_RUN zones par passage, ni plus de MAX_ZONES au total ;
 * - jamais de doublon d'une zone existante (même identifiant, même nom, ou nom qui donne le même identifiant) ;
 * - au moins NEW_ZONE_MIN_ITEMS connaissances réellement fournies, chacune déplacée une seule fois ;
 * - noms, descriptions et mots-clés bornés comme dans l'admin.
 */
export function planNewZones(proposals: NewZoneProposal[], input: NewZonesInput, existing: Pick<Zone, "id" | "name">[]): NewZonePlan[] {
  const room = Math.min(NEW_ZONES_PER_RUN, MAX_ZONES - existing.length)
  if (room <= 0) return []
  const byRef = new Map(input.items.map((i) => [i.ref, i]))
  const takenIds = new Set(existing.flatMap((z) => [z.id, slugify(z.name)]))
  const takenNames = new Set(existing.map((z) => normalize(z.name).trim()))
  const claimed = new Set<number>()
  const out: NewZonePlan[] = []
  for (const p of proposals) {
    if (out.length >= room) break
    const name = p.name.replace(/\s+/g, " ").trim().slice(0, 40).trim()
    if (!name) continue
    const id = slugify(name)
    if (takenIds.has(id) || takenNames.has(normalize(name).trim())) continue
    const refs = [...new Set(p.items)].filter((r) => byRef.has(r) && !claimed.has(r))
    if (refs.length < NEW_ZONE_MIN_ITEMS) continue
    for (const r of refs) claimed.add(r)
    takenIds.add(id)
    takenNames.add(normalize(name).trim())
    const keywords = [...new Set(p.keywords.map((k) => normalize(k).trim()).filter((k) => k.length >= 2 && k.length <= 40))].slice(0, 25)
    out.push({
      zone: { id, name, description: truncate(p.description.replace(/\s+/g, " ").trim(), 300), keywords },
      items: refs.map((r) => {
        const i = byRef.get(r)!
        return { id: i.id, author_id: i.author_id, from: i.zone }
      }),
    })
  }
  return out
}

/**
 * Qui lit la nouvelle zone : ses auteurs, et chaque membre qui lisait TOUTES les zones d'où viennent ses connaissances.
 * Personne ne perd donc de vue une connaissance qu'il lisait, et personne n'en découvre une qu'il ne pouvait pas lire.
 * Les admins lisent tout de toute façon : seuls les membres sont concernés.
 */
export function readersOfNewZone(plan: NewZonePlan, members: { id: string; readable: string[] }[]): string[] {
  const sources = [...new Set(plan.items.map((i) => i.from))]
  const authors = new Set(plan.items.map((i) => i.author_id))
  return members.filter((m) => authors.has(m.id) || sources.every((z) => m.readable.includes(z))).map((m) => m.id)
}

const LooseProposalSchema = z.object({
  name: z.string(),
  description: z.string().catch(""),
  keywords: z.array(z.unknown()).catch([]),
  items: z.array(z.unknown()).catch([]),
})

/**
 * Réponse de `claude -p` (abonnement Claude Code, sur un poste ou en CI) : tolère le texte autour, un bloc de code,
 * l'enveloppe JSON de la CLI, et des numéros écrits « #12 » ou « 12 ». `[]` si Claude ne propose rien, null si illisible.
 */
export function parseNewZonesJson(text: string): NewZoneProposal[] | null {
  if (typeof text !== "string" || !text.trim()) return null
  const objects = jsonObjects(text)
  const envelope = objects.find((o) => !("zones" in o) && ("result" in o || "structured_output" in o || "is_error" in o))
  if (envelope && !objects.some((o) => "zones" in o)) {
    if (envelope.is_error === true) return null
    if (envelope.structured_output && typeof envelope.structured_output === "object") return parseNewZonesJson(JSON.stringify(envelope.structured_output))
    return typeof envelope.result === "string" ? parseNewZonesJson(envelope.result) : null
  }
  const candidate = objects.find((o) => Array.isArray(o.zones))
  if (!candidate) return null
  const out: NewZoneProposal[] = []
  for (const raw of candidate.zones as unknown[]) {
    const parsed = LooseProposalSchema.safeParse(raw)
    if (!parsed.success) continue
    const p = parsed.data
    out.push({
      name: p.name,
      description: p.description,
      keywords: p.keywords.filter((k): k is string => typeof k === "string"),
      items: p.items.map((r) => (typeof r === "number" ? r : Number(String(r).replace(/^#/, "")))).filter((r) => Number.isInteger(r)),
    })
  }
  return out
}
