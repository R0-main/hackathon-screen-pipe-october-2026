// The live demo kept alive, on file storage: a visit makes an agent of the team work (a prompt, a real search) and the
// six computers report their syncs; a second visit right after does nothing more; open sessions end; once a day the
// status is generated again, and a history more than a week old moves forward by whole weeks.
// BRAIN_TEST_DATABASE_URL (a throwaway database, migrated): the same on Postgres; it is reset by the seed.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-live-"))
process.env.BRAIN_DATA_DIR = dir
if (process.env.BRAIN_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL
else delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.VOYAGE_API_KEY

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { demoPulse, PULSE_MS } = await import("../lib/demo-live")
const { DEMO_USERS } = await import("./demo-data")

const root = getRootStore()
let org = ""
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)
/** A fixed sequence instead of Math.random: the scenes are reproducible. */
const seq = (...xs: number[]) => {
  let i = 0
  return () => xs[i++ % xs.length]
}

before(async () => {
  await seedDemoBrain(root)
  org = (await root.getOrg()).id
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await (root as { end?: () => Promise<void> }).end?.()
})

test("pulse: an agent works, the computers sync, the next visit right after adds nothing", async () => {
  const now = Date.now()
  const r = await inOrg(() => demoPulse(root, now, seq(0.1, 0.5, 0.9)))
  assert.ok(r)
  assert.deepEqual(r.day, { shiftedDays: 0, status: true }, "the day's work, once: a fresh demo does not move")
  assert.equal(r.reports, DEMO_USERS.length, "each computer reports a sync")
  assert.ok(r.scene, "an agent works")
  const events = await inOrg(() => root.listEvents({ limit: 10 }))
  assert.ok(events.some((e) => e.type === "started" && e.session_id?.startsWith("pulse-")))
  assert.ok(events.some((e) => e.agent === "mcp" && e.type === "query"), "its agent searched the brain")
  assert.ok(events.every((e) => Date.parse(e.at) <= now + 1000), "nothing in the future")

  const again = await inOrg(() => demoPulse(root, now + 5000))
  assert.deepEqual(again, { day: null, scene: null, reports: 0, ended: 0 }, "a second visitor right after: nothing")

  const later = await inOrg(() => demoPulse(root, now + 4 * 60_000, seq(0.3, 0.2, 0.9)))
  assert.equal(later?.ended, 1, "the previous session ends")
  assert.ok(later?.scene, `another scene after ${PULSE_MS / 1000} s`)
})

test("once a day: a history more than a week old moves forward by whole weeks, what came after stays", async () => {
  const items = await inOrg(() => root.listItems({ limit: 5000 }))
  const latest = Math.max(...items.map((i) => Date.parse(i.source.at)))
  // Copied: the file store hands out its own objects.
  const sample = structuredClone(items.find((i) => i.kind === "decision")!)
  const pulseEvent = structuredClone((await inOrg(() => root.listEvents({ limit: 1 })))[0])
  const now = latest + 16 * 86400_000
  const r = await inOrg(() => demoPulse(root, now, seq(0.6, 0.4, 0.9)))
  assert.equal(r?.day?.shiftedDays, 14, "two whole weeks: the weekdays stay weekdays")
  const moved = await inOrg(() => root.getItem(sample.id))
  assert.equal(Date.parse(moved!.source.at) - Date.parse(sample.source.at), 14 * 86400_000)
  assert.equal(Date.parse(moved!.created_at) - Date.parse(sample.created_at), 14 * 86400_000)
  const after = await inOrg(() => root.listItems({ limit: 5000 }))
  assert.ok(Math.max(...after.map((i) => Date.parse(i.source.at))) <= now, "nothing pushed into the future")
  const kept = (await inOrg(() => root.listEvents({ limit: 100_000 }))).find((e) => e.id === pulseEvent.id)
  assert.equal(kept?.at, pulseEvent.at, "an event after the latest knowledge stays where it is")
  const status = await inOrg(() => root.getStatus())
  assert.ok(status && Date.parse(status.generated_at) > latest)
})

test("another company is never touched", async () => {
  await root.updateOrg({ name: "Acme" })
  try {
    assert.equal(await inOrg(() => demoPulse(root)), null)
  } finally {
    await root.updateOrg({ name: "Encore" })
  }
})

test("test accounts: removed with what is theirs; the six people, the visitors and the admins stay", async () => {
  const { removeDemoTestAccounts, DEMO_VISITOR_TITLE } = await import("../lib/demo-seed")
  const { hashToken, newToken } = await import("../lib/auth")
  const make = (name: string, title: string, role: "admin" | "member" = "member") =>
    inOrg(() => root.createProfile({ name, title, role, token_hash: hashToken(newToken()) }))
  const junk = await make("fwqfwq", "fwqfqf")
  const blank = await make("fwqfqfqf", "")
  const visitor = await make("Visitor 4242", DEMO_VISITOR_TITLE)
  const admin = await make("Second admin", "Ops", "admin")
  await inOrg(() =>
    root.insertItems([{ zone: "dev", kind: "fact", title: "A test account's note", body: "Typed while trying the demo.", entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.5, author_id: junk.id }]),
  )
  await inOrg(() => root.insertEvents([{ user_id: junk.id, agent: "claude-code", type: "started", zones: [], at: new Date().toISOString() }]))
  const removed = await inOrg(() => removeDemoTestAccounts(root))
  assert.deepEqual(removed.sort(), ["fwqfqfqf", "fwqfwq"])
  const left = (await inOrg(() => root.listProfiles())).map((p) => p.id)
  assert.ok(!left.includes(junk.id) && !left.includes(blank.id))
  assert.ok(left.includes(visitor.id) && left.includes(admin.id), "a visitor and an admin stay")
  assert.equal(left.length, DEMO_USERS.length + 2, "the six people stay")
  assert.ok(!(await inOrg(() => root.listItems({ limit: 5000 }))).some((i) => i.author_id === junk.id), "their knowledge goes")
  assert.ok(!(await inOrg(() => root.listEvents({ limit: 100_000 }))).some((e) => e.user_id === junk.id), "their events go")
  assert.deepEqual(await inOrg(() => removeDemoTestAccounts(root)), [], "nothing left to remove")
})
