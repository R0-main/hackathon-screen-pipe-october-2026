// Search evaluation on the Encore demo company: npm run eval (after npm run seed).
// Each question (scripts/eval-cases.ts) expects a knowledge item, recognized by part of its title, as high as possible
// in what search_brain returns: precision@1, success@3 and MRR per set of questions, with or without embeddings
// depending on the configuration. Then the context the knowledge graph adds (knowledge that shares no word with the
// question, among the 8 results, with the graph and without it), and the access cases: a search as one person never
// returns anything from a zone they do not read. An access failure makes the command fail.
// To add a case: one line in scripts/eval-cases.ts. A case that regresses shows up right away.

import type { KnowledgeItem } from "@brain/core"
import { getAccess } from "../lib/access"
import { hybridSearch, searchWithGraph } from "../lib/brain"
import { getEmbeddings } from "../lib/embeddings"
import { getStore, runInOrg } from "../lib/store"
import { DEMO_USERS } from "./demo-data"
import { ACCESS_CASES, CASE_SETS, GRAPH_CASES, type Case } from "./eval-cases"

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
  const failures: string[] = []
  const totals = { n: 0, p1: 0, s3: 0, mrr: 0 }
  const summary: string[] = []
  let withGraph = 0
  let withoutGraph = 0
  let accessFailed = 0

  await runInOrg(admin.org_id, async () => {
    const zones = (await store.listZones()).map((z) => z.id)

    for (const set of CASE_SETS) {
      console.log(`\n${set.name} (${set.about})`)
      let p1 = 0
      let s3 = 0
      let mrr = 0
      for (const c of set.cases) {
        // What agents get: the direct results first, the graph only takes the last places.
        const results = await searchWithGraph(c.query, zones, LIMIT)
        const rank = rankOf(results, c)
        if (rank === 0) p1++
        if (rank >= 0 && rank < 3) s3++
        if (rank >= 0) mrr += 1 / (rank + 1)
        const mark = rank === 0 ? "✓" : rank >= 0 && rank < 3 ? "~" : "✗"
        console.log(`${mark} ${c.query.slice(0, 60).padEnd(60)} → ${rank >= 0 ? `rank ${rank + 1}` : "missing"}  (${label(c)})`)
        if (rank < 0 || rank >= 3) failures.push(`[${set.name}] ${c.query}: ${results.map((r) => r.title).slice(0, 3).join(" | ") || "no results"}`)
      }
      const n = set.cases.length
      Object.assign(totals, { n: totals.n + n, p1: totals.p1 + p1, s3: totals.s3 + s3, mrr: totals.mrr + mrr })
      summary.push(`${set.name.padEnd(16)} ${String(n).padStart(3)}   ${pct(p1, n)}         ${pct(s3, n)}       ${(mrr / n).toFixed(2)}`)
    }

    console.log(`\ngraph (expected among the ${LIMIT} results, without any word of the question)`)
    for (const c of GRAPH_CASES) {
      const results = await searchWithGraph(c.query, zones, LIMIT)
      const rank = rankOf(results, c)
      const direct = rankOf(await hybridSearch(c.query, zones, LIMIT), c) >= 0
      if (rank >= 0) withGraph++
      if (direct) withoutGraph++
      const via = rank >= 0 ? (results[rank] as { via?: { entity: { name: string; type: string } } }).via : undefined
      const how = rank < 0 ? "missing" : via ? `rank ${rank + 1}, via ${via.entity.name} (${via.entity.type})` : `rank ${rank + 1}, direct`
      console.log(`${rank >= 0 ? "✓" : "✗"} ${c.query.padEnd(60)} → ${how}  (${label(c)})`)
      if (rank < 0) failures.push(`[graph] ${c.query}: ${results.map((r) => r.title).join(" | ") || "no results"}`)
    }

    console.log("\naccess (a search as one person: nothing from a zone they do not read)")
    for (const c of ACCESS_CASES) {
      const email = DEMO_USERS.find((u) => u.key === c.as)?.email
      const person = profiles.find((p) => p.email === email)
      if (!person) throw new Error(`${c.as} is not in this brain: run npm run seed first.`)
      const { readable } = await getAccess(person)
      const results = (await searchWithGraph(c.query, readable, LIMIT, person.id)) as KnowledgeItem[]
      const leaks = results.filter((r) => !readable.includes(r.zone) && r.author_id !== person.id)
      const missing = c.expect !== undefined && rankOf(results, { expect: c.expect }) < 0
      const ok = leaks.length === 0 && !missing
      if (!ok) accessFailed++
      const why = leaks.length ? `leaks ${leaks.map((l) => `${l.zone}: ${l.title}`).join(" | ")}` : missing ? `does not find ${label({ expect: c.expect! })}` : `${results.length} results, all readable`
      console.log(`${ok ? "✓" : "✗"} ${`${person.name.split(" ")[0]}: ${c.query}`.padEnd(60)} → ${why}`)
      if (!ok) failures.push(`[access] ${person.name}, ${c.query}: ${why}`)
    }
  })

  console.log(`\nset              questions  precision@1  success@3  MRR`)
  for (const line of summary) console.log(line)
  console.log(`${"all".padEnd(16)} ${String(totals.n).padStart(3)}   ${pct(totals.p1, totals.n)}         ${pct(totals.s3, totals.n)}       ${(totals.mrr / totals.n).toFixed(2)}`)
  const g = GRAPH_CASES.length
  console.log(`\ncontext@${LIMIT}: ${withGraph}/${g} with the graph, ${withoutGraph}/${g} without`)
  console.log(`access: ${ACCESS_CASES.length - accessFailed}/${ACCESS_CASES.length} without a leak`)
  if (failures.length) {
    console.log("\nTo look at:")
    for (const f of failures) console.log(`  - ${f}`)
  }
  if (accessFailed) process.exitCode = 1
  const s = store as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
