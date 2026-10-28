// Semantic vectors in the storage: written with the item at ingestion and by the catch-up (setEmbeddings), read back
// as numbers. On file storage by default; BRAIN_TEST_DATABASE_URL (a throwaway database, migrated): on Postgres, where
// a vector sent as text[] was refused by the real[] column. It is reset by the seed.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-vectors-"))
process.env.BRAIN_DATA_DIR = dir
if (process.env.BRAIN_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")

const root = getRootStore()
let org = ""
let hugo = ""

before(async () => {
  const seeded = await seedDemoBrain(root)
  hugo = seeded.tokens.hugo.id
  org = (await root.getOrg()).id
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await (root as { end?: () => Promise<void> }).end?.()
})

test("vectors: stored with the item and by the catch-up, listed back as numbers", async () => {
  const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)
  const vec = Array.from({ length: 8 }, (_, n) => (n + 1) / 10)
  const [item] = await inOrg(() =>
    root.insertItems([
      { zone: "dev", kind: "fact", title: "Vector check", body: "A fact with its vector.", entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.8, author_id: hugo, embedding: vec, embedding_model: "test-model" },
    ]),
  )
  const listed = (await inOrg(() => root.listEmbeddings({ zones: ["dev"] }))).find((r) => r.id === item.id)
  assert.ok(listed, "the vector inserted with the item")
  assert.ok(listed.embedding.every((x, n) => Math.abs(x - vec[n]) < 1e-6))
  await inOrg(() => root.setEmbeddings([{ id: item.id, embedding: vec.map((x) => -x), model: "test-model" }]))
  const again = (await inOrg(() => root.listEmbeddings({ zones: ["dev"] }))).find((r) => r.id === item.id)
  assert.ok(again && Math.abs(again.embedding[0] + 0.1) < 1e-6, "the catch-up replaces it")
  await inOrg(() => root.deleteItem(item.id))
})
