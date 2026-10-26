// Loads the evaluation's extra knowledge (scripts/eval-corpus.ts) into a local Encore demo: npm run eval:seed, after
// npm run seed. Near misses in every zone, and older versions of four decisions marked as superseded. Run it again:
// what is already there is skipped. Refuses a database that is not local: the corpus must never reach a real brain
// (EVAL_SEED_FORCE=1 to override). Then npm run embed computes their vectors, if embeddings are on.

import type { KnowledgeItemInput } from "@brain/core"
import { getStore, runInOrg } from "../lib/store"
import { DEMO_USERS } from "./demo-data"
import { CORPUS_ITEMS, SUPERSEDED_ITEMS, type CorpusItem } from "./eval-corpus"
import { ACCESS_CASES, CASE_SETS, GRAPH_CASES } from "./eval-cases"

function refuseRemoteDatabase() {
  const url = process.env.DATABASE_URL
  if (!url || process.env.EVAL_SEED_FORCE === "1") return
  if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) && !url.includes("host=/"))
    throw new Error("DATABASE_URL is not a local database: the evaluation corpus only goes into a local demo (EVAL_SEED_FORCE=1 to override).")
}

/** A corpus title containing an expected answer would count as the right answer: never. */
function checkNoAnswerInTitles(items: CorpusItem[]) {
  const expected = [...CASE_SETS.filter((s) => !s.corpus).flatMap((s) => s.cases), ...GRAPH_CASES, ...ACCESS_CASES]
    .flatMap((c) => (c.expect === undefined ? [] : Array.isArray(c.expect) ? c.expect : [c.expect]))
    .map((e) => e.toLowerCase())
  const clashes = items.flatMap((i) => expected.filter((e) => i.title.toLowerCase().includes(e)).map((e) => `"${i.title}" contains "${e}"`))
  if (clashes.length) throw new Error(`Corpus titles that contain an expected answer:\n${clashes.join("\n")}`)
}

async function main() {
  refuseRemoteDatabase()
  checkNoAnswerInTitles([...CORPUS_ITEMS, ...SUPERSEDED_ITEMS])
  const store = getStore()
  const profiles = await store.listProfiles()
  const admin = profiles.find((p) => p.role === "admin")
  if (!admin) throw new Error("No admin: run npm run seed first.")
  const idOf = (key: string) => {
    const email = DEMO_USERS.find((u) => u.key === key)?.email
    const id = profiles.find((p) => p.email === email)?.id
    if (!id) throw new Error(`${key} is not in this brain: run npm run seed first.`)
    return id
  }
  await runInOrg(admin.org_id, async () => {
    const existing = await store.listItems({ limit: 5000 })
    const titles = new Set(existing.map((i) => i.title))
    const asInput = (i: CorpusItem): KnowledgeItemInput & { author_id: string } => ({
      zone: i.zone, kind: i.kind, title: i.title, body: i.body, entities: i.entities,
      source: { app: "Terminal", tool: "claude-code", at: new Date(Date.now() - 20 * 86400_000).toISOString() },
      confidence: 0.8, author_id: idOf(i.by),
    })
    const fresh = CORPUS_ITEMS.filter((i) => !titles.has(i.title))
    if (fresh.length) await store.insertItems(fresh.map(asInput))
    let superseded = 0
    for (const old of SUPERSEDED_ITEMS.filter((i) => !titles.has(i.title))) {
      const current = existing.find((i) => i.title.includes(old.replacedBy) && !i.superseded_by)
      if (!current) throw new Error(`No current item "${old.replacedBy}" to replace "${old.title}": run npm run seed first.`)
      const [inserted] = await store.insertItems([{ ...asInput(old), source: { app: "Terminal", tool: "claude-code", at: new Date(Date.now() - 60 * 86400_000).toISOString() } }])
      if (await store.markSuperseded(inserted.id, current.id)) superseded++
    }
    console.log(`✓ evaluation corpus: ${fresh.length} near misses and ${superseded} superseded versions added (${CORPUS_ITEMS.length - fresh.length} already there).`)
  })
  const s = store as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
