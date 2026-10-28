// Search evaluation on the Encore demo company: npm run eval (after npm run seed).
// Each question (scripts/eval-cases.ts) expects a knowledge item, recognized by part of its title, as high as possible
// in what search_brain returns: precision@1, success@3 and MRR per set of questions, with or without embeddings
// depending on the configuration. Then the context the knowledge graph adds (knowledge that shares no word with the
// question, among the 8 results, with the graph and without it), and the access cases: a search as one person never
// returns anything from a zone they do not read. An access failure makes the command fail. Traps count the questions
// whose words led the search to the tempting wrong item; unanswerable questions, how often the search returns nothing.
// To add a case: one line in scripts/eval-cases.ts. A case that regresses shows up right away.

import type { KnowledgeItem } from "@brain/core"
import { getAccess } from "../lib/access"
import { ORIGINAL_PHRASING_WEIGHT, hybridSearch, searchWithGraph } from "../lib/brain"
import { getEmbeddings, primeQueryCache } from "../lib/embeddings"
import { getReranker, paceReranker, rerankFailures } from "../lib/rerank"
import { getStore, runInOrg } from "../lib/store"
import fs from "node:fs"
import { DEMO_USERS } from "./demo-data"
import { ACCESS_CASES, CASE_SETS as ALL_SETS, GRAPH_CASES, UNANSWERABLE, type Case } from "./eval-cases"
import { CORPUS_MARKER } from "./eval-corpus"

/**
 * EVAL_REPHRASINGS=file.json ({question: [rewording, …]}): each question is searched together with the rewordings an
 * agent would send (search_brain takes several phrasings), to measure what the agent's rewording adds.
 */
const rephrasingsFile = process.env.EVAL_REPHRASINGS ? JSON.parse(fs.readFileSync(process.env.EVAL_REPHRASINGS, "utf8")) : null
/** scripts/eval-data/rephrasings*.json ({prompt, model, questions}), or a bare {question: [rewording, …]}. */
const REPHRASINGS: Record<string, string[]> = rephrasingsFile?.questions ?? rephrasingsFile ?? {}
const asked = (q: string) => [q, ...(REPHRASINGS[q] ?? [])]
/** EVAL_ORIGINAL_WEIGHT: weight of the question as asked in the fusion of phrasings (ORIGINAL_PHRASING_WEIGHT otherwise). */
const originalWeight = process.env.EVAL_ORIGINAL_WEIGHT ? Number(process.env.EVAL_ORIGINAL_WEIGHT) : undefined

/** Results agents get from search_brain by default. */
const LIMIT = 8

