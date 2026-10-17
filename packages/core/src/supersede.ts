// Décisions remplacées : une connaissance plus récente qui contredit ou met à jour une ancienne (« on passe de Stripe à
// Mollie ») la marque comme remplacée. L'ancienne reste consultable, mais passe derrière dans les recherches et sort de
// l'état de l'entreprise. Ici : le choix des candidates et l'heuristique sans LLM ; le jugement par Claude est dans claude.ts.

import { normalize, tokenize } from "./text"
import type { KnowledgeItem, KnowledgeKind } from "./types"

/** Ce qui peut être remplacé : une tâche se termine, une question trouve sa réponse, mais ne se « contredit » pas. */
export const SUPERSEDABLE_KINDS: readonly KnowledgeKind[] = ["decision", "procedure", "fact"]

/** Au plus autant de candidates soumises au jugement pour une nouvelle connaissance. */
export const MAX_SUPERSEDE_CANDIDATES = 5

export type SupersedeComparable = Pick<KnowledgeItem, "id" | "zone" | "kind" | "title" | "body" | "entities" | "source" | "created_at"> & {
  superseded_by?: string
}

/** Tournures de changement (texte sans accents) : seules, elles ne disent pas QUOI est remplacé. */
const CHANGE_CUE_RE =
  /\b(?:on passe (?:de|a|sur|sous|chez)|passer (?:de|a|sur|chez)|passe (?:de|a) |remplace|remplacer|remplacent|remplacee?s?|au lieu de|a la place de|abandonne|abandonner|abandonnee?s?|on arrete|n'utilise plus|n'utilisons plus|ne plus utiliser|desormais|dorenavant|a partir de maintenant|finalement|on change|changement de|migre (?:de|vers)|migrer (?:de|vers)|migration (?:de|vers)|nouvelle (?:procedure|regle|version|politique)|nouveau (?:process|processus|fournisseur|prestataire|tarif|prix)|mise a jour|mis a jour|annule|annulee?|revient sur|n'est plus|ne sont plus|plus que)\b/
/** Mots des tournures de changement : ils ne disent rien du sujet, on les retire avant de comparer. */
const CUE_WORDS = new Set(["passe", "passer", "remplace", "remplacer", "remplacent", "remplacee", "remplacees", "lieu", "place", "abandonne", "abandonner", "abandonnee", "abandonnees", "arrete", "utilise", "utilisons", "utiliser", "desormais", "dorenavant", "partir", "maintenant", "finalement", "change", "changement", "migre", "migrer", "migration", "nouvelle", "nouveau", "procedure", "regle", "version", "mise", "mis", "jour", "annule", "annulee", "revient", "decide", "decision", "choisi", "choix"])

const stem = (t: string) => (t.length > 3 ? t.replace(/(?:es|s|x)$/, "") : t)
const words = (s: string) => tokenize(s).filter((t) => !CUE_WORDS.has(t)).map(stem)

/** Sujet d'une connaissance : les mots du titre et les noms des entités citées. */
function subject(i: SupersedeComparable): Set<string> {
  return new Set([...words(i.title), ...i.entities.flatMap((e) => words(e.name))])
}

const entityKeys = (i: SupersedeComparable) => new Set(i.entities.map((e) => `${e.type}:${normalize(e.name).trim()}`))
const when = (i: SupersedeComparable) => i.source?.at || i.created_at

export type SupersedeMatch = { shared: number; sharedEntities: number; jaccard: number }

/** Recouvrement des sujets de deux connaissances. */
export function subjectOverlap(a: SupersedeComparable, b: SupersedeComparable): SupersedeMatch {
  const sa = subject(a)
  const sb = subject(b)
  const shared = [...sa].filter((t) => sb.has(t)).length
  const union = new Set([...sa, ...sb]).size
  const eb = entityKeys(b)
  const sharedEntities = [...entityKeys(a)].filter((k) => eb.has(k)).length
  return { shared, sharedEntities, jaccard: union ? shared / union : 0 }
}

/**
 * Connaissances plus anciennes qui parlent du même sujet que `item` (même zone, même type, toujours d'actualité), les plus
 * proches d'abord. « Plus ancienne » se juge sur la date de la session d'origine, pas sur celle de l'envoi : une vieille
 * conversation synchronisée en retard ne remplace jamais une décision plus récente.
 */
export function supersedeCandidates<T extends SupersedeComparable>(item: SupersedeComparable, pool: T[], max = MAX_SUPERSEDE_CANDIDATES): T[] {
  if (!SUPERSEDABLE_KINDS.includes(item.kind)) return []
  const at = when(item)
  return pool
    .filter((o) => o.id !== item.id && !o.superseded_by && o.zone === item.zone && o.kind === item.kind && when(o) < at)
    .map((o) => ({ o, m: subjectOverlap(item, o) }))
    .filter(({ m }) => m.shared >= 2 || (m.shared >= 1 && m.sharedEntities >= 1))
    .sort((a, b) => b.m.jaccard + 0.15 * b.m.sharedEntities - (a.m.jaccard + 0.15 * a.m.sharedEntities) || when(b.o).localeCompare(when(a.o)))
    .slice(0, max)
    .map(({ o }) => o)
}

const sameText = (a: string, b: string) => normalize(a).replace(/\s+/g, " ").trim() === normalize(b).replace(/\s+/g, " ").trim()

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  const union = new Set([...sa, ...sb]).size
  return union ? [...sa].filter((t) => sb.has(t)).length / union : 0
}

/**
 * Sans LLM, on ne remplace qu'à coup sûr : même titre et contenu proche mais différent (version à jour d'une procédure,
 * d'un chiffre), ou une tournure de changement explicite (« on passe de Stripe à Mollie ») sur un sujet nettement commun.
 * Un même titre ne suffit pas : une même conversation peut produire plusieurs faits distincts sous le même titre.
 */
export function heuristicSupersedes(item: SupersedeComparable, old: SupersedeComparable): boolean {
  if (sameText(item.title, old.title)) return !sameText(item.body, old.body) && jaccard(words(item.body), words(old.body)) >= 0.5
  if (!CHANGE_CUE_RE.test(normalize(`${item.title}\n${item.body}`).replace(/[’`]/g, "'"))) return false
  const m = subjectOverlap(item, old)
  return m.jaccard >= 0.5 && (m.shared >= 2 || m.sharedEntities >= 1)
}
