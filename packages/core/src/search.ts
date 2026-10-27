// Search quality: synonyms, similarity between items, rank fusion.

import { tokenize } from "./text"

/**
 * Families of equivalent terms (without accents, lowercase). A query containing one of them is expanded to the others,
 * so that "deploy" finds "ship to prod" and "invoice" finds "billing". Each family stays short: too many
 * synonyms bring noise.
 */
export const SYNONYMS: string[][] = [
  ["deploy", "deploys", "deployment", "ship to prod", "go live", "release", "ship", "rollout"],
  ["prod", "production"],
  ["invoice", "invoices", "invoicing", "billing", "bill"],
  ["payment", "payments", "pay", "settlement"],
  ["client", "clients", "customer", "customers"],
  ["prospect", "prospects", "lead", "leads"],
  ["quote", "quotes", "estimate", "proposal"],
  ["vat", "sales tax"],
  ["closing", "month end", "month-end close", "close"],
  ["reconciliation", "reconcile", "bank reconciliation"],
  ["expense", "expenses", "expense report", "receipts"],
  ["salary", "salaries", "payroll", "wages"],
  ["hiring", "recruiting", "recruitment", "hire"],
  ["meeting", "meetings", "call", "standup"],
  ["bug", "bugs", "incident", "incidents", "outage", "error", "errors"],
  ["test", "tests", "e2e", "qa"],
  ["migration", "migrations", "migrate"],
  ["backup", "backups", "restore", "restoring"],
  ["password", "passwords", "credentials", "login"],
  ["api key", "token", "secret"],
  ["database", "db", "postgres", "sql"],
  ["server", "servers", "hosting", "infra", "infrastructure"],
  ["price", "prices", "pricing", "subscription"],
  ["contract", "contracts", "terms", "agreement"],
  ["support", "ticket", "tickets", "helpdesk"],
  ["roadmap", "priorities", "priority"],
  ["goal", "goals", "objective", "objectives", "okr", "kpi"],
  ["cash", "treasury", "runway", "burn"],
  ["onboarding", "ramp up", "first week"],
  ["procedure", "procedures", "process", "runbook", "checklist", "how to"],
  ["decision", "decisions", "trade off", "choice"],
  ["printer", "receipt printer"],
  ["stock", "inventory"],
  ["order", "orders", "preorder", "preorders"],
  ["delivery", "deliveries", "shipping"],
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
 * Tokens of a query, expanded to their synonyms. Multi-word expressions ("ship to prod") are
 * recognized on the token sequence; each added synonym becomes one or more tokens. The original tokens
 * come first (no duplicates), the additions after.
 */
export function expandQuery(query: string): { tokens: string[]; added: string[] } {
  const tokens = [...new Set(tokenize(query))]
  const added = new Set<string>()
  const joined = tokens.join(" ")
  for (const [term, set] of family) {
    const present = term.includes(" ") ? ` ${joined} `.includes(` ${term} `) : tokens.includes(term)
    if (!present) continue
    // A short word taken out of an expression ("go" from "go live", "up" from "ramp up") would match anything.
    for (const syn of set) for (const tok of syn.split(" ")) if (!tokens.includes(tok) && (tok.length >= 3 || !syn.includes(" "))) added.add(tok)
  }
  return { tokens, added: [...added] }
}

/** Same rule as the stores: a query token matches as is, or as a prefix from 4 characters. */
function tokenMatches(queryToken: string, itemToken: string): boolean {
  return itemToken === queryToken || (queryToken.length >= 4 && itemToken.startsWith(queryToken))
}

/**
 * Strength of the match between a query (tokens already expanded) and an item: number of query tokens
 * found, and how many in the title or the entities. Used to drop results that only synonyms
 * bring back on an isolated word of the body ("prod" catching "product").
 */
export function matchStrength(queryTokens: string[], item: { title: string; body: string; entities?: { name: string }[] }): { total: number; title: number } {
  const title = [...tokenize(item.title), ...(item.entities ?? []).flatMap((e) => tokenize(e.name))]
  const body = tokenize(item.body)
  let total = 0
  let inTitle = 0
  for (const q of new Set(queryTokens)) {
    const t = title.some((x) => tokenMatches(q, x))
    if (t) inTitle++
    if (t || body.some((x) => tokenMatches(q, x))) total++
  }
  return { total, title: inTitle }
}

/** A result obtained only through synonyms is kept only if it rests on more than one isolated word of the body. */
export function strongEnough(s: { total: number; title: number }): boolean {
  return s.title >= 1 || s.total >= 2
}

/** Jaccard similarity between two token sets (0 to 1). */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Tokens of an item (title, body, entities), to compare two items. */
export function itemTokens(item: { title: string; body: string; entities?: { name: string }[] }): Set<string> {
  return new Set([...tokenize(item.title), ...tokenize(item.body), ...(item.entities ?? []).flatMap((e) => tokenize(e.name))])
}

export const NEAR_DUPLICATE_THRESHOLD = 0.8
export const SUPERSEDE_TITLE_THRESHOLD = 0.6

export type Likeness = "duplicate" | "supersedes" | "different"

/**
 * Relationship between an incoming item and one already in place, in the same zone:
 * - `duplicate`: nearly the same content (Jaccard ≥ 0.8);
 * - `supersedes`: same subject (close titles, same "decision", "procedure" or "fact" kind) but different content:
 *   the new one replaces the old one, which stays viewable but is no longer suggested;
 * - `different`: unrelated.
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
 * Rank fusion (Reciprocal Rank Fusion): each list votes for its results by rank, without
 * depending on the scale of its scores. `k` = 60 (classic value). `weights`: how much each list's vote counts (1 by
 * default). Returns the ids by decreasing score.
 */
export function rrf(lists: string[][], k = 60, weights: number[] = []): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  lists.forEach((list, n) => {
    const w = weights[n] ?? 1
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + w / (k + rank + 1)))
  })
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/**
 * Narrows a search: knowledge dated (source.at, ISO) from `since` and before `until`, written by one of `authors`
 * (profile ids). Dates are compared as ISO strings, the form ingestion stores them in.
 */
export type SearchFilter = { since?: string; until?: string; authors?: string[] }

/** True if the item passes the filter (none: always). The stores apply the same rule in their queries. */
export function matchesFilter(item: { author_id: string; created_at: string; source?: { at?: string } }, f: SearchFilter | undefined): boolean {
  if (!f) return true
  const at = item.source?.at ?? item.created_at
  return (!f.since || at >= f.since) && (!f.until || at < f.until) && (!f.authors || f.authors.includes(item.author_id))
}

/** Cosine similarity between two vectors of the same dimension (0 if one is zero or the sizes differ). */
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