const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 100) : 0}%`.padStart(4)

/** Rank (0 = first) of the first result matching the case, -1 if none. */
function rankOf(results: { title: string }[], c: Pick<Case, "expect">): number {
  const wanted = (Array.isArray(c.expect) ? c.expect : [c.expect]).map((e) => e.toLowerCase())
  return results.findIndex((r) => wanted.some((w) => r.title.toLowerCase().includes(w)))
}

const label = (c: Pick<Case, "expect">) => (Array.isArray(c.expect) ? c.expect.join(" | ") : c.expect)

async function main() {
  const store = getStore()
  const profiles = await store.listProfiles()
  const admin = profiles.find((p) => p.role === "admin")
  if (!admin) throw new Error("No admin: run npm run seed first.")
  const provider = getEmbeddings()
  console.log(`Search: lexical + synonyms${provider ? ` + embeddings (${provider.id}, ${provider.model})` : " (no embeddings: VOYAGE_API_KEY or BRAIN_EMBEDDING_URL not set)"}`)
  const reranker = getReranker()
  // A rate-limited account (Voyage without a payment method: 3 requests a minute): EVAL_RERANK_GAP_MS spaces the calls.
  const gap = Number(process.env.EVAL_RERANK_GAP_MS ?? 0)
  if (gap > 0) paceReranker(gap)
  if (process.env.EVAL_REPHRASINGS)
    console.log(
      `Rephrasings: ${Object.keys(REPHRASINGS).length} questions searched with the agent's rewordings${rephrasingsFile?.prompt ? ` (${rephrasingsFile.prompt}, ${rephrasingsFile.model})` : ""}, ` +
        `the question as asked weighing ${originalWeight ?? ORIGINAL_PHRASING_WEIGHT}`,
    )
  console.log(reranker ? `Rerank: ${reranker.model}${gap > 0 ? `, one call every ${gap / 1000} s` : ""}` : "Rerank: off (BRAIN_RERANK_MODEL not set)")
  /** Relevance the reranker gives to a right first answer, and to the first result of an unanswerable question. */
  const relevance = { right: [] as number[], unanswerable: [] as number[] }
  // Every question's vector in a few requests, before the searches: one request per question would hit the
  // provider's rate limit, and a refused embedding silently falls back to words, which would skew the comparison.
  if (provider) {
    const queries = [...ALL_SETS.flatMap((set) => set.cases.map((c) => c.query)), ...GRAPH_CASES.map((c) => c.query), ...UNANSWERABLE, ...ACCESS_CASES.map((c) => c.query), ...Object.values(REPHRASINGS).flat()]
    console.log(`Query vectors: ${await primeQueryCache(queries)} computed in advance`)
  }
  const failures: string[] = []
  const totals = { n: 0, p1: 0, s3: 0, mrr: 0, traps: 0, fell: 0, outdated: 0 }
  // The corpus sets run only with the evaluation corpus loaded (npm run eval:seed).
  const withCorpus = (await store.listItems({ limit: 5000 })).some((i) => i.title === CORPUS_MARKER)
  const CASE_SETS = ALL_SETS.filter((set) => !set.corpus || withCorpus)
  console.log(`Corpus: ${withCorpus ? "demo + evaluation corpus" : "demo only (npm run eval:seed adds the evaluation corpus)"}`)
  const live = (await store.listItems({ limit: 5000, excludeSuperseded: true }))
  console.log(`Keywords: ${live.filter((i) => i.keywords?.length).length}/${live.length} knowledge items${live.some((i) => i.keywords?.length) ? "" : " (npm run eval:seed applies scripts/eval-data/keywords.json)"}`)
  const summary: string[] = []
  let withGraph = 0
  let withoutGraph = 0
  let accessFailed = 0
  let silent = 0

  await runInOrg(admin.org_id, async () => {
    const zones = (await store.listZones()).map((z) => z.id)

    for (const set of CASE_SETS) {
      console.log(`\n${set.name} (${set.about})`)
      let p1 = 0
      let s3 = 0
      let mrr = 0
      let traps = 0
      let fell = 0
      for (const c of set.cases) {
        // What agents get: the direct results first, the graph only takes the last places.
        const results = await searchWithGraph(asked(c.query), zones, LIMIT, { originalWeight })
        const rank = rankOf(results, c)
        const top = (results[0] as { relevance?: number } | undefined)?.relevance
        if (rank === 0 && top !== undefined) relevance.right.push(top)
        if (rank === 0) p1++
        if (rank >= 0 && rank < 3) s3++
        if (rank >= 0) mrr += 1 / (rank + 1)
        const trapRank = c.trap ? rankOf(results, { expect: c.trap }) : -1
        const trapped = trapRank >= 0 && (rank < 0 || trapRank < rank)
        if (c.trap) traps++
        if (trapped) fell++
        const mark = rank === 0 ? "✓" : rank >= 0 && rank < 3 ? "~" : "✗"
        const staleRank = c.outdated ? rankOf(results, { expect: c.outdated }) : -1
        if (staleRank >= 0) totals.outdated++
        const trapNote = (trapped ? `, trapped by ${c.trap} (rank ${trapRank + 1})` : "") + (staleRank >= 0 ? `, serves the outdated ${c.outdated} (rank ${staleRank + 1})` : "")
        console.log(`${mark} ${c.query.slice(0, 60).padEnd(60)} → ${rank >= 0 ? `rank ${rank + 1}` : "missing"}${trapNote}  (${label(c)})`)
        if (rank < 0 || rank >= 3) failures.push(`[${set.name}] ${c.query}: ${results.map((r) => r.title).slice(0, 3).join(" | ") || "no results"}`)
      }
      const n = set.cases.length
      Object.assign(totals, { n: totals.n + n, p1: totals.p1 + p1, s3: totals.s3 + s3, mrr: totals.mrr + mrr, traps: totals.traps + traps, fell: totals.fell + fell })
      summary.push(`${set.name.padEnd(16)} ${String(n).padStart(3)}   ${pct(p1, n)}         ${pct(s3, n)}       ${(mrr / n).toFixed(2)}${traps ? `   ${fell}/${traps}` : ""}`)
    }

    console.log(`\ngraph (expected among the ${LIMIT} results, without any word of the question)`)
    for (const c of GRAPH_CASES) {
      const results = await searchWithGraph(asked(c.query), zones, LIMIT, { originalWeight })
      const rank = rankOf(results, c)
      const direct = rankOf(await hybridSearch(c.query, zones, LIMIT), c) >= 0
      if (rank >= 0) withGraph++
      if (direct) withoutGraph++
      const via = rank >= 0 ? (results[rank] as { via?: { entity: { name: string; type: string } } }).via : undefined
      const how = rank < 0 ? "missing" : via ? `rank ${rank + 1}, via ${via.entity.name} (${via.entity.type})` : `rank ${rank + 1}, direct`
      console.log(`${rank >= 0 ? "✓" : "✗"} ${c.query.padEnd(60)} → ${how}  (${label(c)})`)
      if (rank < 0) failures.push(`[graph] ${c.query}: ${results.map((r) => r.title).join(" | ") || "no results"}`)
    }

    console.log("\nunanswerable (nothing in the brain answers: the best search returns nothing)")
    for (const q of UNANSWERABLE) {
      const results = await searchWithGraph(asked(q), zones, LIMIT, { originalWeight })
      if (results.length === 0) silent++
      const top = (results[0] as { relevance?: number } | undefined)?.relevance
      if (top !== undefined) relevance.unanswerable.push(top)
      const rel = top !== undefined ? ` (relevance ${top.toFixed(2)})` : ""
      console.log(`${results.length === 0 ? "✓" : "✗"} ${q.padEnd(60)} → ${results.length === 0 ? "nothing" : `${results.length} results, first: ${results[0].title}${rel}`}`)
    }

    console.log("\naccess (a search as one person: nothing from a zone they do not read)")
    for (const c of ACCESS_CASES) {
      const email = DEMO_USERS.find((u) => u.key === c.as)?.email
      const person = profiles.find((p) => p.email === email)
      if (!person) throw new Error(`${c.as} is not in this brain: run npm run seed first.`)
      const { readable } = await getAccess(person)
      const results = (await searchWithGraph(asked(c.query), readable, LIMIT, { authorId: person.id, originalWeight })) as KnowledgeItem[]
      const leaks = results.filter((r) => !readable.includes(r.zone) && r.author_id !== person.id)
      const missing = c.expect !== undefined && rankOf(results, { expect: c.expect }) < 0
      const ok = leaks.length === 0 && !missing
      if (!ok) accessFailed++
      const why = leaks.length ? `leaks ${leaks.map((l) => `${l.zone}: ${l.title}`).join(" | ")}` : missing ? `does not find ${label({ expect: c.expect! })}` : `${results.length} results, all readable`
      console.log(`${ok ? "✓" : "✗"} ${`${person.name.split(" ")[0]}: ${c.query}`.padEnd(60)} → ${why}`)
      if (!ok) failures.push(`[access] ${person.name}, ${c.query}: ${why}`)
    }
  })

  console.log(`\nset              questions  precision@1  success@3  MRR    trapped`)
  for (const line of summary) console.log(line)
  console.log(`${"all".padEnd(16)} ${String(totals.n).padStart(3)}   ${pct(totals.p1, totals.n)}         ${pct(totals.s3, totals.n)}       ${(totals.mrr / totals.n).toFixed(2)}   ${totals.fell}/${totals.traps}`)
  const g = GRAPH_CASES.length
  console.log(`\ncontext@${LIMIT}: ${withGraph}/${g} with the graph, ${withoutGraph}/${g} without`)
  if (withCorpus) console.log(`outdated versions served: ${totals.outdated}`)
  console.log(`unanswerable: ${silent}/${UNANSWERABLE.length} with no result`)
  if (reranker) {
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
    const right = sorted(relevance.right)
    const none = sorted(relevance.unanswerable)
    const q = (xs: number[], f: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))].toFixed(2) : "-")
    console.log(`relevance of right first answers: min ${q(right, 0)}, 10th percentile ${q(right, 0.1)}, median ${q(right, 0.5)} (${right.length})`)
    console.log(`relevance of the first result of unanswerable questions: max ${q(none, 0.999)}, median ${q(none, 0.5)} (${none.length})`)
    console.log(`rerank failures (the search kept its order): ${rerankFailures()}`)
  }
  console.log(`access: ${ACCESS_CASES.length - accessFailed}/${ACCESS_CASES.length} without a leak`)
  if (failures.length) {
    console.log("\nTo look at:")
    for (const f of failures) console.log(`  - ${f}`)
  }
  if (accessFailed || totals.outdated > 0 || (reranker && rerankFailures() > 0)) process.exitCode = 1
  const s = store as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
