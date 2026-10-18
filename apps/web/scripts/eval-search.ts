// Search evaluation on the Encore demo company: npm run eval (after npm run seed).
// For each question, a given knowledge item (recognized by part of its title) is expected in the top 3
// results. Prints precision@1, success@3 and MRR, with or without embeddings depending on the configuration.
// To add a case: one line in CASES. A case that regresses shows up right away.

import { hybridSearch } from "../lib/brain"
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
  await runInOrg(admin.org_id, async () => {
    for (const c of CASES) {
      const results = await hybridSearch(c.query, c.zones ?? zones, 5)
      const rank = results.findIndex((r) => r.title.toLowerCase().includes(c.expect.toLowerCase()))
      if (rank === 0) p1++
      if (rank >= 0 && rank < 3) s3++
      if (rank >= 0) mrr += 1 / (rank + 1)
      const mark = rank === 0 ? "✓" : rank >= 0 && rank < 3 ? "~" : "✗"
      console.log(`${mark} ${c.query.padEnd(44)} → ${rank >= 0 ? `rank ${rank + 1}` : "missing"}  (${c.expect})`)
      if (rank < 0 || rank >= 3) failures.push(`${c.query}: ${results.map((r) => r.title).slice(0, 3).join(" | ") || "no results"}`)
    }
  })
  const n = CASES.length
  console.log("")
  console.log(`precision@1 ${((p1 / n) * 100).toFixed(0)}%   success@3 ${((s3 / n) * 100).toFixed(0)}%   MRR ${(mrr / n).toFixed(2)}   (${n} questions)`)
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
