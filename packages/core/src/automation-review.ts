// Revue des automatisations par Claude : l'heuristique (detectAutomations) trouve les prompts relancés au même créneau ;
// Claude écarte ce qui ne mérite pas d'être automatisé et réécrit les autres en une proposition concrète (quoi, comment,
// pour qui), d'après le prompt et les connaissances récentes de la zone. Il ne touche jamais aux faits : personne,
// zone, créneau, preuves et temps gagné restent ceux de l'heuristique.

import type { AutomationCandidate } from "./automation"
import type { KnowledgeItem, Profile, Zone } from "./types"
import { truncate } from "./text"

export type AutomationReviewInput = {
  company_name: string
  /** `ref` : numéro court que Claude cite, plutôt que la clé de la suggestion. */
  candidates: { ref: number; person: string; zone?: string; schedule?: string; sample?: string; occurrences: number; days: number }[]
  /** Titres des connaissances récentes de chaque zone concernée : de quoi rendre la proposition concrète. */
  context: { zone: string; titles: string[] }[]
}

export type AutomationReview = { ref: number; keep: boolean; title: string; description: string }

export function buildAutomationReviewInput(input: {
  companyName: string
  candidates: AutomationCandidate[]
  zones: Pick<Zone, "id" | "name">[]
  profiles: Pick<Profile, "id" | "name">[]
  items: Pick<KnowledgeItem, "zone" | "title">[]
}): AutomationReviewInput {
  const zoneName = new Map(input.zones.map((z) => [z.id, z.name]))
  const person = new Map(input.profiles.map((p) => [p.id, p.name]))
  const zones = [...new Set(input.candidates.map((c) => c.zone).filter((z): z is string => Boolean(z)))]
  return {
    company_name: input.companyName,
    candidates: input.candidates.map((c, n) => ({
      ref: n + 1,
      person: (c.user_id && person.get(c.user_id)) || "Quelqu'un",
      zone: c.zone ? (zoneName.get(c.zone) ?? c.zone) : undefined,
      schedule: c.schedule,
      sample: c.evidence.sample ? truncate(c.evidence.sample, 200) : undefined,
      occurrences: c.evidence.occurrences,
      days: c.evidence.days,
    })),
    context: zones.map((z) => ({
      zone: zoneName.get(z) ?? z,
      titles: input.items.filter((i) => i.zone === z).slice(0, 8).map((i) => truncate(i.title, 120)),
    })),
  }
}

/**
 * Applique les avis de Claude : `keep: false` écarte la suggestion (elle n'est pas créée ; une suggestion déjà
 * enregistrée, acceptée ou non, reste telle quelle), un avis retenu remplace titre et description (bornés). Une
 * suggestion sans avis, ou citée par un numéro inconnu, garde le texte de l'heuristique.
 */
export function applyAutomationReviews(candidates: AutomationCandidate[], reviews: AutomationReview[]): AutomationCandidate[] {
  const byRef = new Map<number, AutomationReview>()
  for (const r of reviews) if (!byRef.has(r.ref)) byRef.set(r.ref, r)
  const out: AutomationCandidate[] = []
  for (const [n, c] of candidates.entries()) {
    const r = byRef.get(n + 1)
    if (r && !r.keep) continue
    const title = r ? truncate(r.title.replace(/\s+/g, " ").trim(), 120) : ""
    const description = r ? truncate(r.description.replace(/\s+/g, " ").trim(), 600) : ""
    out.push({ ...c, title: title || c.title, description: description || c.description })
  }
  return out
}
