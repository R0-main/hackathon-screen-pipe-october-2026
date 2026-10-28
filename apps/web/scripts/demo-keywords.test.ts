// The demo's search keywords on file storage: demo-keywords.json covers every demo item, the seed gives them, a term
// only in the keywords finds its item, and a demo brain seeded without them gets them once.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-demo-keywords-"))
process.env.BRAIN_DATA_DIR = dir
delete process.env.DATABASE_URL

const { getRootStore, runInOrg } = await import("../lib/store")
const { addDemoKeywords, seedDemoBrain } = await import("../lib/demo-seed")
const { DEMO_CORE_ITEMS, DEMO_FOLLOWUP_ITEMS, DEMO_FRESH_ITEMS, DEMO_ITEMS, DEMO_KEYWORDS, DEMO_SCREENPIPE_ITEMS } = await import("./demo-data")

const root = getRootStore()
let org = ""
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

before(async () => {
  await seedDemoBrain(root)
  org = (await root.getOrg()).id
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

test("demo keywords: every demo item has some (npm run demo:keywords after adding one)", () => {
  for (const it of [...DEMO_ITEMS, ...DEMO_SCREENPIPE_ITEMS, ...DEMO_CORE_ITEMS, ...DEMO_FOLLOWUP_ITEMS, ...DEMO_FRESH_ITEMS])
    assert.ok(DEMO_KEYWORDS[it.title]?.length, `${it.title}: no keywords`)
})

test("demo keywords: seeded with the items, found by a term of their keywords only", async () => {
  const items = await inOrg(() => root.listItems({ limit: 5000 }))
  const seeded = items.filter((i) => DEMO_KEYWORDS[i.title])
  assert.ok(seeded.length >= DEMO_ITEMS.length)
  for (const i of seeded) assert.deepEqual(i.keywords, DEMO_KEYWORDS[i.title], i.title)
  const alma = items.find((i) => i.title.startsWith("Add Playwright e2e tests on the checkout"))!
  assert.ok(!/buy now pay later/i.test(`${alma.title} ${alma.body}`) && alma.keywords?.includes("buy now pay later"))
  const zones = (await inOrg(() => root.listZones())).map((z) => z.id)
  const found = await inOrg(() => root.searchItems("buy now pay later", zones, 5))
  assert.ok(found.some((r) => r.id === alma.id), "found through its keywords")
})

test("demo keywords: a demo brain without them gets them, once", async () => {
  const items = await inOrg(() => root.listItems({ limit: 5000 }))
  const known = items.filter((i) => DEMO_KEYWORDS[i.title])
  await inOrg(() => root.setKeywords(known.map((i) => ({ id: i.id, keywords: [] }))))
  assert.equal(await inOrg(() => addDemoKeywords(root)), known.length)
  const after = await inOrg(() => root.listItems({ limit: 5000 }))
  for (const i of after.filter((x) => DEMO_KEYWORDS[x.title])) assert.deepEqual(i.keywords, DEMO_KEYWORDS[i.title], i.title)
  assert.equal(await inOrg(() => addDemoKeywords(root)), 0, "nothing left to add")
})
