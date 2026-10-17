// Export then import of a brain on file storage: the demo brain (Butine) goes into a new company, keeps its people,
// knowledge, tasks and skills, and a second import changes nothing. Rights: a member exports what they read only.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-backup-"))
process.env.BRAIN_DATA_DIR = dir
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.VOYAGE_API_KEY

const { getRootStore, runInOrg, storeForOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { getAccess } = await import("../lib/access")
const { hashToken, newToken } = await import("../lib/auth")
const backupLib = await import("../lib/backup")
const { parseBackup, DEFAULT_ZONES } = await import("@brain/core")
type Viewer = import("../lib/auth").Viewer

const root = getRootStore()
let baseOrg = ""

async function viewerIn(orgId: string, name: string): Promise<Viewer> {
  const p = (await storeForOrg(orgId).listProfiles()).find((x) => x.name.startsWith(name))
  if (!p) throw new Error(`${name} not found`)
  return { profile: p, real: p, access: await getAccess(p) }
}

before(async () => {
  await seedDemoBrain(root)
  baseOrg = (await root.getOrg()).id
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

test("export: the whole brain is for admins, a member's clients stay in their zones", async () => {
  const claire = await viewerIn(baseOrg, "Claire")
  const jm = await viewerIn(baseOrg, "Jean-Marc")
  const brain = await runInOrg(baseOrg, () => backupLib.exportBrain(claire))
  assert.ok(brain.people.length >= 6 && brain.items.length >= 30 && brain.skills.length > 0 && brain.zones.length >= 6)
  assert.ok(!JSON.stringify(brain).includes("token_hash"), "no token in an export")
  await assert.rejects(runInOrg(baseOrg, () => backupLib.exportBrain(jm)), (e: Error & { status?: number }) => e.status === 403)
  const clients = await runInOrg(baseOrg, () => backupLib.exportClients(jm))
  assert.ok(clients.backup.items.every((i) => jm.access.readable.includes(i.zone)), "only the zones Jean-Marc reads")
  assert.ok(clients.csv.startsWith("name,zones,mentions,last_mention,notes\n"))
})

test("employee sheet: Markdown for the admin and for the employee, refused to another member", async () => {
  const claire = await viewerIn(baseOrg, "Claire")
  const hugo = await viewerIn(baseOrg, "Hugo")
  const jm = await viewerIn(baseOrg, "Jean-Marc")
  const sheet = await runInOrg(baseOrg, () => backupLib.personSheet(claire, hugo.profile.id))
  assert.ok(sheet && sheet.markdown.startsWith(`# ${hugo.profile.name}`) && sheet.markdown.includes("## Who did what"))
  assert.ok(sheet.sheet.totals.items > 0 && sheet.backup.people[0].ref === hugo.profile.id)
  assert.ok(await runInOrg(baseOrg, () => backupLib.personSheet(hugo, hugo.profile.id)), "the employee exports their own sheet")
  await assert.rejects(runInOrg(baseOrg, () => backupLib.personSheet(jm, hugo.profile.id)), (e: Error & { status?: number }) => e.status === 403)
  const team = await runInOrg(baseOrg, () => backupLib.teamSheets(claire))
  assert.ok((team.match(/^# /gm) ?? []).length >= 6, "one sheet per person")
})

test("import: the demo brain moves into a new company, then a second import adds nothing", async () => {
  const claire = await viewerIn(baseOrg, "Claire")
  const exported = await runInOrg(baseOrg, () => backupLib.exportBrain(claire))
  const parsed = parseBackup(JSON.parse(JSON.stringify(exported)))
  assert.ok("backup" in parsed)

  const org = await root.createTenantOrg({ name: "Copy", description: "", zones: DEFAULT_ZONES.slice(0, 2) })
  const store = storeForOrg(org.id)
  // The new company's admin is Claire too, same email: matched, not created again.
  const me = await store.createProfile({ name: "Claire Martin", email: claire.profile.email, role: "admin", token_hash: hashToken(newToken()) })
  const admin: Viewer = { profile: me, real: me, access: await getAccess(me) }

  const preview = await runInOrg(org.id, () => backupLib.importBackup(admin, parsed.backup, { dryRun: true }))
  assert.equal((await store.listItems({ limit: 1000 })).length, 0, "a dry run writes nothing")
  assert.equal(preview.items.added, exported.items.length)

  const report = await runInOrg(org.id, () => backupLib.importBackup(admin, parsed.backup))
  assert.equal(report.items.added, exported.items.length)
  assert.equal(report.people.matched, 1)
  assert.equal(report.people.created.length, exported.people.length - 1)
  assert.equal(report.skills.published.length, exported.skills.length)
  assert.deepEqual(report.skills.refused, [])

  const profiles = await store.listProfiles()
  const items = await store.listItems({ limit: 1000 })
  const hugoHere = profiles.find((p) => p.name.startsWith("Hugo"))!
  const hugoThere = exported.people.find((p) => p.name.startsWith("Hugo"))!
  assert.equal(items.filter((i) => i.author_id === hugoHere.id).length, exported.items.filter((i) => i.author_ref === hugoThere.ref).length, "authors are kept")
  assert.ok(items.some((i) => i.created_at === exported.items[0].created_at), "dates are kept")
  const jmHere = profiles.find((p) => p.name.startsWith("Jean-Marc"))!
  assert.deepEqual((await store.listZoneAccess(jmHere.id)).map((a) => a.zone_id), ["finance"], "zone access follows")
  assert.ok(profiles.some((p) => p.manager_id), "reporting lines follow")
  assert.equal((await store.listZones()).length, exported.zones.length)

  const again = await runInOrg(org.id, () => backupLib.importBackup(admin, parsed.backup))
  assert.equal(again.items.added, 0)
  assert.equal(again.items.skipped, exported.items.length)
  assert.equal(again.people.created.length, 0)
  assert.equal(again.tasks.added, 0)
  assert.equal(again.skills.unchanged.length, exported.skills.length)
})

test("import: a spreadsheet of clients, filed by zone; members cannot import knowledge", async () => {
  const claire = await viewerIn(baseOrg, "Claire")
  const jm = await viewerIn(baseOrg, "Jean-Marc")
  const csv = "Client,Zone,Notes,Contact\nMiellerie Nouvelle,Finance,Pays at 60 days,Anne\nRuche Connectée SA,,Wants 200 scales,\n"
  const { backup, problems } = await runInOrg(baseOrg, () => backupLib.clientsCsvBackup(csv, "sales"))
  assert.deepEqual(problems, [])
  assert.deepEqual(
    backup.items.map((i) => [i.zone, i.title]),
    [
      ["finance", "Client: Miellerie Nouvelle"],
      ["sales", "Client: Ruche Connectée SA"],
    ],
  )
  assert.ok(backup.items[0].body.includes("Contact: Anne") && backup.items[0].entities[0].type === "client")
  await assert.rejects(runInOrg(baseOrg, () => backupLib.importBackup(jm, backup)), (e: Error & { status?: number }) => e.status === 403)
  const report = await runInOrg(baseOrg, () => backupLib.importBackup(claire, backup))
  assert.equal(report.items.added, 2)
  const clients = await runInOrg(baseOrg, () => backupLib.exportClients(claire))
  assert.ok(clients.csv.includes("Miellerie Nouvelle"), "an imported client comes back in the export")
})
