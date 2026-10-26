// Search evaluation on the Encore demo company: npm run eval (after npm run seed).
// For each question, a given knowledge item (recognized by part of its title) is expected in the top 3
// results. Prints precision@1, success@3 and MRR, with or without embeddings depending on the configuration.
// Then the context the knowledge graph adds: knowledge that shares no word with the question, expected among the 8
// results of search_brain, with the graph and without it.
// To add a case: one line in CASES (or GRAPH_CASES). A case that regresses shows up right away.

import { hybridSearch, searchWithGraph } from "../lib/brain"
import { getEmbeddings } from "../lib/embeddings"
import { getStore, runInOrg } from "../lib/store"

type Case = { query: string; expect: string; zones?: string[] }

/** Phrasings deliberately different from the titles (synonyms, slight typos). */
export const CASES: Case[] = [
  { query: "how do we deploy to production?", expect: "Deploy Encore to production" },
  { query: "how do we ship a release", expect: "Deploy Encore to production" },
  { query: "go live", expect: "Deploy Encore to production" },
  { query: "Qonto reconciliation", expect: "bank reconciliation" },
  { query: "bank reconcilation", expect: "bank reconciliation" },
  { query: "month-end close accountant export", expect: "Month-end close" },
  { query: "when to file VAT", expect: "VAT return" },
  { query: "VAT on second-hand phones", expect: "VAT margin scheme" },
  { query: "webhook charge.refunded", expect: "charge.refunded webhook" },
  { query: "restore a backup", expect: "Restore a Supabase backup" },
  { query: "backup restore staging", expect: "Restore a Supabase backup" },
  { query: "AI grading of the screen from photos", expect: "Screen grading" },
  { query: "scratches missed under the lights", expect: "hairline scratch" },
  { query: "how are selling prices set", expect: "Selling prices recomputed" },
  { query: "B2B lease price per phone", expect: "€19 per phone" },
  { query: "sales pipeline october", expect: "October B2B pipeline" },
  { query: "Groupe Vallière CSR report", expect: "Groupe Vallière" },
  { query: "eSIM won't transfer", expect: "Transfer a customer's eSIM" },
  { query: "battery health after a battery swap", expect: "battery was replaced" },
  { query: "burn and runway", expect: "Monthly burn" },
  { query: "phones sold goal for Christmas", expect: "7,500 phones" },
  { query: "returns not as described", expect: "under 3%" },
  { query: "trade in your old phone", expect: "trade-in" },
  { query: "refurbished macbooks", expect: "laptops" },
  { query: "hire someone to run the workshop", expect: "workshop lead" },
  { query: "Fleet & Mobility convention leads", expect: "40% of the year's B2B leads" },
]

/**
 * Knowledge only the graph reaches: no word in common with the question, but the same customer, project or tool as
 * the best results (the B2B lease next to the Kalia Santé pilot, the price freeze next to a failing migration, the
 * backup restore next to the deployment).
 */
export const GRAPH_CASES: Case[] = [
  { query: "Kalia Santé pilot", expect: "New B2B lease" },
  { query: "VAT return", expect: "bank reconciliation" },
  { query: "Groupe Vallière", expect: "Prepare an Encore B2B demo" },
  { query: "staging migration fails", expect: "Black Friday prices freeze" },
  { query: "how do we deploy", expect: "Restore a Supabase backup" },
]

/** Results of search_brain (MCP), where the graph cases are expected. */
const CONTEXT_LIMIT = 8

async function main() {
  const store = getStore()
  const profiles = await store.listProfiles()
  const admin = profiles.find((p) => p.role === "admin")
  if (!admin) throw new Error("No admin: run npm run seed first.")
  const zones = (await store.listZones()).map((z) => z.id)
  const provider = getEmbeddings()
  console.log(`Search: lexical + synonyms${provider ? ` + embeddings (${provider.id}, ${provider.model})` : " (no embeddings: VOYAGE_API_KEY or BRAIN_EMBEDDING_URL not set)"}`)
  console.log("")
  let p1 = 0
  let s3 = 0
  let mrr = 0
  const failures: string[] = []
  const found = (rs: { title: string }[], c: Case) => rs.findIndex((r) => r.title.toLowerCase().includes(c.expect.toLowerCase()))
  let withGraph = 0
  let withoutGraph = 0
  await runInOrg(admin.org_id, async () => {
    for (const c of CASES) {
      // What agents get: the direct results first, the graph only takes the last places.
      const results = await searchWithGraph(c.query, c.zones ?? zones, 5)
      const rank = found(results, c)
      if (rank === 0) p1++
      if (rank >= 0 && rank < 3) s3++
      if (rank >= 0) mrr += 1 / (rank + 1)
      const mark = rank === 0 ? "✓" : rank >= 0 && rank < 3 ? "~" : "✗"
      console.log(`${mark} ${c.query.padEnd(44)} → ${rank >= 0 ? `rank ${rank + 1}` : "missing"}  (${c.expect})`)
      if (rank < 0 || rank >= 3) failures.push(`${c.query}: ${results.map((r) => r.title).slice(0, 3).join(" | ") || "no results"}`)
    }
    console.log("")
    console.log(`Context through the knowledge graph (expected among the ${CONTEXT_LIMIT} results, without any word of the question):`)
    for (const c of GRAPH_CASES) {
      const results = await searchWithGraph(c.query, c.zones ?? zones, CONTEXT_LIMIT)
      const rank = found(results, c)
      const direct = found(await hybridSearch(c.query, c.zones ?? zones, CONTEXT_LIMIT), c) >= 0
      if (rank >= 0) withGraph++
      if (direct) withoutGraph++
      const via = rank >= 0 ? results[rank].via : undefined
      const how = rank < 0 ? "missing" : via ? `rank ${rank + 1}, via ${via.entity.name} (${via.entity.type})` : `rank ${rank + 1}, direct`
      console.log(`${rank >= 0 ? "✓" : "✗"} ${c.query.padEnd(44)} → ${how}  (${c.expect})`)
      if (rank < 0) failures.push(`${c.query} (graph): ${results.map((r) => r.title).join(" | ") || "no results"}`)
    }
  })
  const n = CASES.length
  console.log("")
  console.log(`precision@1 ${((p1 / n) * 100).toFixed(0)}%   success@3 ${((s3 / n) * 100).toFixed(0)}%   MRR ${(mrr / n).toFixed(2)}   (${n} questions)`)
  const g = GRAPH_CASES.length
  console.log(`context@${CONTEXT_LIMIT} ${((withGraph / g) * 100).toFixed(0)}% with the graph, ${((withoutGraph / g) * 100).toFixed(0)}% without   (${g} questions)`)
  if (failures.length) {
    console.log("")
    console.log("To look at:")
    for (const f of failures) console.log(`  - ${f}`)
  }
  const s = store as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
