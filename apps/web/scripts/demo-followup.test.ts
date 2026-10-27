// The demo's follow-up on file storage: a current demo waits; ten days later, the team's next days come in after the
// latest knowledge (the same day, or a later working day), never in the future; the tasks they close are done, the agents' searches are in
// the activity, the status is generated again; a second run adds nothing.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-followup-"))
process.env.BRAIN_DATA_DIR = dir
delete process.env.DATABASE_URL

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain, upgradeFollowupDemo } = await import("../lib/demo-seed")
const { DEMO_FOLLOWUP_ITEMS, DEMO_FOLLOWUP_SEARCHES } = await import("./demo-data")

const root = getRootStore()
let org = ""
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

before(async () => {
  await seedDemoBrain(root)
  org = (await root.getOrg()).id
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const weekday = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: process.env.BRAIN_TIMEZONE ?? "Europe/Paris", weekday: "short" }).format(new Date(iso))

test("follow-up: a current demo waits, ten days later the team's next days come in", async () => {
  assert.equal(await inOrg(() => upgradeFollowupDemo(root)), null, "just seeded: nothing yet")
  const before = await inOrg(() => root.listItems({ limit: 5000 }))
  const latest = Math.max(...before.map((i) => Date.parse(i.source.at)))
  const now = latest + 10 * 86400_000 + 6 * 3600_000
  const eventsBefore = (await inOrg(() => root.listEvents({ limit: 100_000 }))).length

  assert.equal(await inOrg(() => upgradeFollowupDemo(root, now)), DEMO_FOLLOWUP_ITEMS.length)
  const items = await inOrg(() => root.listItems({ limit: 5000 }))
  const added = items.filter((i) => DEMO_FOLLOWUP_ITEMS.some((f) => f.title === i.title))
  assert.equal(added.length, DEMO_FOLLOWUP_ITEMS.length)
  for (const i of added) {
    const t = Date.parse(i.source.at)
    assert.ok(t > latest && t < now, `${i.title}: after the latest knowledge, never in the future`)
    const sameDay = DEMO_FOLLOWUP_ITEMS.find((f) => f.title === i.title)!.daysAfter === 0
    if (!sameDay) assert.ok(!["Sat", "Sun"].includes(weekday(i.source.at)), `${i.title}: on a working day (${weekday(i.source.at)})`)
  }
  const order = (title: string) => Date.parse(added.find((i) => i.title.startsWith(title))!.source.at)
  assert.ok(order("September VAT return filed") < order("Kalia Santé billing"), "the story keeps its order")
  assert.ok(order("Kalia Santé signs") < order("Kalia Santé billing"))

  const tasks = await inOrg(() => root.listTasks({}))
  for (const title of DEMO_FOLLOWUP_ITEMS.flatMap((f) => f.closes ?? [])) assert.equal(tasks.find((t) => t.title === title)?.status, "done", `${title}: done`)
  assert.ok(tasks.some((t) => t.title.startsWith("Create the Black Friday indexes") && t.status === "open"), "a new task, open")

  const events = await inOrg(() => root.listEvents({ limit: 100_000 }))
  assert.ok(events.length > eventsBefore + DEMO_FOLLOWUP_ITEMS.length + DEMO_FOLLOWUP_SEARCHES.length * 2)
  assert.ok(events.every((e) => Date.parse(e.at) <= now), "no event in the future")
  assert.ok(events.some((e) => e.agent === "mcp" && e.summary === "orders migration 0042 staging timeout" && e.zones.includes("dev")), "the agent searched the brain before the migration")

  const status = await inOrg(() => root.getStatus())
  assert.ok(status && Date.parse(status.generated_at) > latest, "the status is generated again")

  assert.equal(await inOrg(() => upgradeFollowupDemo(root, now + 86400_000)), 0, "a second run adds nothing")
})
