// search_brain on file storage with the Encore demo: the agent's phrasings find what the question's words miss, the
// filters by date and by author narrow the results, keywords bring an item without outranking the words of a title,
// and each result says where it comes from. BRAIN_TEST_DATABASE_URL (a throwaway database, migrated): the same on
// Postgres; it is reset by the seed.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-search-"))
process.env.BRAIN_DATA_DIR = dir
if (process.env.BRAIN_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL
else delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.VOYAGE_API_KEY
delete process.env.BRAIN_EMBEDDING_URL
delete process.env.BRAIN_RERANK_MODEL

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { getAccess } = await import("../lib/access")
const { authorsNamed, queryBrain } = await import("../lib/brain")
const { formatQuery } = await import("@brain/core/mcp")
type Viewer = import("../lib/auth").Viewer

const root = getRootStore()
let org = ""
let tokens: Record<string, { token: string; id: string }> = {}

async function viewer(key: string): Promise<Viewer> {
  const p = await root.getProfile(tokens[key].id)
  if (!p) throw new Error(`${key} not found`)
  return { profile: p, real: p, access: await getAccess(p) }
}
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

before(async () => {
  const seeded = await seedDemoBrain(root)
  tokens = seeded.tokens
  org = (await root.getOrg()).id
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await (root as { end?: () => Promise<void> }).end?.()
})

test("phrasings: the agent's English rewording finds what the question's words miss", async () => {
  const hugo = await viewer("hugo")
  const alone = await inOrg(() => queryBrain(hugo, { query: "comment on met le site en ligne ?" }))
  assert.ok(!alone.items.some((i) => i.title === "Deploy Encore to production"), "the French words alone miss it")
  const helped = await inOrg(() => queryBrain(hugo, { query: "comment on met le site en ligne ?", phrasings: ["deploy the shop to production"] }))
  assert.ok(helped.items.slice(0, 3).some((i) => i.title === "Deploy Encore to production"), "among the first results")
  assert.deepEqual(helped.phrasings, ["deploy the shop to production"])
})

test("filters: by author (first name, full name, nobody of that name), by the knowledge's date", async () => {
  const leo = await viewer("leo")
  const sarah = tokens.sarah.id
  const bySarah = await inOrg(() => queryBrain(leo, { query: "customers", author: "sarah", limit: 20 }))
  assert.ok(bySarah.items.length > 0)
  assert.ok(bySarah.items.every((i) => i.author_id === sarah), "only Sarah's knowledge, the graph's included")
  assert.deepEqual(bySarah.filter?.authors, ["Sarah Cohen"])
  const nobody = await inOrg(() => queryBrain(leo, { query: "customers", author: "Zoé" }))
  assert.equal(nobody.items.length, 0)
  assert.deepEqual(nobody.filter?.authors, [])
  assert.match(formatQuery(nobody, (z) => z), /filter: by nobody of that name/)

  const all = await inOrg(() => queryBrain(leo, { query: "customers", limit: 50 }))
  const dates = all.items.map((i) => i.source.at).sort()
  const middle = dates[Math.floor(dates.length / 2)].slice(0, 10)
  const recent = await inOrg(() => queryBrain(leo, { query: "customers", since: middle, limit: 50 }))
  const older = await inOrg(() => queryBrain(leo, { query: "customers", until: middle, limit: 50 }))
  assert.ok(recent.items.length > 0 && older.items.length > 0)
  assert.ok(recent.items.every((i) => i.source.at >= middle), "since: from that day")
  assert.ok(older.items.every((i) => i.source.at.slice(0, 10) <= middle), "until: that whole day included")
  assert.ok(recent.items.length + older.items.length >= all.items.length, "the two halves cover everything")
})

test("authorsNamed: the full name, every word of it, or the email; whatever the case or accents", () => {
  const people = [
    { id: "1", name: "Inès Lefèvre", email: "ines@encore.example" },
    { id: "2", name: "Jean-Marc Dubois", email: "jean-marc@encore.example" },
    { id: "3", name: "Sarah Cohen" },
  ]
  assert.deepEqual(authorsNamed(people, "ines").map((p) => p.id), ["1"])
  assert.deepEqual(authorsNamed(people, "Jean-Marc").map((p) => p.id), ["2"])
  assert.deepEqual(authorsNamed(people, "JEAN-MARC@encore.example").map((p) => p.id), ["2"])
  assert.deepEqual(authorsNamed(people, "sarah dubois"), [], "every word must be in the same name")
})

test("keywords: they bring an item a search would miss, never above a title that names the subject", async () => {
  const store = getRootStore()
  const items = await inOrg(() => store.listItems({ limit: 500 }))
  const target = items.find((i) => i.title === "Deploy Encore to production")!
  await inOrg(() => store.setKeywords([{ id: target.id, keywords: ["mise en ligne", "mettre le site en ligne"] }]))
  const hugo = await viewer("hugo")
  const found = await inOrg(() => queryBrain(hugo, { query: "mise en ligne" }))
  assert.equal(found.items[0]?.title, "Deploy Encore to production", "found by its keywords alone")
  assert.deepEqual(found.items[0]?.keywords, ["mise en ligne", "mettre le site en ligne"])

  const backup = items.find((i) => i.title.startsWith("Restore a Supabase backup"))!
  await inOrg(() => store.setKeywords([{ id: target.id, keywords: ["supabase backup"] }]))
  const restore = await inOrg(() => store.searchItems("supabase backup", ["dev"], 10))
  assert.ok(restore.findIndex((r) => r.id === backup.id) < restore.findIndex((r) => r.id === target.id), "the backup procedure stays first")
  await inOrg(() => store.setKeywords([{ id: target.id, keywords: [] }]))
  assert.equal((await inOrg(() => store.getItem(target.id)))?.keywords, undefined, "an empty list clears them")
})

test("results say who wrote them, when, and from which tool and app", async () => {
  const hugo = await viewer("hugo")
  const r = await inOrg(() => queryBrain(hugo, { query: "deploy to production" }))
  const text = formatQuery(r, (z) => z)
  const first = r.items[0]
  assert.ok(text.includes(`By: ${first.author}`))
  assert.ok(text.includes(`Source: ${first.source.tool} in ${first.source.app}`), text.slice(0, 400))
})

test("vectors: stored at insertion and by the catch-up, listed back as numbers, under the filter", async () => {
  const store = getRootStore()
  const hugo = tokens.hugo.id
  const vec = Array.from({ length: 8 }, (_, n) => (n + 1) / 10)
  const [inserted] = await inOrg(() =>
    store.insertItems([
      { zone: "dev", kind: "fact", title: "Vector check", body: "A fact with its vector.", entities: [], source: { app: "Terminal", tool: "claude-code", at: "2026-10-01T09:00:00.000Z" }, confidence: 0.8, author_id: hugo, embedding: vec, embedding_model: "test-model", keywords: ["contrôle vecteur"] },
    ]),
  )
  assert.deepEqual(inserted.keywords, ["contrôle vecteur"])
  const listed = await inOrg(() => store.listEmbeddings({ zones: ["dev"] }))
  const mine = listed.find((r) => r.id === inserted.id)
  assert.ok(mine, "the vector inserted with the item")
  assert.ok(mine.embedding.every((x, n) => Math.abs(x - vec[n]) < 1e-6))
  await inOrg(() => store.setEmbeddings([{ id: inserted.id, embedding: vec.map((x) => -x), model: "test-model" }]))
  const again = (await inOrg(() => store.listEmbeddings({ zones: ["dev"] }))).find((r) => r.id === inserted.id)
  assert.ok(again && Math.abs(again.embedding[0] + 0.1) < 1e-6, "the catch-up replaces it")
  const later = await inOrg(() => store.listEmbeddings({ zones: ["dev"], filter: { since: "2026-10-02T00:00:00.000Z", authors: [hugo] } }))
  assert.ok(!later.some((r) => r.id === inserted.id), "dated before `since`: filtered out")
  assert.ok((await inOrg(() => store.searchItems("controle vecteur", ["dev"], 5))).some((r) => r.id === inserted.id), "found by its keywords")
  await inOrg(() => store.deleteItem(inserted.id))
})
