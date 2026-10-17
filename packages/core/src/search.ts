// Qualité de la recherche : synonymes FR/EN, similarité entre connaissances, fusion de classements.

import { tokenize } from "./text"

/**
 * Familles de termes équivalents (sans accents, minuscules). Une requête qui contient l'un d'eux est étendue aux autres,
 * pour que « deploy » trouve « mise en prod » et « invoice » trouve « facture ». Chaque famille reste courte : trop
 * de synonymes ramènent du bruit.
 */
export const SYNONYMS: string[][] = [
  ["deploy", "deployer", "deploiement", "mise en prod", "mep", "release", "livrer", "livraison"],
  ["prod", "production"],
  ["facture", "factures", "facturation", "invoice", "invoices", "billing"],
  ["paiement", "paiements", "payment", "payments", "reglement"],
  ["client", "clients", "customer", "customers", "compte client"],
  ["prospect", "prospects", "lead", "leads"],
  ["devis", "quote", "quotes", "proposition commerciale"],
  ["tva", "vat"],
  ["cloture", "closing", "cloture mensuelle", "month end"],
  ["rapprochement", "reconciliation", "rapprochement bancaire"],
  ["note de frais", "notes de frais", "expense", "expenses"],
  ["salaire", "salaires", "paie", "payroll"],
  ["recrutement", "recruter", "hiring", "recruiting", "embauche"],
  ["reunion", "reunions", "meeting", "meetings", "call", "point"],
  ["bug", "bugs", "incident", "incidents", "panne", "erreur", "erreurs"],
  ["test", "tests", "e2e", "recette", "qa"],
  ["migration", "migrations", "migrer"],
  ["sauvegarde", "backup", "backups", "restauration", "restore", "restaurer"],
  ["mot de passe", "password", "credentials", "identifiants"],
  ["cle api", "api key", "token", "jeton"],
  ["base de donnees", "database", "db", "bdd", "postgres", "sql"],
  ["serveur", "server", "hebergement", "hosting", "infra"],
  ["tarif", "tarifs", "prix", "pricing", "price", "abonnement", "subscription"],
  ["contrat", "contrats", "contract", "contracts", "cgv"],
  ["support", "ticket", "tickets", "sav", "helpdesk"],
  ["roadmap", "feuille de route", "priorites", "priorite"],
  ["objectif", "objectifs", "goal", "goals", "okr", "kpi"],
  ["tresorerie", "cash", "runway", "burn"],
  ["onboarding", "integration", "arrivee"],
  ["procedure", "procedures", "process", "runbook", "checklist", "how to", "comment faire"],
  ["decision", "decisions", "arbitrage", "choix"],
  ["imprimante", "printer", "ticket de caisse"],
  ["stock", "stocks", "inventaire", "inventory"],
  ["commande", "commandes", "order", "orders", "precommande", "precommandes"],
  ["livraison", "livraisons", "delivery", "shipping"],
]

const family = new Map<string, Set<string>>()
for (const group of SYNONYMS) {
  const norm = group.map((g) => tokenize(g).join(" ")).filter(Boolean)
  for (const term of norm) {
    const set = family.get(term) ?? new Set()
    for (const other of norm) set.add(other)
    family.set(term, set)
  }
}

/**
 * Tokens d'une requête, étendus à leurs synonymes. Les expressions à plusieurs mots (« mise en prod ») sont
 * reconnues sur la suite de tokens ; chaque synonyme ajouté devient un ou plusieurs tokens. Les tokens d'origine
 * sont renvoyés en premier (sans doublon), les ajouts ensuite.
 */
export function expandQuery(query: string): { tokens: string[]; added: string[] } {
  const tokens = [...new Set(tokenize(query))]
  const added = new Set<string>()
  const joined = tokens.join(" ")
  for (const [term, set] of family) {
    const present = term.includes(" ") ? ` ${joined} `.includes(` ${term} `) : tokens.includes(term)
    if (!present) continue
    for (const syn of set) for (const tok of syn.split(" ")) if (!tokens.includes(tok)) added.add(tok)
  }
  return { tokens, added: [...added] }
}

/** Similarité de Jaccard entre deux ensembles de tokens (0 à 1). */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Tokens d'une connaissance (titre, corps, entités), pour comparer deux connaissances. */
export function itemTokens(item: { title: string; body: string; entities?: { name: string }[] }): Set<string> {
  return new Set([...tokenize(item.title), ...tokenize(item.body), ...(item.entities ?? []).flatMap((e) => tokenize(e.name))])
}

export const NEAR_DUPLICATE_THRESHOLD = 0.8
export const SUPERSEDE_TITLE_THRESHOLD = 0.6

export type Likeness = "duplicate" | "supersedes" | "different"

/**
 * Rapport entre une connaissance qui arrive et une déjà en place, dans la même zone :
 * - `duplicate` : même contenu à peu de chose près (Jaccard ≥ 0,8) ;
 * - `supersedes` : même sujet (titres proches, même type « décision », « procédure » ou « fait ») mais contenu différent :
 *   la nouvelle remplace l'ancienne, qui reste consultable mais n'est plus proposée ;
 * - `different` : sans rapport.
 */
export function likeness(
  incoming: { kind: string; title: string; body: string; entities?: { name: string }[] },
  existing: { kind: string; title: string; body: string; entities?: { name: string }[] },
): Likeness {
  const all = jaccard(itemTokens(incoming), itemTokens(existing))
  if (all >= NEAR_DUPLICATE_THRESHOLD) return "duplicate"
  if (incoming.kind !== existing.kind || !["decision", "procedure", "fact"].includes(incoming.kind)) return "different"
  const titles = jaccard(tokenize(incoming.title), tokenize(existing.title))
  if (titles >= SUPERSEDE_TITLE_THRESHOLD && tokenize(incoming.title).length >= 2) return "supersedes"
  return "different"
}

/**
 * Fusion de classements (Reciprocal Rank Fusion) : chaque liste vote pour ses résultats selon leur rang, sans
 * dépendre de l'échelle de ses scores. `k` = 60 (valeur classique). Renvoie les identifiants par score décroissant.
 */
export function rrf(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/** Similarité cosinus entre deux vecteurs de même dimension (0 si l'un est nul ou si les tailles diffèrent). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
