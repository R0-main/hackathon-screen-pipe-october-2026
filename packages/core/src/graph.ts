// The knowledge graph: each knowledge item is linked to the entities it cites (customers, projects, tools, people,
// documents). One hop away from a search's best results lies the knowledge that cites the same entities: the context
// a search by words alone misses, because it shares no word with the question.

import { normalize } from "./text"
import type { Entity } from "./types"

/** An entity as the graph knows it: `type:normalized name` ("client:kalia sante"), the same in every store. */
export type EntityKey = string

export function entityKey(e: Pick<Entity, "type" | "name">): EntityKey {
  return `${e.type}:${normalize(e.name)}`
}

/** Why an item was brought by the graph: the entity it shares with one of the best results. */
export type GraphVia = { entity: Pick<Entity, "type" | "name">; from: { id: string; title: string } }

export type GraphHit = { id: string; score: number; via: GraphVia }

/**
 * How much a shared entity of each type says about the subject. A customer, a project or a document names the
 * subject; a tool tells the stack, often shared by unrelated work; a person tells who, and connects everything they
 * touch: one person in common never links two items (under minScore even through every seed), people mostly
 * strengthen a link.
 */
export const GRAPH_TYPE_WEIGHTS: Record<Entity["type"], number> = { client: 1, project: 1, doc: 1, tool: 0.8, person: 0.3 }

export const GRAPH_DEFAULTS = {
  /** Best results the graph starts from, weighted 1, 1/2, 1/3… by rank. */
  seeds: 3,
  /** An entity cited by more items than this is a hub: it links everything, so it says nothing. */
  maxDegree: 40,
  /** Tie strength below which a neighbor is too loosely linked to be worth an agent's attention. */
  minScore: 0.4,
}

/**
 * Weight of a link through an entity cited by `degree` items (the result it starts from included): the rarer the
 * entity, the more the two items are about the same thing. 0 when nothing else cites it.
 */
export function entityWeight(type: Entity["type"], degree: number): number {
  if (degree < 2) return 0
  return (GRAPH_TYPE_WEIGHTS[type] ?? 1) / Math.log2(1 + degree)
}

type Node = { id: string; title: string; entities: Pick<Entity, "type" | "name">[] }

/**
 * The knowledge one hop away from `seeds` (a search's results, best first): among `candidates` (the items that cite
 * at least one of the seeds' entities), those tied strongly enough to the first seeds, strongest first. A candidate's
 * score adds up, over every first seed it shares an entity with, the seed's weight times the entity's (entityWeight);
 * `via` keeps the strongest of those links, to explain the result. The seeds themselves are never returned.
 * `degree`: for each entity key, how many items of the searched scope cite it.
 */
export function graphNeighbors(
  seeds: Node[],
  candidates: Node[],
  degree: Readonly<Record<EntityKey, number>>,
  opts: Partial<typeof GRAPH_DEFAULTS> & { limit?: number } = {},
): GraphHit[] {
  const { seeds: seedCount, maxDegree, minScore } = { ...GRAPH_DEFAULTS, ...opts }
  const first = seeds.slice(0, seedCount)
  const seedIds = new Set(first.map((s) => s.id))
  const citing = new Map<EntityKey, Node[]>()
  for (const c of candidates) {
    if (seedIds.has(c.id)) continue
    for (const k of new Set(c.entities.map(entityKey))) {
      const list = citing.get(k)
      if (list) list.push(c)
      else citing.set(k, [c])
    }
  }
  const hits = new Map<string, { score: number; best: number; via: GraphVia }>()
  first.forEach((seed, rank) => {
    const w = 1 / (rank + 1)
    const seen = new Set<EntityKey>()
    for (const e of seed.entities) {
      const k = entityKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      const d = degree[k] ?? 0
      if (d > maxDegree) continue
      const link = w * entityWeight(e.type, d)
      if (link <= 0) continue
      for (const c of citing.get(k) ?? []) {
        const h = hits.get(c.id) ?? { score: 0, best: 0, via: { entity: { type: e.type, name: e.name }, from: { id: seed.id, title: seed.title } } }
        h.score += link
        if (link > h.best) {
          h.best = link
          h.via = { entity: { type: e.type, name: e.name }, from: { id: seed.id, title: seed.title } }
        }
        hits.set(c.id, h)
      }
    }
  })
  return [...hits.entries()]
    .filter(([, h]) => h.score >= minScore)
    .map(([id, h]) => ({ id, score: Math.round(h.score * 100) / 100, via: h.via }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? Infinity)
}

/**
 * Places the graph gives to its neighbors in a list of `limit` results, after the `direct` ones: a quarter of them
 * (2 out of 8), or all the places the direct results leave empty if there are more (5 direct results out of 8: 3).
 * None in a list too short to spare one. A direct result is never pushed out.
 */
export function graphSlots(limit: number, direct = limit): number {
  if (limit < 4) return 0
  return Math.max(Math.floor(limit / 4), limit - direct)
}
