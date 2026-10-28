// Smoke test of the brain on the current storage (file or Postgres): npm run smoke
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { fork } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import postgres from "postgres"
import { DISTILL_MARKER, buildCliStatusPrompt, parseStatusJson, redactText, workstationHealth, slugify, tokenize, type CompanyStatus, type KnowledgeItemInput, type NewZonesInput, type StatusInput, type Task } from "@brain/core"
import { getRootStore, getStore, isStoreSetupError, runInOrg, storeForOrg, type BrainStore } from "../lib/store"
import { FileStore } from "../lib/store/file"
import { PostgresStore } from "../lib/store/postgres"
import { getAccess, redactEvent } from "../lib/access"
import {
  createEventPoller,
  exploreEntity,
  getEntityContext,
  getPersonContext,
  getState,
  hybridSearch,
  ingestItems,
  itemAuthorOrAdmin,
  queryBrain,
  recordEvents,
  refreshStatus,
  runAutomationDetection,
  statusForViewer,
  streamStartId,
} from "../lib/brain"
import {
  createConnectorKey,
  createLoginCode,
  createOnboardingCode,
  createSessionValue,
  forgetAccount,
  hashToken,
  isRemembered,
  latestRemembered,
  listRememberedAccounts,
  newToken,
  profileFromToken,
  rememberAccounts,
  verifyLoginCode,
  viewerFromCookies,
  type Viewer,
} from "../lib/auth"
import { isBlockedAddress, scrapeUrl, scrapeUrlWith } from "../lib/scrape"
import * as automationsRoute from "../app/api/automations/route"
import * as connectorRoute from "../app/api/connector/route"
import * as entitiesRoute from "../app/api/entities/route"
import * as zoneRoute from "../app/api/zones/[id]/route"
import * as healthRoute from "../app/api/health/route"
import * as adminZonesRoute from "../app/api/admin/zones/route"
import * as rezoneRoute from "../app/api/items/rezone/route"
import * as adminNewZonesRoute from "../app/api/admin/zones/auto/route"
import * as adminNewZonesInputRoute from "../app/api/admin/zones/auto/input/route"
import * as cronNewZonesRoute from "../app/api/cron/new-zones/route"
import * as adminClaudeRoute from "../app/api/admin/claude/route"
import * as adminModerationRoute from "../app/api/admin/moderation/route"
import * as adminModerationInputRoute from "../app/api/admin/moderation/input/route"
import { loadModerationLog, moderationInput, runModeration, setModerationEnabled } from "../lib/moderation"
import { runNewZones } from "../lib/new-zones"
import { getOrgClaudeKey, setOrgClaudeKey } from "../lib/claude-key"
import { getClaude } from "../lib/ai"
import * as statusRoute from "../app/api/status/route"
import * as statusInputRoute from "../app/api/status/input/route"
import * as stateRoute from "../app/api/state/route"
import * as demoSessionRoute from "../app/api/session/demo/route"
import * as adminUsersRoute from "../app/api/admin/users/route"
import * as adminTeamRoute from "../app/api/admin/team/route"
import * as itemRoute from "../app/api/items/[id]/route"
import * as joinRoute from "../app/api/join/route"
import * as onboardingAgentRoute from "../app/api/onboarding/agent/route"
import * as onboardingToolsRoute from "../app/api/onboarding/tools/route"
import * as onboardingToolsCallRoute from "../app/api/onboarding/tools/call/route"
import * as onboardingImportRoute from "../app/api/onboarding/import/route"
import * as onboardingProgressRoute from "../app/api/onboarding/progress/route"
import * as onboardingApplyRoute from "../app/api/onboarding/apply/route"
import * as onboardingZonesRoute from "../app/api/onboarding/zones/route"
import * as joinStatusRoute from "../app/api/join/status/route"
import * as adminJoinRoute from "../app/api/admin/join/route"
import * as adminJoinIdRoute from "../app/api/admin/join/[id]/route"
import * as skillsRoute from "../app/api/skills/route"
import * as skillRoute from "../app/api/skills/[id]/route"
import * as mcpRoute from "../app/api/mcp/[orgId]/[token]/route"
import * as mcpConnectorsRoute from "../app/api/connectors/mcp/route"
import * as mcpConnectorRoute from "../app/api/connectors/mcp/[id]/route"
import * as mcpConnectorTestRoute from "../app/api/connectors/mcp/[id]/test/route"
import * as mcpCallbackRoute from "../app/api/connectors/mcp/callback/route"
import * as mcpImportRoute from "../app/api/connectors/mcp/[id]/import/route"
import * as connectedToolsRoute from "../app/api/connected-tools/route"
import * as connectedCallRoute from "../app/api/connected-tools/call/route"
import { DEMO_VISITOR_TITLE, demoVisitorManager, replaceOutdatedDemoBrain, seedDemoBrain, upgradeDemoBrain } from "../lib/demo-seed"
import { DEMO_CORE_ITEMS, DEMO_ITEMS, DEMO_ORG, DEMO_SCREENPIPE_ITEMS, LEGACY_DEMO_NAMES } from "./demo-data"
import { SkillError, canPublishSkills, listVisibleSkills, publishSkill, removeSkill, setSkillZone } from "../lib/skills"

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`)
  console.log(`✓ ${msg}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function viewer(name: string): Promise<Viewer> {
  const p = (await getStore().listProfiles()).find((x) => x.name.startsWith(name))
  if (!p) throw new Error(`profile ${name} not found (run the seed)`)
  return { profile: p, real: p, access: await getAccess(p) }
}

function item(zone: string, title: string, kind: KnowledgeItemInput["kind"] = "fact"): KnowledgeItemInput {
  return { zone, kind, title, body: `${title}. Smoke test.`, entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.7 }
}

type Handler = (req: Request, ctx: any) => Promise<Response>

/** Calls an API route the way Next would (dashboard session cookie). */
async function call(handler: Handler, url: string, opts: { method?: string; session?: string; body?: unknown; raw?: string; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.session) headers.cookie = `brain_session=${opts.session}`
  const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
  const res = await handler(new Request(`http://smoke.test${url}`, { method: opts.method ?? "GET", headers, body }), { params: Promise.resolve(opts.params ?? {}) })
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

function pgClient(url: string, max = 2) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
  return postgres(url, { prepare: false, max, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
}

/** Applies the migrations to `url` (scripts/migrate.ts in a child process). */
function migrate(url: string): Promise<void> {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrate.ts")
  return new Promise((resolve, reject) => {
    const child = fork(script, [], { env: { ...process.env, DATABASE_URL: url }, execArgv: process.execArgv, stdio: "ignore" })
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrations: code ${code}`))))
  })
}

/**
 * E3: reset() while another instance rereads the organization. In a throwaway database (the reset empties everything):
 * skipped if the role cannot create a database.
 */
async function orgRaceTest(baseUrl: string, run: string) {
  const dbName = `brain_smoke_e3_${run}`.replace(/[^a-z0-9_]/g, "_")
  const admin = pgClient(baseUrl, 1)
  try {
    await admin.unsafe(`create database "${dbName}"`)
  } catch (err) {
    console.log(`⚠ E3 race test skipped (cannot create a throwaway database: ${(err as Error).message})`)
    await admin.end({ timeout: 5 })
    return
  }
  const u = new URL(baseUrl)
  u.pathname = `/${dbName}`
  const url = u.toString()
  const stores: PostgresStore[] = []
  const open = () => {
    const st = new PostgresStore(url)
    stores.push(st)
    return st as any
  }
  const sql = pgClient(url)
  try {
    await migrate(url)
    const [first, second] = [open(), open()]
    const [o1, o2] = await Promise.all([first.getOrg(), second.getOrg()])
    const [{ n: fresh }] = await sql`select count(*)::int as n from orgs`
    assert(fresh === 1 && o1.id === o2.id, "fresh database: two instances starting together create only one organization")

    // B reseeds (latency added INSIDE the transaction, between the purge and the creation, as from a laptop);
    // A rereads its org continuously (expired cache), C behaves like a starting instance (no cache).
    const [A, B, C] = [open(), open(), open()]
    const insertOrg = B.insertOrg.bind(B)
    B.insertOrg = async (tx: unknown, o: unknown) => {
      await sleep(150)
      return insertOrg(tx, o)
    }
    await A.getOrg()
    let stop = false
    let refreshes = 0
    let starts = 0
    let failures = 0
    const refreshLoop = (async () => {
      while (!stop) {
        if (A.orgCache) A.orgCache.at = 0
        await A.getOrg().then(() => refreshes++, () => failures++)
        await sleep(5)
      }
    })()
    const startLoop = (async () => {
      while (!stop) {
        C.orgCache = null
        await C.getOrg().then(() => starts++, () => failures++)
        await sleep(5)
      }
    })()
    const counts: number[] = []
    let wrong = 0
    for (let k = 0; k < 20; k++) {
      await B.reset({ name: `Smoke org ${k}`, description: "" })
      const rows = await sql`select name from orgs`
      counts.push(rows.length)
      if (rows[0]?.name !== `Smoke org ${k}`) wrong++
      await sleep(20)
    }
    stop = true
    await Promise.all([refreshLoop, startLoop])
    assert(
      counts.every((c) => c === 1) && wrong === 0 && failures === 0 && refreshes > 0 && starts > 0,
      `20 reseeds while two other instances reread the org: never a stray org (${refreshes} rereads, ${starts} starts)`,
    )
    A.orgCache.at = 0
    assert((await A.getOrg()).name === "Smoke org 19", "the other instance follows the new organization")

    // Purge done by another tool (old seed: truncate then separate creation): a refresh creates nothing.
    await sql`truncate orgs cascade`
    A.orgCache.at = 0
    const kept = await A.getOrg()
    const [{ n: afterPurge }] = await sql`select count(*)::int as n from orgs`
    assert(afterPurge === 0 && kept.name === "Smoke org 19", "table emptied elsewhere: a cache refresh never creates an organization")
    const [x1, x2] = await Promise.all([open().getOrg(), open().getOrg()])
    const [{ n: recreated }] = await sql`select count(*)::int as n from orgs`
    assert(recreated === 1 && x1.id === x2.id, "empty database: two simultaneous first loads create a single organization (atomic insert)")
    await open().createProfile({ name: "Smoke", role: "admin", token_hash: `smoke-${run}` })
    await sql`insert into orgs (name, description, created_at) values ('Stray org', '', now() - interval '1 day')`
    assert((await open().getOrg()).id === x1.id, "an older empty (stray) organization is ignored in favor of the one that has accounts")
  } finally {
    await Promise.all(stores.map((st) => st.end().catch(() => {})))
    await sql.end({ timeout: 5 })
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`).catch((err) => console.log(`⚠ throwaway database ${dbName} not dropped: ${err.message}`))
    await admin.end({ timeout: 5 })
  }
}

/** Child process (file storage lock test): writes events and items into `dir`. */
async function writer(dir: string, tag: string, n: number) {
  const store = new FileStore(dir)
  const author = (await store.listProfiles())[0]
  for (let i = 0; i < n; i++) {
    await store.insertEvents([{ user_id: author.id, agent: "job", type: "query", zones: [], summary: `${tag}-${i}`, at: new Date().toISOString() }])
    if (i % 10 === 0) await store.insertItems([{ ...item("dev", `${tag} item ${i}`), author_id: author.id }])
    await sleep(Math.random() * 4)
  }
}

async function main() {
  const store = getStore()
  const run = Date.now().toString(36)
  const created: string[] = []
  console.log(`Storage: ${store.kind}`)
  const claire = await viewer("Claire")
  const jm = await viewer("Jean-Marc")
  const hugo = await viewer("Hugo")
  const ines = await viewer("Inès")
  const sarah = await viewer("Sarah")
  const zones = await store.listZones()
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id

  assert(claire.access.isAdmin && claire.access.readable.length >= 6, "the admin reads every zone")
  assert(jm.access.readable.join() === "core,finance", "Jean-Marc only reads finance, and the core everyone reads")
  assert(zones.at(-1)?.id === "core" && zones.filter((z) => z.id === "core").length === 1, "every brain has its core, once, after the other zones")

  const devForJm = await queryBrain(jm, { query: "deploy to production" })
  assert(devForJm.items.every((i) => i.zone === "core"), "RLS: finance sees nothing of the dev zone (only what the core says)")
  assert(devForJm.zones_restricted.includes("dev"), "the dev zone is flagged as restricted")
  const devForHugo = await queryBrain(hugo, { query: "deploy to production" })
  assert(devForHugo.items.some((i) => i.title.includes("Deploy Encore")), "Hugo finds the deployment procedure")
  const finance = await queryBrain(jm, { query: "Qonto Pennylane reconciliation" })
  assert(finance.items[0]?.zone === "finance" && finance.zones_hit.includes("finance"), "Jean-Marc finds the reconciliation, the finance zone lights up")

  const before = (await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0
  const res = await ingestItems(hugo, [
    {
      zone: "unknown", kind: "task", title: `Add an index on returns (${run})`, body: "TODO before going to prod. Contact: hugo@encore.example, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      entities: [{ type: "tool", name: "Postgres" }], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.7,
    },
  ])
  const it = await store.getItem(res.ids[0])
  assert(it && it.zone === "dev", "an unknown zone is reclassified (dev)")
  assert(it && !it.body.includes("sk-ant") && !it.body.includes("@encore"), "secrets and emails redacted on the server")
  assert(((await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0) === before + 1, "the dev zone counter goes up")
  assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.source_item_id === res.ids[0]), "a task is created from the item")

  const evs = await recordEvents(hugo, [{ agent: "claude-code", type: "query", summary: "fix the stripe webhook bug in prod" }])
  assert(evs[0].zones.includes("dev") && evs[0].summary, "a prompt without a zone is classified (dev) and keeps its summary")
  const after = await store.listEvents({ afterId: evs[0].id - 1, limit: 10 })
  assert(after[0]?.id === evs[0].id, "the live stream rereads events in order")

  const stJm = await getState(jm)
  assert(stJm.items.every((i) => i.zone === "finance" || i.zone === "core"), "Jean-Marc's state only contains finance, and the core")
  assert(stJm.zones.find((z) => z.id === "core")?.locked === false && stJm.items.some((i) => i.zone === "core"), "everyone reads the core")
  assert(stJm.zones.find((z) => z.id === "dev")?.locked === true, "the dev zone is locked for Jean-Marc")
  assert(stJm.automations.every((a) => a.user_id === jm.profile.id), "Jean-Marc only sees his own automations")

  const autos = await runAutomationDetection()
  assert(autos.some((a) => a.title.includes("Qonto")), "the 9am reconciliation automation is detected")
  const status = await refreshStatus(claire)
  assert(status.zones.length >= 6 && status.headline.length > 10, `company status generated (${status.generator})`)
  const ctx = await getPersonContext(claire, hugo.profile.id)
  assert(ctx && ctx.zones[0]?.zone === "dev" && ctx.items.length > 0, "Hugo's handover context")

  assert(await store.deleteItem(res.ids[0]), "the author can delete a knowledge item")
  assert(!(await store.listTasks({})).some((t) => t.source_item_id === res.ids[0]), "its task goes with it")

  console.log("\n— Company skills: publishing under permission, assignment to a cortex")
  const names = async (v: Viewer) => (await listVisibleSkills(v)).map((x) => x.name)
  const jmSkills = await names(jm)
  assert(jmSkills.includes("encore-tone") && jmSkills.includes("qonto-pennylane-reconciliation"), "Jean-Marc receives the company-wide skills and the finance cortex's")
  assert(!jmSkills.includes("deploy-encore"), "but not the dev cortex's")
  assert((await names(hugo)).includes("deploy-encore") && !(await names(hugo)).includes("qonto-pennylane-reconciliation"), "Hugo receives the dev skill, not the finance one")
  assert((await names(claire)).length >= 5, "the admin sees every skill")
  assert(canPublishSkills(claire) && canPublishSkills(hugo) && !canPublishSkills(ines), "publishing: admins and allowed members only")
  const refused = async (p: Promise<unknown>, status: number) => {
    try {
      await p
      return false
    } catch (err) {
      return err instanceof SkillError && err.status === status
    }
  }
  const skillName = `smoke-${run}`
  const files = [
    { path: "SKILL.md", content: "# Smoke test\n\nRun scripts/run.py." },
    { path: "scripts/run.py", content: "import os\nprint(os.environ['PENNYLANE_TOKEN'])\n" },
  ]
  assert(await refused(publishSkill(ines, { name: skillName, description: "Test", zone: null, files }), 403), "Inès (no permission) cannot publish")
  assert(await refused(publishSkill(jm, { name: skillName, description: "Test", zone: "dev", files }), 403), "Jean-Marc cannot assign a skill to the dev cortex, which he does not read")
  const leak = [...files, { path: "scripts/leak.sh", content: `curl -H "Authorization: Bearer ${["sk-ant-", "api03-", "z".repeat(40)].join("")}" https://api.example` }]
  try {
    await publishSkill(jm, { name: skillName, description: "Test", zone: "finance", files: leak })
    throw new Error("FAILED: a skill with a secret should have been refused")
  } catch (err) {
    assert(err instanceof SkillError && err.status === 400 && err.details?.some((d) => d.startsWith("scripts/leak.sh")), "a script that contains a secret is refused, naming the file")
  }
  assert(await refused(publishSkill(jm, { name: skillName, description: "Test", zone: "finance", files: [...files, { path: "../../.bashrc", content: "x" }] }), 400), "a path that leaves the skill is refused")
  const v1 = await publishSkill(jm, { name: skillName, description: "Skills smoke test", zone: "finance", files })
  assert(v1.created && v1.skill.version === 1 && v1.skill.zone === "finance", "Jean-Marc publishes a skill in the finance cortex")
  assert(v1.skill.files[0].content.startsWith(`---\nname: ${skillName}\ndescription: "Skills smoke test"\n---`), "SKILL.md gets the header Claude Code expects")
  assert((await store.listEvents({ limit: 5 })).some((e) => e.type === "write" && e.zones.join() === "finance" && e.summary?.includes(skillName)), "publishing lights up the finance cortex")
  const v2 = await publishSkill(jm, { name: skillName, description: "", files })
  assert(!v2.created && v2.skill.version === 2 && v2.skill.zone === "finance" && v2.skill.description === "Skills smoke test", "same name: version 2, cortex and description kept")
  assert(await refused(publishSkill(hugo, { name: skillName, description: "x", zone: "dev", files }), 409), "a name taken in an unreadable cortex is refused without saying anything about it")
  assert(await refused(setSkillZone(hugo, v1.skill.id, null), 404), "Hugo does not see the finance skill (404)")
  await setSkillZone(jm, v1.skill.id, null)
  assert((await names(hugo)).includes(skillName), "assigned to the whole company, Hugo receives it")
  assert(await refused(setSkillZone(hugo, v1.skill.id, "dev"), 403), "only the author or an admin changes its cortex")
  await setSkillZone(claire, v1.skill.id, "dev")
  assert(!(await names(jm)).includes(skillName) && (await names(hugo)).includes(skillName), "the admin assigns it to the dev cortex: Jean-Marc no longer receives it")
  assert((await getState(jm)).totals.skills === (await names(jm)).length, "the Skills tab counter follows permissions")
  const ineSession = await createSessionValue(ines.profile.id)
  const listed = await call(skillsRoute.GET, "/api/skills", { session: ineSession })
  assert(listed.status === 200 && listed.data.can_publish === false && listed.data.skills.every((x: { zone: string | null }) => x.zone === null || ines.access.readable.includes(x.zone)), "GET /api/skills: Inès's skills, without the right to publish")
  const denied = await call(skillsRoute.POST, "/api/skills", { method: "POST", session: ineSession, body: { name: `${skillName}-b`, description: "x", files } })
  assert(denied.status === 403 && /permission/.test(denied.data.error), "POST /api/skills without permission: 403")
  const jmSession = await createSessionValue(jm.profile.id)
  const patched = await skillRoute.PATCH(
    new Request(`http://smoke.test/api/skills/${v1.skill.id}`, { method: "PATCH", headers: { cookie: `brain_session=${jmSession}`, "content-type": "application/json" }, body: JSON.stringify({ zone: null }) }),
    { params: Promise.resolve({ id: v1.skill.id }) },
  )
  assert(patched.status === 404, "PATCH of a skill outside one's cortices: 404")
  await removeSkill(claire, v1.skill.id)
  assert(!(await store.getSkill(v1.skill.id)), "the admin removes the skill")

  console.log("\n— Demo filled by an earlier version: completed without erasing anything")
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-upgrade-"))
    try {
      const old = new FileStore(tmp)
      await seedDemoBrain(old)
      // Before reporting lines and skills: flat org chart, no skills, nobody allowed to publish.
      const team = await old.listProfiles()
      for (const p of team) await old.updateProfile(p.id, { manager_id: null, can_publish_skills: false })
      for (const sk of await old.listSkills()) await old.deleteSkill(sk.id)
      const visitor = await old.createProfile({ name: "Visitor 1234", title: DEMO_VISITOR_TITLE, role: "member", token_hash: hashToken(newToken()) })
      const itemsBefore = (await old.listItems({})).length
      const res = await upgradeDemoBrain(old)
      const after = new Map((await old.listProfiles()).map((p) => [p.name, p]))
      const id = (n: string) => team.find((p) => p.name.startsWith(n))!.id
      assert(after.get("Inès Lefèvre")?.manager_id === id("Hugo") && after.get("Jean-Marc Dubois")?.manager_id === id("Claire"), "the flat org chart gets its reporting lines back")
      assert(after.get("Claire Martin")?.manager_id == null, "the CEO stays at the top")
      assert(after.get("Visitor 1234")?.manager_id === id("Hugo"), "visitors join the lead dev's team")
      assert(res.skills === 5 && (await old.listSkills()).find((x) => x.name === "deploy-encore")?.version === 3, "the demo skills are added")
      assert(after.get("Hugo Bernard")?.can_publish_skills === true && after.get("Inès Lefèvre")?.can_publish_skills === false, "Hugo and Jean-Marc get the right to publish")
      assert((await old.listItems({})).length === itemsBefore && visitor.id === after.get("Visitor 1234")?.id, "nothing is erased")
      await old.updateProfile(id("Inès"), { manager_id: id("Claire") })
      const again = await upgradeDemoBrain(old)
      assert(again.managers === 0 && again.skills === 0 && (await old.getProfile(id("Inès")))?.manager_id === id("Claire"), "run again: no longer touches an admin's choices")
      assert((await demoVisitorManager(old)) === id("Hugo"), "a new visitor reports to the lead dev")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log("\n— Demo still on the former fictional company: replaced, visitors kept")
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-legacy-"))
    try {
      const old = new FileStore(tmp)
      await seedDemoBrain(old)
      assert((await replaceOutdatedDemoBrain(old)) === null, "the current demo is never replaced")
      await old.updateOrg({ name: LEGACY_DEMO_NAMES[LEGACY_DEMO_NAMES.length - 1] })
      const token = newToken()
      // A visitor created by an earlier (French) version: its title was still French.
      const visitor = await old.createProfile({ name: "Visitor 4321", title: "Visiteur de la démo", role: "member", token_hash: hashToken(token) })
      await old.setZoneAccess(visitor.id, [{ zone_id: "dev", can_write: true }, { zone_id: "product", can_write: false }])
      await old.insertItems([{ ...item("dev", `Smoke ${run} former demo`), author_id: visitor.id }])
      const res = await replaceOutdatedDemoBrain(old)
      const kept = await old.getProfileByTokenHash(hashToken(token))
      const hugoNow = (await old.listProfiles()).find((p) => p.name === "Hugo Bernard")
      assert(res?.visitors === 1 && (await old.getOrg()).name === DEMO_ORG.name, `the former demo becomes ${DEMO_ORG.name}`)
      assert(kept?.name === "Visitor 4321" && kept.title === DEMO_VISITOR_TITLE && kept.manager_id === hugoNow?.id, "the visitor keeps its token and joins the lead dev's team")
      assert(
        (await old.listZoneAccess(kept!.id)).map((a) => `${a.zone_id}:${a.can_write}`).sort().join() === "dev:true,product:false",
        "and keeps its zones",
      )
      assert(
        (await old.listItems({})).length === DEMO_ITEMS.length + DEMO_SCREENPIPE_ITEMS.length + DEMO_CORE_ITEMS.length && (await old.listSkills()).some((x) => x.name === "deploy-encore"),
        "knowledge and skills of the new demo, without those of the former one",
      )
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log("\n— Open writing, author's oversight (D1)")
  const jmDev = await ingestItems(jm, [item("dev", `Smoke ${run} Vercel deployment by finance`, "procedure")])
  created.push(...jmDev.ids)
  assert(jmDev.inserted === 1 && jmDev.zones.join() === "dev", "everyone feeds the brain: Jean-Marc (finance) writes in dev")
  const jmCtx = await getPersonContext(jm, jm.profile.id)
  assert(jmCtx?.items.some((i) => i.id === jmDev.ids[0]), "My context: Jean-Marc sees his item filed in dev")
  assert(jmCtx?.unreadable_zones.includes("dev"), "the unreadable zone of his item is flagged")
  const asJm: Viewer = { profile: jm.profile, real: claire.real, access: jm.access }
  assert((await getPersonContext(asJm, jm.profile.id))?.items.some((i) => i.id === jmDev.ids[0]), "\"view as Jean-Marc\" shows his item too")
  const jmSearch = await queryBrain(jm, { query: `Smoke ${run} Vercel deployment` })
  assert(jmSearch.items.some((i) => i.id === jmDev.ids[0]), "his own search finds his item")
  assert(jmSearch.items.every((i) => i.zone === "finance" || i.zone === "core" || i.author_id === jm.profile.id), "but nothing else from the dev zone")
  assert(!jmSearch.zones_hit.includes("dev"), "his search does not light up (and is not broadcast in) the dev zone")
  assert((await queryBrain(jm, { query: `Smoke ${run} deployment`, zones: ["sales"] })).items.length === 0, "the zone filter applies to his own items too")
  assert(!(await queryBrain(sarah, { query: `Smoke ${run} Vercel deployment` })).items.some((i) => i.id === jmDev.ids[0]), "Sarah (no dev) does not see it")
  assert((await queryBrain(hugo, { query: `Smoke ${run} Vercel deployment` })).items.some((i) => i.id === jmDev.ids[0]), "Hugo (dev) sees it")
  const jmItem = await store.getItem(jmDev.ids[0])
  assert(jmItem && itemAuthorOrAdmin(jm, jmItem) && !itemAuthorOrAdmin(hugo, jmItem), "only the author (or an admin) can delete it")

  console.log("\n— Deduplication on ingestion (D6)")
  const again = await ingestItems(jm, [item("dev", `SMOKE ${run}  Vercel deployment by FINANCE`, "procedure")])
  assert(again.inserted === 0 && again.skipped === 1, "same author, same zone, same normalized title: skipped")
  const dup = await ingestItems(hugo, [item("dev", `Smoke ${run} duplicate`), item("dev", `smoke ${run} duplicate`), item("product", `Smoke ${run} duplicate`)])
  created.push(...dup.ids)
  assert(dup.inserted === 2 && dup.skipped === 1, "duplicate within a batch skipped, same title in another zone kept")
  const sameTitle = `Smoke ${run} claude — encore`
  const fact1 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "We decided to switch to Pennylane." }])
  const fact2 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "We also decided to keep Qonto for cash." }])
  created.push(...fact1.ids, ...fact2.ids)
  assert(fact1.inserted === 1 && fact2.inserted === 1 && fact2.skipped === 0, "same title but different content: both facts are kept (E1)")
  const fact3 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "We also  decided to keep QONTO for cash. " }])
  assert(fact3.inserted === 0 && fact3.skipped === 1, "same title and same content (normalized): skipped")
  const partly = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "We decided to switch to Pennylane." }, item("product", `Smoke ${run} product idea`)])
  created.push(...partly.ids)
  assert(partly.inserted === 1 && partly.skipped === 1 && partly.zones.join() === "product", "ingestion response: only the zones that really received an item")

  console.log("\n— Write events per zone and summaries (D2)")
  const batch = await ingestItems(claire, [item("finance", `Smoke ${run} treasury: 2 months of cash left`), item("dev", `Smoke ${run} Postgres migration of the alerts table`)])
  created.push(...batch.ids)
  const writes = (await store.listEvents({ limit: 20, type: "write" })).filter((e) => e.user_id === claire.profile.id && e.summary?.includes(`Smoke ${run}`))
  const financeWrite = writes.find((e) => e.zones.join() === "finance")
  const devWrite = writes.find((e) => e.zones.join() === "dev")
  assert(writes.length === 2 && financeWrite && devWrite, "a batch over two zones emits one write event per zone")
  assert(financeWrite!.summary!.includes("treasury") && !devWrite!.summary!.includes("treasury"), "each summary only mentions the items of its zone")
  const hugoState = await getState(hugo)
  const hugoSeesFinance = hugoState.events.find((e) => e.id === financeWrite!.id)
  assert(hugoSeesFinance && !hugoSeesFinance.summary && hugoSeesFinance.restricted, "Hugo (no finance) sees the finance write without its summary")
  assert(hugoState.events.find((e) => e.id === devWrite!.id)?.summary?.includes("migration"), "Hugo sees the summary of the dev write")
  const [multi] = await recordEvents(claire, [{ agent: "mcp", type: "query", zones: ["dev", "finance"], summary: `Smoke ${run} multi-zone` }])
  assert(!redactEvent(multi, hugo.access, hugo.profile.id).summary && !redactEvent(multi, jm.access, jm.profile.id).summary, "event on dev+finance: summary hidden from whoever does not read both")
  assert(redactEvent(multi, claire.access, hugo.profile.id).summary, "the admin sees the summary")

  const personal = "write a letter to my doctor about my depression and my divorce"
  const [priv] = await recordEvents(hugo, [{ agent: "mcp", type: "query", summary: personal, fingerprint: "fp-smoke", session_id: "s-smoke" }])
  assert(priv.zones.length === 0, "a personal text is attached to no zone")
  const jmView = (await getState(jm)).events.find((e) => e.id === priv.id)
  assert(jmView && !jmView.summary && !jmView.fingerprint && !jmView.session_id && jmView.restricted_reason === "private", "event without a zone: no summary, fingerprint or session for others")
  assert((await getState(hugo)).events.find((e) => e.id === priv.id)?.summary === personal, "the author sees their own event")
  const [hookPersonal, hookOff] = await recordEvents(hugo, [
    { agent: "claude-code", type: "query", summary: personal, fingerprint: "fp-personal" },
    { agent: "claude-code", type: "query", summary: "tell me a joke about cats", fingerprint: "fp-joke" },
  ])
  assert(!hookPersonal.summary && hookPersonal.fingerprint === "fp-personal", "personal prompt (hook): fingerprint only, no summary stored")
  assert(!hookOff.summary && hookOff.zones.length === 0, "off-zone prompt (hook): no summary stored")
  const [dupZones] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev", "dev", "product", "dev"], summary: `Smoke ${run} zones` }])
  assert(dupZones.zones.join() === "dev,product", "an event's zones are deduplicated")

  console.log("\n— Searches: text kept only without an unreadable zone or personal content (E2)")
  const lastEvent = async (v: Viewer) => (await store.listEvents({ userId: v.real.id, limit: 1 }))[0]
  const inesQuery = await queryBrain(ines, { query: "what is the payroll salary" })
  assert(
    inesQuery.zones_hit.every((z) => z === "core") && inesQuery.items.every((i) => i.zone === "core") && inesQuery.zones_restricted.includes("finance"),
    "Inès's search on finance: nothing readable (only what the core says)",
  )
  const inesEvent = await lastEvent(ines)
  const sarahView = (await getState(sarah)).events.find((e) => e.id === inesEvent?.id)
  assert(inesEvent && !inesEvent.summary && sarahView && !sarahView.summary, "this search is neither kept nor broadcast to Sarah")
  const mixedText = "Hugo's dismissal and his salary, plan the deployment update"
  const mixed = await queryBrain(ines, { query: mixedText })
  const mixedEvent = await lastEvent(ines)
  assert(mixed.zones_hit.includes("dev") && mixed.zones_restricted.includes("finance"), "Inès's search on dev AND finance: dev lights up, finance flagged")
  assert(mixedEvent.zones.join() === mixed.zones_hit.join() && !mixedEvent.summary, "the event keeps the lit zones, without the search text")
  const leo = await viewer("Léo")
  assert(
    !redactEvent(mixedEvent, leo.access, leo.profile.id).summary && !(await getState(hugo)).events.find((e) => e.id === mixedEvent.id)?.summary,
    "Léo and Hugo (dev, no finance) do not read this text",
  )
  await queryBrain(hugo, { query: "write a letter to my doctor about my depression, and the deployment" })
  const persoEvent = await lastEvent(hugo)
  assert(persoEvent.zones.includes("dev") && !persoEvent.summary, "personal search: zone lit, text not kept")
  await queryBrain(hugo, { query: `Smoke ${run} deploy to production` })
  assert((await lastEvent(hugo)).summary === `Smoke ${run} deploy to production`, "search within one's zones, nothing personal: text kept")
  const both = `Smoke ${run} support tickets about eSIM and deployment`
  await queryBrain(hugo, { query: both })
  const bothEvent = await lastEvent(hugo)
  assert(bothEvent.summary === both && bothEvent.zones.includes("dev") && bothEvent.zones.includes("support"), "text kept: the event carries every zone touched (dev + support)")
  assert(!redactEvent(bothEvent, ines.access, ines.profile.id).summary, "Inès (dev without support) does not read this text, which also talks about support")
  await queryBrain(claire, { query: "payroll salary and vercel deployment" })
  assert((await lastEvent(claire)).summary === "payroll salary and vercel deployment", "the admin reads every zone: text kept")
  const jmOwn = await queryBrain(jm, { query: `Smoke ${run}` })
  assert(jmOwn.items.some((i) => i.id === jmDev.ids[0]) && !(await lastEvent(jm)).summary, "search that finds one's own item filed in an unreadable zone: text not kept")

  console.log("\n— \"Where the company stands\" limited to readable zones (D4)")
  const jmStatus = await statusForViewer(jm)
  assert(jmStatus && jmStatus.zones.every((z) => z.zone === "finance" || z.zone === "core"), "Jean-Marc only receives the finance zone, and the core")
  assert(jmStatus && jmStatus.headline !== status.headline && jmStatus.headline.startsWith(`In your zone (${zoneName("finance")})`), `headline recomputed on his zone: "${jmStatus?.headline}"`)
  assert((await getState(jm)).status?.headline === jmStatus?.headline, "same headline in the dashboard state")
  assert((await statusForViewer(hugo))?.headline.startsWith("In your zones ("), "Hugo: headline over his three zones")
  assert((await statusForViewer(claire))?.headline === status.headline, "the admin keeps the global headline")

  console.log("\n— API: automations sent up by Screenpipe")
  const hugoSession = await createSessionValue(hugo.profile.id)
  const claireSession = await createSessionValue(claire.profile.id)
  const wf = await call(automationsRoute.POST, "/api/automations", {
    method: "POST",
    session: hugoSession,
    body: {
      workflows: [
        {
          id: `smoke-${run}`,
          title: "Follow up with marie.durand@gmail.com at 06 12 34 56 78",
          description: "Export the statements, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
          schedule: "every Monday, write to jean@personal.example",
          zone: "unknown",
        },
      ],
    },
  })
  const savedWf = (await store.listAutomations()).find((a) => a.key === `screenpipe:${hugo.profile.id}:smoke-${run}`)
  assert(wf.status === 201 && savedWf, "POST /api/automations saves the workflow")
  const wfText = `${savedWf!.title} ${savedWf!.description} ${savedWf!.schedule}`
  assert(!/marie\.durand|06 12 34 56 78|sk-ant|jean@personal/.test(wfText) && wfText.includes("redacted"), `title, description and schedule redacted on the server ("${savedWf!.title}")`)
  assert(savedWf!.zone === undefined, "unknown zone dropped")
  await store.updateAutomation(savedWf!.id, { status: "dismissed" })

  console.log("\n— API: zone creation")
  const existing = zones.find((z) => slugify(z.name) === z.id)!
  const clash = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { name: existing.name.toUpperCase() } })
  const untouched = (await store.listZones()).find((z) => z.id === existing.id)!
  assert(clash.status === 409 && /already exists/.test(clash.data?.error ?? ""), `name already taken without an explicit id: 409 ("${clash.data?.error}")`)
  assert(untouched.keywords.length === existing.keywords.length && untouched.description === existing.description, "the existing zone is not overwritten")
  const edit = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { id: existing.id, name: existing.name } })
  const edited = (await store.listZones()).find((z) => z.id === existing.id)!
  assert(edit.status === 200 && edited.keywords.length === existing.keywords.length && edited.description === existing.description, "with its id: updated, keywords and description kept")
  assert((await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: hugoSession, body: { name: `Smoke ${run}` } })).status === 403, "admins only (403)")
  const withProjects = await call(adminZonesRoute.POST, "/api/admin/zones", {
    method: "POST",
    session: claireSession,
    body: { id: existing.id, name: existing.name, projects: ["~/dev/Encore/", "git@github.com:acme/api.git", "encore", " "] },
  })
  assert(withProjects.status === 200 && JSON.stringify(withProjects.data?.projects) === JSON.stringify(["encore", "acme/api"]), `projects normalized, without duplicates (${JSON.stringify(withProjects.data?.projects)})`)
  const keptProjects = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { id: existing.id, name: existing.name } })
  assert(JSON.stringify((await store.listZones()).find((z) => z.id === existing.id)?.projects) === JSON.stringify(["encore", "acme/api"]) && keptProjects.status === 200, "projects stored, kept when absent from the body")
  await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { id: existing.id, name: existing.name, projects: [] } })
  assert(!(await store.listZones()).find((z) => z.id === existing.id)?.projects?.length, "projects emptied")

  console.log("\n— API: rezone (knowledge already in the brain filed into its project's zone)")
  const sid = `smoke-${run}-session`
  const [rzA, rzB] = await store.insertItems([
    { ...item("dev", `Smoke ${run} rezone chunk 0`), source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString(), session_id: `${sid}#0` }, author_id: hugo.profile.id },
    { ...item("dev", `Smoke ${run} rezone chunk 1`), source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString(), session_id: `${sid}#1` }, author_id: hugo.profile.id },
  ])
  const [rzOther] = await store.insertItems([
    { ...item("dev", `Smoke ${run} rezone other author`), source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString(), session_id: sid }, author_id: claire.profile.id },
  ])
  const rzDry = await call(rezoneRoute.POST, "/api/items/rezone", { method: "POST", session: hugoSession, body: { moves: [{ session_id: sid, zone: "product" }, { session_id: "x", zone: "nope" }], dry_run: true } })
  assert(rzDry.status === 200 && rzDry.data.moved === 2 && rzDry.data.zones.product === 2 && rzDry.data.unknown_zones[0] === "nope", `dry run: 2 chunks of the session found, unknown zone reported (${JSON.stringify(rzDry.data)})`)
  assert((await store.getItem(rzA.id))?.zone === "dev", "dry run: nothing moved")
  const rz = await call(rezoneRoute.POST, "/api/items/rezone", { method: "POST", session: hugoSession, body: { moves: [{ session_id: sid, zone: "product" }] } })
  assert(rz.status === 200 && rz.data.moved === 2 && (await store.getItem(rzA.id))?.zone === "product" && (await store.getItem(rzB.id))?.zone === "product", "the author's knowledge from the session moved, every chunk")
  assert((await store.getItem(rzOther.id))?.zone === "dev", "another author's knowledge from a session with the same id does not move")
  const rzAgain = await call(rezoneRoute.POST, "/api/items/rezone", { method: "POST", session: hugoSession, body: { moves: [{ session_id: sid, zone: "product" }] } })
  assert(rzAgain.data.moved === 0 && rzAgain.data.already === 2, "run again: already in place")
  for (const it of [rzA, rzB, rzOther]) await store.deleteItem(it.id)

  console.log("\n— API: rezone by content, then deleting the emptied zone")
  const side = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { name: `Side ${run}` } })
  const legal = await call(adminZonesRoute.POST, "/api/admin/zones", {
    method: "POST",
    session: claireSession,
    body: { name: `Legal ${run}`, keywords: ["prefecture", "visa", "residence", "permit"] },
  })
  assert(side.status === 201 && legal.status === 201, "two zones created (a project zone, and Legal with its keywords)")
  const [sideId, legalId] = [side.data.id as string, legal.data.id as string]
  const keptSession = `smoke-${run}-project`
  const [paper, code, pinned] = await store.insertItems([
    { ...item(sideId, `Smoke ${run} residence permit: prefecture appointment, visa renewal`), author_id: hugo.profile.id },
    { ...item(sideId, `Smoke ${run} fix the build`), author_id: hugo.profile.id },
    { ...item(sideId, `Smoke ${run} visa and residence permit checklist`), source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString(), session_id: `${keptSession}#0` }, author_id: hugo.profile.id },
  ])
  const content = { by: "content", from: [sideId], to: [legalId, "nope"], keep_sessions: [keptSession] }
  const crDry = await call(rezoneRoute.POST, "/api/items/rezone", { method: "POST", session: hugoSession, body: { ...content, dry_run: true } })
  assert(
    crDry.status === 200 && crDry.data.moved === 1 && crDry.data.zones[legalId] === 1 && crDry.data.scanned === 3 && crDry.data.kept === 1 && crDry.data.unknown_zones[0] === "nope",
    `dry run: the paperwork would go to Legal, the build stays, the project session is kept (${JSON.stringify(crDry.data)})`,
  )
  assert(crDry.data.samples[0]?.id === paper.id && (await store.getItem(paper.id))?.zone === sideId, "dry run: an example of the move, nothing moved")
  const cr = await call(rezoneRoute.POST, "/api/items/rezone", { method: "POST", session: hugoSession, body: content })
  assert(cr.data.moved === 1 && (await store.getItem(paper.id))?.zone === legalId && (await store.getItem(code.id))?.zone === sideId && (await store.getItem(pinned.id))?.zone === sideId, "moved by what it says")
  const delOf = (id: string, session = claireSession) => call(adminZonesRoute.DELETE, `/api/admin/zones?id=${encodeURIComponent(id)}`, { method: "DELETE", session })
  assert((await delOf(sideId, hugoSession)).status === 403, "deleting a zone: admins only (403)")
  assert((await delOf("core")).status === 400, "the core cannot be deleted (400)")
  assert((await delOf(`nope-${run}`)).status === 404, "unknown zone: 404")
  const busy = await delOf(sideId)
  assert(busy.status === 409 && busy.data.details?.items === 2 && /move them first/.test(busy.data.error), `a zone still holding knowledge is not deleted (409: "${busy.data.error}")`)
  await store.setZoneAccess(hugo.profile.id, [...(await store.listZoneAccess(hugo.profile.id)), { zone_id: sideId, can_write: true }])
  for (const it of [paper, code, pinned]) await store.deleteItem(it.id)
  const del = await delOf(sideId)
  assert(del.status === 200 && !(await store.listZones()).some((z) => z.id === sideId), "the emptied zone is deleted")
  assert(!(await store.listZoneAccess(hugo.profile.id)).some((a) => a.zone_id === sideId), "with its access rights")
  assert((await delOf(legalId)).status === 200, "and the other one")

  console.log("\n— API: MCP servers (catalog, manual OAuth client, secrets never sent back)")
  assert((await call(mcpConnectorsRoute.GET, "/api/connectors/mcp", { session: hugoSession })).status === 403, "MCP servers: admins only (403)")
  const mcpLinear = await call(mcpConnectorsRoute.POST, "/api/connectors/mcp", { method: "POST", session: claireSession, body: { catalog_id: "linear" } })
  assert(mcpLinear.status === 201 && mcpLinear.data?.status === "needs_auth" && mcpLinear.data?.auth === "dynamic", `Linear added from the catalog, to connect (${mcpLinear.status} ${mcpLinear.data?.status})`)
  assert((await call(mcpConnectorsRoute.POST, "/api/connectors/mcp", { method: "POST", session: claireSession, body: { catalog_id: "unknown" } })).status === 400, "entry outside the catalog: 400")
  const mcpGithub = await call(mcpConnectorRoute.PUT, "/api/connectors/mcp/github", { method: "PUT", session: claireSession, params: { id: "github" }, body: { client_id: `cid-${run}`, client_secret: "SECRET-SMOKE-MCP" } })
  assert(mcpGithub.status === 200 && mcpGithub.data?.has_client === true && mcpGithub.data?.auth === "manual", "GitHub: OAuth client declared by hand saved")
  const mcpList = await call(mcpConnectorsRoute.GET, "/api/connectors/mcp", { session: claireSession })
  assert(mcpList.status === 200 && ["linear", "github"].every((id) => mcpList.data.connectors.some((c: { id: string }) => c.id === id)), "list: Linear and GitHub")
  assert(!JSON.stringify(mcpList.data).includes("SECRET-SMOKE-MCP") && mcpList.data.redirect_uri.endsWith("/api/connectors/mcp/callback"), "list: secret never sent back, redirect URI provided")
  const mcpTest = await call(mcpConnectorTestRoute.POST, "/api/connectors/mcp/linear/test", { method: "POST", session: claireSession, params: { id: "linear" } })
  assert(mcpTest.status === 200 && mcpTest.data?.last_check?.ok === false && mcpTest.data?.status === "needs_auth", "test without a connection: failure noted, no network call")
  assert((await call(mcpConnectorRoute.PUT, "/api/connectors/mcp/linear", { method: "PUT", session: claireSession, params: { id: "linear" }, body: { agents: "everything" } })).status === 400, "unknown agents rule: 400")
  assert((await call(mcpConnectorRoute.PUT, "/api/connectors/mcp/linear", { method: "PUT", session: claireSession, params: { id: "linear" }, body: { zones: ["finance", "unknown-zone"] } })).status === 400, "unknown cortex: 400")
  const mcpPolicy = await call(mcpConnectorRoute.PUT, "/api/connectors/mcp/linear", { method: "PUT", session: claireSession, params: { id: "linear" }, body: { agents: "all", import_enabled: true } })
  assert(mcpPolicy.status === 200 && mcpPolicy.data?.agents === "all" && mcpPolicy.data?.import_enabled === true, "agents rule and import saved")
  const mcpImport = await call(mcpImportRoute.POST, "/api/connectors/mcp/linear/import", { method: "POST", session: claireSession, params: { id: "linear" } })
  assert(mcpImport.status === 200 && mcpImport.data?.ok === false && /Not connected yet/.test(mcpImport.data?.error ?? ""), "import without a connection: failure noted, no call")
  const hugoTools = await call(connectedToolsRoute.GET, "/api/connected-tools", { session: hugoSession })
  assert(hugoTools.status === 200 && hugoTools.data.connectors.length === 0, "connector tools: a connector not connected yet is not offered to agents")
  const hugoCall = await call(connectedCallRoute.POST, "/api/connected-tools/call", { method: "POST", session: hugoSession, body: { connector: "linear", tool: "list_issues" } })
  assert(hugoCall.status === 404, "calling a tool of a connector not shared: 404")
  assert((await call(connectedCallRoute.POST, "/api/connected-tools/call", { method: "POST", session: hugoSession, body: { tool: "x" } })).status === 400, "malformed call: 400")
  const cb = await mcpCallbackRoute.GET(new Request("http://smoke.test/api/connectors/mcp/callback?state=unknown&code=x", { headers: { cookie: `brain_session=${claireSession}` } }))
  assert(cb.status === 303 && /\/connectors\?mcp=error/.test(cb.headers.get("location") ?? ""), "OAuth return with an unknown state: back to /connectors with the error")
  const cbAnon = await mcpCallbackRoute.GET(new Request("http://smoke.test/api/connectors/mcp/callback?state=x&code=x"))
  assert(cbAnon.status === 303 && /\/login$/.test(cbAnon.headers.get("location") ?? ""), "OAuth return without a session: to the sign-in")
  for (const id of ["linear", "github"]) await call(mcpConnectorRoute.DELETE, `/api/connectors/mcp/${id}`, { method: "DELETE", session: claireSession, params: { id } })
  assert((await call(mcpConnectorsRoute.GET, "/api/connectors/mcp", { session: claireSession })).data.connectors.length === mcpList.data.connectors.length - 2, "removal: both servers are gone")

  console.log("\n— MCP connectors: allowed cortexes (all by default)")
  {
    // A connected server and its tools already cached: no network call.
    const [savedConnectors, savedTools] = await Promise.all([store.getOrgSetting("mcp_connectors"), store.getOrgSetting("mcp_tools")])
    const id = `smoke-${run}`
    const now = new Date().toISOString()
    const others = JSON.parse(savedConnectors ?? "{}")
    await store.setOrgSetting("mcp_connectors", JSON.stringify({ ...others, [id]: { id, name: `Smoke ${run}`, url: "https://mcp.smoke.test/mcp", auth: "token", token: "SECRET-SMOKE-TOKEN", enabled: true, added_at: now } }))
    await store.setOrgSetting("mcp_tools", JSON.stringify({ ...JSON.parse(savedTools ?? "{}"), [id]: { at: now, tools: [{ name: "search", input_schema: { type: "object" }, read_only: true }] } }))
    try {
      const sees = async (who: string) => ((await call(connectedToolsRoute.GET, "/api/connected-tools", { session: who })).data.connectors as { id: string }[]).some((c) => c.id === id)
      assert(!hugo.access.readable.includes("finance"), "Hugo does not read finance")
      const open = (await call(mcpConnectorsRoute.GET, "/api/connectors/mcp", { session: claireSession })).data.connectors.find((c: { id: string }) => c.id === id)
      assert(open?.zones?.length === 0 && (await sees(hugoSession)) && (await sees(jmSession)), "by default, every cortex: Hugo and Jean-Marc see its tools")
      const only = await call(mcpConnectorRoute.PUT, `/api/connectors/mcp/${id}`, { method: "PUT", session: claireSession, params: { id }, body: { zones: ["finance", "finance"] } })
      assert(only.status === 200 && only.data?.zones?.join() === "finance", "allowed to the finance cortex only")
      assert((await sees(jmSession)) && !(await sees(hugoSession)), "Jean-Marc (finance) still sees it, Hugo no longer does")
      const denied = await call(connectedCallRoute.POST, "/api/connected-tools/call", { method: "POST", session: hugoSession, body: { connector: id, tool: "search" } })
      assert(denied.status === 404, "Hugo cannot call its tools: 404")
      const reopened = await call(mcpConnectorRoute.PUT, `/api/connectors/mcp/${id}`, { method: "PUT", session: claireSession, params: { id }, body: { zones: [] } })
      assert(reopened.status === 200 && reopened.data?.zones?.length === 0 && (await sees(hugoSession)), "back to every cortex: Hugo sees it again")
    } finally {
      await Promise.all([store.setOrgSetting("mcp_connectors", savedConnectors), store.setOrgSetting("mcp_tools", savedTools)])
    }
  }

  console.log("\n— Company status produced on a workstation (E4)")
  const originalStatus = await store.getStatus()
  try {
    const denied = await call(statusInputRoute.GET, "/api/status/input", { session: hugoSession })
    assert(denied.status === 403 && denied.data?.error, "GET /api/status/input: admins only (403)")
    const inputRes = await call(statusInputRoute.GET, "/api/status/input", { session: claireSession })
    const si = inputRes.data as StatusInput
    assert(inputRes.status === 200 && si.company_name === (await store.getOrg()).name && /^\d{4}-\d{2}-\d{2}$/.test(si.generated_for), `summary material: ${si.company_name}, ${si.generated_for}`)
    assert(si.zones.length === zones.length && si.zones.every((z) => z.id && z.name && typeof z.description === "string"), "every zone (id, name, description)")
    const oldest = Date.now() - 30 * 86400_000 - 60_000
    assert(si.items.length > 0 && si.items.length <= 400 && si.items.every((i) => Date.parse(i.created_at) >= oldest), `knowledge from the last 30 days, 400 at most (${si.items.length})`)
    assert(si.items.every((i, k) => k === 0 || si.items[k - 1].created_at >= i.created_at), "most recent first")
    const names = new Set((await store.listProfiles()).map((p) => p.name))
    assert(si.items.every((i) => names.has(i.author)) && !JSON.stringify(si).includes(hugo.profile.id), "author = the member's name (no id)")
    assert(si.tasks.length > 0 && si.tasks.some((t) => t.assignee) && si.tasks.every((t) => (t.status === "open" || t.status === "done") && (!t.assignee || names.has(t.assignee))), "tasks with the assignee's name")

    const pushedStatus = {
      headline: `Smoke ${run}: the company is moving forward, details at claire.personal@gmail.com`,
      zones: [
        { zone: "dev", summary: "Release ready, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", objectives: ["Hold the release date"], progress: "80%", next_steps: ["Review the PR"], who_did_what: [{ person: "Hugo Bernard", did: "migrated Postgres" }] },
        { zone: "finance", summary: "Treasury: 2 months of cash", objectives: [], progress: "", next_steps: [], who_did_what: [] },
        { zone: "unknown", summary: "made-up zone", objectives: [], progress: "", next_steps: [], who_did_what: [] },
        { zone: "dev", summary: "duplicate", objectives: [], progress: "", next_steps: [], who_did_what: [] },
      ],
    }
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: hugoSession, body: { status: pushedStatus } })).status === 403, "POST /api/status with a summary: admins only (403)")
    const evBefore = (await store.listEvents({ limit: 1 }))[0]?.id ?? 0
    const pushed = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: pushedStatus } })
    const saved = pushed.data as CompanyStatus
    assert(pushed.status === 200 && saved.generator === "claude" && Math.abs(Date.parse(saved.generated_at) - Date.now()) < 60_000, "workstation summary saved (generated by Claude, now)")
    assert(saved.zones.map((z) => z.zone).join() === "dev,finance", "unknown zones and duplicates dropped")
    assert(!/sk-ant|claire\.personal/.test(JSON.stringify(saved)) && saved.headline.includes("redacted"), "text redacted on the server")
    assert(isDeepStrictEqual(await store.getStatus(), saved), "the stored state is what gets returned")
    const statusEvent = (await store.listEvents({ afterId: evBefore, limit: 50 })).find((e) => e.agent === "job" && e.summary === "Updating the state of the company")
    assert(statusEvent && statusEvent.zones.length === zones.length && statusEvent.user_id === claire.profile.id, "the same \"Updating the state of the company\" event is emitted")
    const jmPushed = await statusForViewer(jm)
    assert(
      jmPushed?.zones.map((z) => z.zone).filter((z) => z !== "core").join() === "finance" && jmPushed.headline !== saved.headline,
      "Jean-Marc only receives finance (and the core), with his own headline (D4)",
    )
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, raw: "{not json" })).status === 400, "unreadable body: 400")
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: { headline: "x", zones: "dev" } } })).status === 400, "malformed summary: 400")
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { headline: "Summary without an envelope", zones: [{ zone: "dev" }] } })).status === 400, "summary without { status }: 400, no recompute that would overwrite it")
    const unknownOnly = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: { headline: "x", zones: [{ zone: "unknown" }] } } })
    assert(unknownOnly.status === 400 && /no zone/.test(unknownOnly.data?.error ?? ""), "no known zone: 400")
    assert(isDeepStrictEqual(await store.getStatus(), saved), "a refused summary does not replace the state")
    // Full workstation chain: prompt (core) → answer of `claude -p --output-format json` → parseStatusJson → POST.
    const prompt = buildCliStatusPrompt(si)
    assert(prompt.startsWith(DISTILL_MARKER) && prompt.includes(si.company_name) && si.zones.every((z) => prompt.includes(z.id)), "workstation prompt: anti-ingestion marker and the server's material")
    const answer = JSON.stringify({
      headline: `Smoke ${run} via the workstation`,
      zones: [
        { zone: "dev", summary: "Prod ready", objectives: ["Ship"], progress: "80%", next_steps: ["PR"], who_did_what: [{ person: "Hugo Bernard", did: "migration" }] },
        { zone: "zz", summary: "x", objectives: [], progress: "", next_steps: [], who_did_what: [] },
      ],
    })
    const envelope = JSON.stringify({ type: "result", is_error: false, result: `Here is the status:\n\`\`\`json\n${answer}\n\`\`\`` })
    const parsedReply = parseStatusJson(envelope, si.zones.map((z) => z.id))
    const viaCli = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: parsedReply } })
    assert(
      parsedReply && viaCli.status === 200 && viaCli.data.headline === `Smoke ${run} via the workstation` && viaCli.data.zones.map((z: { zone: string }) => z.zone).join() === "dev",
      "Claude's answer read by the core (parseStatusJson) then accepted by POST /api/status",
    )
    const regen = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession })
    assert(regen.status === 200 && regen.data.zones.length >= 1 && regen.data.generated_at !== saved.generated_at, `without a body: server-side regeneration as before (${regen.data.generator})`)
  } finally {
    if (originalStatus) await store.setStatus(originalStatus)
  }

  console.log("\n— Dashboard sessions (D5)")
  const savedSecret = process.env.BRAIN_SESSION_SECRET
  delete process.env.BRAIN_SESSION_SECRET
  try {
    const secret = await store.getSessionSecret()
    assert(/^[0-9a-f]{64}$/.test(secret), "random 32-byte session secret")
    if (store.kind === "file") {
      const dataDir = path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain")
      assert(((await new FileStore(dataDir).getSessionSecret()) === secret), "the secret is kept on disk (reread by another instance)")
      assert((fs.statSync(path.join(dataDir, "session-secret")).mode & 0o777) === 0o600, "session-secret file in mode 600")
    } else {
      const other = new PostgresStore(process.env.DATABASE_URL!)
      assert((await other.getSessionSecret()) === secret, "the secret is kept in the database (brain_settings, reread by another instance)")
      await other.end()
    }
    const legacy = createHash("sha256")
      .update(`company-brain:${process.env.DATABASE_URL ?? ""}:${process.env.BRAIN_DATA_DIR ?? ".brain"}:${process.cwd()}`)
      .digest("hex")
    const exp = String(Date.now() + 3600_000)
    const forged = `${claire.profile.id}.${exp}.${createHmac("sha256", legacy).update(`${claire.profile.id}.${exp}`).digest("base64url")}`
    assert(!(await viewerFromCookies(forged, undefined)), "an admin cookie forged with the old guessable secret is refused")
    const cookie = await createSessionValue(hugo.profile.id)
    assert((await viewerFromCookies(cookie, undefined))?.real.id === hugo.profile.id, "a signed session is accepted")
    const code = await createLoginCode(hugo.profile.id)
    assert((await verifyLoginCode(code)) === hugo.profile.id, "a signed sign-in (setup) link is accepted")
    assert(!(await viewerFromCookies(code, undefined)), "a sign-in link is not a session cookie")
    assert(!(await verifyLoginCode(cookie)), "a session cookie is not a sign-in link")
    const [codeUser, , codeSig] = code.split(".")
    assert(!(await verifyLoginCode(`${codeUser}.${Date.now() + 86400_000}.${codeSig}`)), "a link whose expiry is pushed back is refused")
    assert(!(await viewerFromCookies(`${cookie.slice(0, -3)}${cookie.endsWith("AAA") ? "BBB" : "AAA"}`, undefined)), "a modified signature is refused")
    assert((await viewerFromCookies(cookie, jm.profile.id))?.profile.id === hugo.profile.id, "a member cannot \"view as\"")
    const claireCookie = await createSessionValue(claire.profile.id)
    assert((await viewerFromCookies(claireCookie, jm.profile.id))?.profile.id === jm.profile.id, "an admin can \"view as\"")
    const original = await store.getTokenHash(hugo.profile.id)
    await store.updateProfile(hugo.profile.id, { token_hash: hashToken(newToken()) })
    try {
      assert(!(await viewerFromCookies(cookie, undefined)), "regenerating the token invalidates existing sessions")
    } finally {
      await store.updateProfile(hugo.profile.id, { token_hash: original! })
    }
    assert((await viewerFromCookies(cookie, undefined))?.real.id === hugo.profile.id, "token restored: the session is valid again")

    // Connector key (Claude → Connectors): derived from the token, shown again at will, revoked with it.
    const key = await createConnectorKey(hugo.profile.id)
    assert(key.startsWith("cb_mcp_") && key === (await createConnectorKey(hugo.profile.id)), "a connector key is stable (shown again identical)")
    assert((await profileFromToken(key))?.id === hugo.profile.id, "a connector key is accepted like the token")
    assert(!redactText(`url /api/mcp/x/${key}`).includes(key), "a connector key is redacted like a token")
    const [keyUser, keySig] = Buffer.from(key.slice(7), "base64url").toString("utf8").split(".")
    const forgedKey = `cb_mcp_${Buffer.from(`${claire.profile.id}.${keySig}`).toString("base64url")}`
    assert(!(await profileFromToken(forgedKey)) && keyUser === hugo.profile.id, "a connector key moved to another member is refused")
    await store.updateProfile(hugo.profile.id, { token_hash: hashToken(newToken()) })
    try {
      assert(!(await profileFromToken(key)), "regenerating the token revokes the connector key")
    } finally {
      await store.updateProfile(hugo.profile.id, { token_hash: original! })
    }
    const own = await call(connectorRoute.GET as Handler, "/api/connector", { session: cookie })
    assert(own.status === 200 && own.data.url.endsWith(encodeURIComponent(key)), "a member gets their own connector address")
    const others = await call(connectorRoute.GET as Handler, `/api/connector?user=${claire.profile.id}`, { session: cookie })
    assert(others.status === 403, "a member cannot get someone else's connector address")
    const byAdmin = await call(connectorRoute.GET as Handler, `/api/connector?user=${hugo.profile.id}`, { session: claireCookie })
    assert(byAdmin.status === 200 && byAdmin.data.url === own.data.url, "an admin gets a member's connector address")
    process.env.BRAIN_SESSION_SECRET = `smoke-${run}-${"x".repeat(40)}`
    assert(!(await viewerFromCookies(cookie, undefined)), "BRAIN_SESSION_SECRET takes precedence over the stored secret")
    assert((await viewerFromCookies(await createSessionValue(hugo.profile.id), undefined))?.real.id === hugo.profile.id, "and signs new sessions")
  } finally {
    if (savedSecret === undefined) delete process.env.BRAIN_SESSION_SECRET
    else process.env.BRAIN_SESSION_SECRET = savedSecret
  }

  console.log("\n— Search: prefix only for long words")
  const allZones = zones.map((z) => z.id)
  const pr = await store.searchItems("pr", allZones, 20)
  assert(pr.every((i) => tokenize(`${i.title} ${i.body} ${i.entities.map((e) => e.name).join(" ")}`).includes("pr")), `"pr" only finds the exact word (${pr.length} result(s))`)
  assert((await store.searchItems("deplo", allZones, 5)).length > 0, "\"deplo\" finds \"deploy\" (prefix ≥ 4 letters)")

  console.log("\n— Live stream")
  const latest = (await store.listEvents({ limit: 1 }))[0]?.id ?? 0
  assert((await streamStartId(latest + 100_000)) === latest, "?after= past the last event (brain reset): restarts from the last one")
  assert((await streamStartId(null)) === latest && (await streamStartId(Math.max(0, latest - 3))) === Math.max(0, latest - 3), "valid ?after= respected")
  assert((await streamStartId(0)) >= latest - 200, "bounded catch-up for a ?after= that is too old")
  const poller = createEventPoller(latest)
  const [ev1] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} stream` }])
  const got = await poller.poll()
  assert(got.some((e) => e.id === ev1.id) && !(await poller.poll()).some((e) => e.id === ev1.id), "the stream delivers each event only once")
  if (store.kind === "postgres") {
    const url = process.env.DATABASE_URL!
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
    const sql = postgres(url, { prepare: false, max: 2, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
    const org = await store.getOrg()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let slowId = 0
    const slow = sql.begin(async (tx) => {
      const [r] = await tx`insert into agent_events (org_id, user_id, agent, type, zones, summary, at)
        values (${org.id}, ${hugo.profile.id}, 'mcp', 'query', ${tx.array(["dev"])}, ${`Smoke ${run} slow`}, now()) returning id`
      slowId = Number(r.id)
      await held
    })
    while (!slowId) await sleep(10)
    const [fast] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} fast` }])
    const first = await poller.poll()
    assert(fast.id > slowId && first.some((e) => e.id === fast.id) && !first.some((e) => e.id === slowId), "Postgres: a larger id is committed before a smaller id")
    release()
    await slow
    const second = await poller.poll()
    assert(second.some((e) => e.id === slowId), "the event committed late is still delivered")
    assert(!(await poller.poll()).some((e) => e.id === slowId || e.id === fast.id), "without duplicates")
    await sql.end({ timeout: 5 })

    console.log("\n— Health probe: migrations applied compared with those shipped with the code")
    {
      const files = fs.readdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()
      const saved = process.env.BRAIN_EXPECTED_MIGRATION
      process.env.BRAIN_EXPECTED_MIGRATION = files.at(-1)
      try {
        const h = (await (await healthRoute.GET()).json()) as { migrations?: { applied: number; last: string | null; expected: string | null; up_to_date: boolean | null } }
        assert(h.migrations?.up_to_date === true && h.migrations.last === files.at(-1) && h.migrations.applied >= files.length, `database up to date: ${JSON.stringify(h.migrations)}`)
        process.env.BRAIN_EXPECTED_MIGRATION = "99999999999999_future.sql"
        const late = (await (await healthRoute.GET()).json()) as { ok: boolean; migrations?: { up_to_date: boolean | null } }
        assert(late.ok && late.migrations?.up_to_date === false, "a migration shipped but not applied: reported, without failing the probe")
      } finally {
        if (saved === undefined) delete process.env.BRAIN_EXPECTED_MIGRATION
        else process.env.BRAIN_EXPECTED_MIGRATION = saved
      }
    }

    console.log("\n— Postgres: organization reread (reseed, onboarding on another instance)")
    const other = new PostgresStore(url)
    const orgBefore = await store.getOrg()
    await other.updateOrg({ name: `${orgBefore.name} (smoke)` })
    await sleep(5200)
    const seen = (await store.getOrg()).name
    await other.updateOrg({ name: orgBefore.name })
    await other.end()
    assert(seen === `${orgBefore.name} (smoke)`, "an instance sees the organization change made elsewhere, without restarting")

    console.log("\n— Postgres: brain_settings table missing (migration not applied)")
    const g = globalThis as unknown as { __brainStore?: BrainStore }
    const current = g.__brainStore
    const savedEnvSecret = process.env.BRAIN_SESSION_SECRET
    const savedDemo = process.env.BRAIN_DEMO
    delete process.env.BRAIN_SESSION_SECRET
    const oldCookie = await createSessionValue(hugo.profile.id)
    const ddl = pgClient(url, 1)
    const blank = new PostgresStore(url)
    await ddl`alter table brain_settings rename to brain_settings_smoke`
    g.__brainStore = blank
    try {
      assert((await viewerFromCookies(oldCookie, undefined)) === null, "unverifiable session: refused without crashing (back to sign-in)")
      assert((await call(stateRoute.GET, "/api/state", { session: oldCookie })).status === 401, "dashboard route: 401, not 500")
      let setupErr: unknown
      await createSessionValue(hugo.profile.id).catch((err) => (setupErr = err))
      assert(isStoreSetupError(setupErr) && setupErr.status === 503 && /db:migrate/.test(setupErr.message), "sign-in: clear configuration error")
      process.env.BRAIN_DEMO = "1"
      const login = await call(demoSessionRoute.POST, "/api/session/demo", { method: "POST", body: { userId: hugo.profile.id } })
      assert(login.status === 503 && /migrations/.test(login.data?.error ?? ""), `POST /api/session/demo: 503 ("${login.data?.error}")`)
    } finally {
      g.__brainStore = current
      await blank.end()
      await ddl`alter table brain_settings_smoke rename to brain_settings`
      await ddl.end({ timeout: 5 })
      if (savedEnvSecret === undefined) delete process.env.BRAIN_SESSION_SECRET
      else process.env.BRAIN_SESSION_SECRET = savedEnvSecret
      if (savedDemo === undefined) delete process.env.BRAIN_DEMO
      else process.env.BRAIN_DEMO = savedDemo
    }
    assert((await viewerFromCookies(oldCookie, undefined))?.real.id === hugo.profile.id, "table restored: the session is valid again")

    console.log("\n— Postgres: \"quality\" migration missing, ingesting a revised decision does not crash")
    {
      const ddlQ = pgClient(url, 1)
      const legacy = new PostgresStore(url)
      const gq = globalThis as unknown as { __brainStore?: BrainStore }
      const currentQ = gq.__brainStore
      const qtagM = `Smoke ${run} without migration`
      const dec = (body: string, at: number): KnowledgeItemInput => ({
        zone: "dev",
        kind: "decision",
        title: `${qtagM}: accounting exports go through an encrypted S3 bucket`,
        body,
        entities: [],
        source: { app: "Terminal", tool: "claude-code", at: new Date(at).toISOString() },
        confidence: 0.8,
      })
      await ddlQ`alter table knowledge_items rename column superseded_by to superseded_by_smoke`
      gq.__brainStore = legacy
      let ids: string[] = []
      try {
        const a = await ingestItems(hugo, [dec(`The exports go to an encrypted S3 bucket (${run}).`, Date.now() - 60_000)])
        const b = await ingestItems(hugo, [dec(`In the end the exports stay on the file server, the S3 bucket is dropped (${run}).`, Date.now() + 5_000)])
        ids = [...a.ids, ...b.ids]
        assert(a.inserted === 1 && b.inserted === 1 && b.replaced === 0, "revised decision inserted, nothing marked, no error (no 503 for the workstation)")
      } finally {
        gq.__brainStore = currentQ
        await legacy.end()
        await ddlQ`alter table knowledge_items rename column superseded_by_smoke to superseded_by`
        await ddlQ.end({ timeout: 5 })
      }
      for (const id of ids) await store.deleteItem(id)
    }

    console.log("\n— Postgres: atomic reset, never a stray organization (E3)")
    await orgRaceTest(url, run)
  }

  if (store.kind === "file") {
    console.log("\n— File storage: several processes write at the same time")
    const src = path.join(path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain"), "brain.json")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smoke-"))
    try {
      fs.copyFileSync(src, path.join(tmp, "brain.json"))
      const copy = new FileStore(tmp)
      const eventsBefore = (await copy.listEvents({ sinceIso: "1970-01-01", limit: 100_000 })).length
      const itemsBefore = (await copy.listItems({ limit: 100_000 })).length
      const n = 60
      const self = fileURLToPath(import.meta.url)
      await Promise.all(
        ["A", "B", "C"].map(
          (tag) =>
            new Promise<void>((resolve, reject) => {
              const child = fork(self, ["--writer", tmp, `${run}-${tag}`, String(n)], { execArgv: process.execArgv })
              child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag}: code ${code}`))))
            }),
        ),
      )
      const all = await copy.listEvents({ sinceIso: "1970-01-01", limit: 100_000 })
      assert(all.length === eventsBefore + 3 * n, `no write lost (${all.length - eventsBefore}/${3 * n} events)`)
      assert(new Set(all.map((e) => e.id)).size === all.length, "no event id reused")
      assert((await copy.listItems({ limit: 100_000 })).length === itemsBefore + 3 * Math.ceil(n / 10), "no item lost")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log("\n— Create your company (/create): a separate brain")
  {
    const root = getRootStore()
    const encore = await root.getOrg()
    const tenantsBefore = await root.countTenantOrgs()
    const acme = await root.createTenantOrg({
      name: `Acme ${run}`,
      description: "Smoke test",
      zones: [{ id: "ops", name: "Ops", description: "", color: "#2a78d6", keywords: ["ops", "oncall"], position: 0 }],
    })
    const acmeStore = storeForOrg(acme.id)
    try {
      assert((await root.countTenantOrgs()) === tenantsBefore + 1, "a created company is counted")
      assert((await root.getOrg()).id === encore.id && !(await root.isEmpty()), "the database's brain stays Encore's")
      assert((await acmeStore.listZones()).map((z) => z.id).join() === "ops,core", "the new company only has its own zones, around its core")
      const token = newToken()
      const boss = await acmeStore.createProfile({ name: `Alice ${run}`, role: "admin", manager_id: null, token_hash: hashToken(token) })
      assert(boss.org_id === acme.id, "its first account belongs to it")
      assert((await profileFromToken(token))?.id === boss.id, "its token is recognized (workstation connection)")
      const cookie = await createSessionValue(boss.id)
      const alice = await viewerFromCookies(cookie, claire.profile.id)
      assert(alice?.real.id === boss.id && alice.profile.id === boss.id, "its session is recognized; \"view as\" does not leave its company")
      assert(!(await store.listProfiles()).some((p) => p.id === boss.id), "Encore does not see this account")

      const st = await call(stateRoute.GET, "/api/state", { session: cookie })
      assert(st.status === 200 && st.data.zones.map((z: { id: string }) => z.id).join() === "ops,core" && st.data.items.length === 0, "its dashboard only shows its company")

      console.log("\n— The company's MCP server (/api/mcp/<company>/<token>): what Claude Code and Codex plug in")
      const rpc = async (orgId: string, tok: string, body: unknown, method = "POST") => {
        const res = await mcpRoute.POST(
          new Request(`http://smoke.test/api/mcp/${orgId}/${tok}`, {
            method,
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
            body: method === "POST" ? JSON.stringify(body) : undefined,
          }),
          { params: Promise.resolve({ orgId, token: tok }) },
        )
        return { status: res.status, data: (await res.json().catch(() => null)) as any }
      }
      const hello = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }
      const mcpInit = await rpc(acme.id, token, hello)
      assert(
        mcpInit.status === 200 && mcpInit.data.result.instructions.includes(`Acme ${run}`) && mcpInit.data.result.instructions.includes("company brain: Smoke test") && mcpInit.data.result.instructions.includes(`Alice ${run}`),
        "MCP: handshake, instruction with the company's name and description, for this person",
      )
      const mcpTools = await rpc(acme.id, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
      assert(
        mcpTools.data.result.tools.map((t: { name: string }) => t.name).join() ===
          "search_brain,get_knowledge,explore_entity,get_document,get_zone_summary,list_zones,whoami_context,company_status,remember,connected_tools,use_connected_tool,show_brain,brain_activity,show_automations,set_automation_status,show_team",
        "MCP: the brain's tools (connector tools and MCP Apps included), without a company parameter (one company per server)",
      )
      assert(!JSON.stringify(mcpTools.data).includes('"company"'), "MCP: no company parameter")
      const mcpZones = await rpc(acme.id, token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_zones", arguments: {} } })
      assert(mcpZones.data.result.content[0].text.includes("**Ops** (`ops`)"), "MCP: a tool answers, with the company's zones")
      const mcpConnected = await rpc(acme.id, token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "connected_tools", arguments: {} } })
      assert(/No connector is open to agents/.test(mcpConnected.data.result.content[0].text), "MCP: connected_tools says so when no connector is connected")
      const mcpUse = await rpc(acme.id, token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "use_connected_tool", arguments: { connector: "linear", tool: "list_issues" } } })
      assert(mcpUse.data.result.isError === true && /not found or not shared/.test(mcpUse.data.result.content[0].text), "MCP: use_connected_tool on a missing connector: clear error")
      assert((await rpc(encore.id, token, hello)).status === 401, "MCP: one company's token does not open another's server")
      assert((await rpc(acme.id, newToken(), hello)).status === 401, "MCP: unknown token refused")
      assert((await rpc(acme.id, token, null, "GET")).status === 405, "MCP: GET refused (stateless server)")

      console.log("\n— Companies remembered by the browser: go back to one, switch from one to another")
      const encoreSession = await createSessionValue(claire.profile.id)
      const both = await rememberAccounts(cookie, encoreSession)
      const listed = await listRememberedAccounts(both)
      assert(
        listed.map((a) => a.org.id).join() === `${acme.id},${encore.id}` && listed[0].org.name === `Acme ${run}` && listed[0].org.description === "Smoke test",
        "two companies remembered, the most recent first, with their name and description",
      )
      const sameOrg = await listRememberedAccounts(await rememberAccounts(await createSessionValue(hugo.profile.id), both))
      assert(
        sameOrg.length === 2 && sameOrg[0].userId === hugo.profile.id && !sameOrg.some((a) => a.userId === claire.profile.id),
        "another account of the same company replaces the previous one (one line per company)",
      )
      assert((await isRemembered(both, boss.id)) && !(await isRemembered(both, hugo.profile.id)), "only remembered accounts reopen without a token")
      const stretched = `${boss.id}.${Date.now() + 86400_000}.${cookie.split(".")[2]}`
      assert(
        (await listRememberedAccounts(`${stretched}~not-a-session~${encoreSession}`)).map((a) => a.userId).join() === claire.profile.id,
        "a tampered or unreadable remembered session is dropped",
      )
      assert((await listRememberedAccounts(await forgetAccount(both, boss.id))).map((a) => a.org.id).join() === encore.id, "forgetting a company removes it from the list")
      const [entry] = both.split("~")
      assert(!(await viewerFromCookies(entry, undefined)), "a remembered company is not a session cookie (separate use)")
      assert(Number(entry.split(".")[1]) > Date.now() + 300 * 86400_000, "a remembered company lasts a year, not a session's 14 days")
      assert((await latestRemembered(both)) === boss.id, "automatic sign-in: the most recent remembered company")
      assert((await rememberAccounts(both)) === both, "an entry still valid is kept as is")
      const bossHash = await acmeStore.getTokenHash(boss.id)
      await acmeStore.updateProfile(boss.id, { token_hash: hashToken(newToken()) })
      try {
        assert((await latestRemembered(both)) === claire.profile.id, "regenerating the token also invalidates the remembered company")
      } finally {
        await acmeStore.updateProfile(boss.id, { token_hash: bossHash! })
      }
      const inv = await call(adminUsersRoute.POST, "/api/admin/users", { method: "POST", session: cookie, body: { name: `Bob ${run}`, zones: ["ops", "dev"] } })
      assert(inv.status === 201 && inv.data.prompt.includes(`Acme ${run}`) && inv.data.prompt.includes(" ops."), "inviting a colleague: prompt in its name, company zones only")
      assert((await acmeStore.listProfiles()).length === 2 && !(await store.listProfiles()).some((p) => p.id === inv.data.profile.id), "the colleague joins the company, not Encore")

      const bob = (await profileFromToken(inv.data.token))!
      const bobViewer: Viewer = { profile: bob, real: bob, access: await getAccess(bob) }
      const team0 = await call(adminTeamRoute.GET, "/api/admin/team", { session: cookie })
      assert(team0.status === 200 && team0.data.users.every((u: { last_at: string | null }) => u.last_at === null), "team: nobody is connected yet")
      await runInOrg(acme.id, () => recordEvents(bobViewer, [{ agent: "claude-code", type: "started" }]))
      const team1 = await call(adminTeamRoute.GET, "/api/admin/team", { session: cookie })
      assert(team1.data.users.find((u: { id: string }) => u.id === bob.id)?.last_at, "team: Bob's workstation shows as connected")

      const ing = await runInOrg(acme.id, () => ingestItems(bobViewer, [item("ops", `Oncall procedure for Acme (${run})`)]))
      assert((await acmeStore.getItem(ing.ids[0]))?.zone === "ops", "a knowledge item from Bob's workstation reaches the company")
      const fromEncore = await queryBrain(claire, { query: `oncall Acme ${run}` })
      assert(fromEncore.items.every((i) => i.org_id === encore.id), "Encore sees none of it")
      const fromAcme = await runInOrg(acme.id, () => queryBrain(alice!, { query: "deploy to production" }))
      assert(fromAcme.items.length === 0, "and the company sees nothing of Encore")
      const encoreItem = created[0]
      const del = await itemRoute.DELETE(new Request(`http://smoke.test/api/items/${encoreItem}`, { method: "DELETE", headers: { cookie: `brain_session=${cookie}` } }), {
        params: Promise.resolve({ id: encoreItem }),
      })
      assert(del.status === 404 && (await store.getItem(encoreItem)), "an Encore knowledge item cannot be found (and is intact) from the company")
      console.log("\n— Team message: ask to join, an admin accepts")
      const decide = (id: string, session: string, body: unknown) =>
        adminJoinIdRoute.POST(new Request(`http://smoke.test/api/admin/join/${id}`, { method: "POST", headers: { cookie: `brain_session=${session}`, "content-type": "application/json" }, body: JSON.stringify(body) }), {
          params: Promise.resolve({ id }),
        })
      const team = await call(adminJoinRoute.GET, "/api/admin/join", { session: cookie })
      assert(team.status === 200 && team.data.prompt.includes(team.data.code) && team.data.prompt.includes("You are going to ask to join NOS Brainer"), "one team message per company, with its code")
      assert((await call(adminJoinRoute.GET, "/api/admin/join", { session: cookie })).data.code === team.data.code, "the code stays the same from one opening to the next")
      const leaToken = newToken()
      const unknown = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: `cj_${"x".repeat(24)}`, token_hash: hashToken(leaToken) } })
      assert(unknown.status === 404, "an unknown code creates nothing")
      const asked = await call(joinRoute.POST, "/api/join", {
        method: "POST",
        body: { code: team.data.code, name: "Léa Test", title: "<title>", email: "not an email", hostname: "mac-lea", token_hash: hashToken(leaToken) },
      })
      assert(asked.status === 201 && asked.data.org === acme.name, "the request reaches the code's company")
      const [pending] = await acmeStore.listJoinRequests({ status: "pending" })
      assert(pending?.name === "Léa Test" && pending.title === null && pending.email === null && pending.hostname === "mac-lea", "what her Claude did not know stays empty (the \"<title>\" template included)")
      assert((await profileFromToken(leaToken)) === null, "no access before acceptance")
      const status0 = await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: leaToken } })
      assert(status0.status === 200 && status0.data.status === "pending", "the workstation follows its request: pending")
      assert((await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: newToken() } })).status === 404, "nobody else can follow the request")
      const encoreAdmin = await createSessionValue(claire.profile.id)
      assert((await call(adminJoinRoute.GET, "/api/admin/join", { session: encoreAdmin })).data.requests.every((r: { id: string }) => r.id !== asked.data.id), "Encore does not see the request")
      assert((await decide(asked.data.id, encoreAdmin, { action: "accept", name: "Intruder" })).status === 404, "nor can it accept it")
      const accepted = await decide(asked.data.id, cookie, { action: "accept", name: "Léa Bernard", title: "Designer", zones: ["ops"], manager_id: boss.id })
      assert(accepted.status === 200, "a company admin completes and accepts")
      const lea = await profileFromToken(leaToken)
      assert(lea?.name === "Léa Bernard" && lea.title === "Designer" && lea.org_id === acme.id && lea.manager_id === boss.id, "the workstation token opens her account, as the admin set it")
      assert((await acmeStore.listZoneAccess(lea!.id)).map((a) => a.zone_id).join() === "ops", "with the chosen zones")
      const status1 = await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: leaToken } })
      assert(status1.data.status === "accepted", "the workstation sees the acceptance (and moves on to setup)")
      assert((await decide(asked.data.id, cookie, { action: "reject" })).status === 409, "a request is handled only once")
      const noName = newToken()
      const anon = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: team.data.code, token_hash: hashToken(noName) } })
      assert((await decide(anon.data.id, cookie, { action: "reject" })).status === 200, "a request can be rejected")
      assert((await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: anon.data.id, token: noName } })).data.status === "rejected", "and the workstation knows it")
      const rotated = await call(adminJoinRoute.POST, "/api/admin/join", { method: "POST", session: cookie, body: { rotate: true } })
      assert(rotated.status === 200 && rotated.data.code !== team.data.code, "change the code")
      const stale = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: team.data.code, token_hash: hashToken(newToken()) } })
      assert(stale.status === 404, "the old message no longer works")

      console.log("\n— Onboarding prepared by Claude Code or Codex")
      const agent = await call(onboardingAgentRoute.POST, "/api/onboarding/agent", { method: "POST", session: cookie })
      const sendCode = agent.data.prompt.match(/Bearer (co_[A-Za-z0-9_-]+)/)?.[1] as string
      assert(agent.status === 200 && sendCode && agent.data.prompt.includes("~/.codex/sessions"), "onboarding prompt with an upload code")
      assert(agent.data.prompt.includes("/api/onboarding/tools"), "the prompt also explores the tools connected while it reads")
      assert(agent.data.prompt.length <= 5000, `prompt short enough for a claude-cli link (${agent.data.prompt.length} characters)`)
      const tools = (code: string) => onboardingToolsRoute.GET(new Request("http://smoke.test/api/onboarding/tools", { headers: { authorization: `Bearer ${code}` } }))
      assert((await tools(`co_${"A".repeat(40)}`)).status === 401, "connected tools: a made-up code is refused")
      const noTools = await tools(sendCode)
      const noToolsBody = (await noTools.json()) as { connectors: unknown[]; hint?: string }
      assert(noTools.status === 200 && noToolsBody.connectors.length === 0 && /No tool connected yet/.test(noToolsBody.hint ?? ""), "connected tools: none yet, the agent is told to check again later")
      const toolCall = (code: string, body: unknown) =>
        onboardingToolsCallRoute.POST(new Request("http://smoke.test/api/onboarding/tools/call", { method: "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
      assert((await toolCall(sendCode, { connector: "notion", tool: "search" })).status === 404, "tool call on a connector not connected: 404")
      assert((await toolCall(sendCode, { tool: "search" })).status === 400, "malformed tool call: 400")
      const upload = (code: string, body: unknown) =>
        onboardingImportRoute.POST(new Request("http://smoke.test/api/onboarding/import", { method: "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
      const proposal = {
        source: "codex",
        company_name: `Acme ${run}`,
        description: "Design studio. Contact: alice@acme.example",
        zones: [{ id: "ops", name: "Ops", description: "Operations", keywords: ["oncall"] }, { id: "design", name: "Design", description: "Mockups", keywords: ["figma"] }],
        items: [{ zone: "design", kind: "procedure", title: `Deliver a mockup (${run})`, body: "Figma export then review. Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", entities: [{ type: "tool", name: "Figma" }], source: { app: "onboarding", tool: "onboarding" }, confidence: 0.8 }],
      }
      assert((await upload(`co_${"A".repeat(40)}`, proposal)).status === 401, "a made-up code is refused")
      assert((await upload(await createOnboardingCode(bob.id), proposal)).status === 401, "a (non-admin) member's code is refused")
      assert((await upload(sendCode, { ...proposal, items: [{ zone: "x" }] })).status === 400, "a malformed proposal is refused")
      const signal = (code: string, body: unknown) =>
        onboardingProgressRoute.POST(new Request("http://smoke.test/api/onboarding/progress", { method: "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
      assert((await signal(`co_${"A".repeat(40)}`, { step: "start", message: "Go" })).status === 401, "report: a made-up code is refused")
      assert((await signal(sendCode, { step: "start", message: "Consent received, looking for the conversations" })).status === 201, "the agent reports its start")
      assert((await signal(sendCode, { step: "progress", message: "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz found" })).status === 201, "then its findings")
      const sent = await upload(sendCode, proposal)
      assert(sent.status === 201, "the agent drops off its proposal")
      const progress = (await call(onboardingProgressRoute.GET, "/api/onboarding/progress", { session: cookie })).data.events as { step: string; message: string }[]
      assert(progress.map((e) => e.step).join() === "start,progress,draft" && /First proposal received: 2 zones, 1 knowledge item/.test(progress[2].message), "the feed: start, finding, proposal received")
      assert(!JSON.stringify(progress).includes("sk-ant"), "secrets redacted in the feed")
      assert((await call(onboardingProgressRoute.GET, "/api/onboarding/progress", { session: encoreAdmin })).data.events.length === 0, "Encore does not see the feed")
      assert((await upload(sendCode, proposal)).status === 201, "the agent sends its completed proposal again")
      const completed = (await call(onboardingProgressRoute.GET, "/api/onboarding/progress", { session: cookie })).data.events.at(-1)
      assert(completed.step === "draft" && completed.message.startsWith("Proposal completed"), "the page knows it is a completed version")
      const pendingDraft = (await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: cookie })).data.draft
      assert(pendingDraft?.source === "codex" && pendingDraft.items.length === 1, "the Onboarding page finds it (it fills itself in)")
      assert(!JSON.stringify(pendingDraft).includes("sk-ant") && !JSON.stringify(pendingDraft).includes("alice@"), "secrets and emails redacted on receipt")
      assert((await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: encoreAdmin })).data.draft === null, "Encore does not see it")
      assert((await acmeStore.listZones()).every((z) => z.id !== "design"), "nothing is applied before validation")
      const { source: _src, ...validated } = pendingDraft
      const applied = await call(onboardingApplyRoute.POST, "/api/onboarding/apply", { method: "POST", session: cookie, body: validated })
      assert(applied.status === 200 && (await acmeStore.listZones()).some((z) => z.id === "design"), "validated: zones and knowledge applied")
      assert((await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: cookie })).data.draft === null, "and the proposal is cleared")

      console.log("\n— /create: brain created without a zone, Claude suggests them, the zones step starts from its proposal")
      {
        const hive = await root.createTenantOrg({ name: `Hive ${run}`, description: "Connected scales for beehives", zones: [] })
        const hiveStore = storeForOrg(hive.id)
        const founderToken = newToken()
        const founder = await hiveStore.createProfile({ name: `Inès ${run}`, role: "admin", manager_id: null, token_hash: hashToken(founderToken) })
        const hiveCookie = await createSessionValue(founder.id)
        const rAgent = await call(onboardingAgentRoute.POST, "/api/onboarding/agent", { method: "POST", session: hiveCookie })
        assert(
          rAgent.status === 200 && rAgent.data.prompt.includes(`You look ONLY for the projects and conversations of the company "Hive ${run}", which describes itself as: "Connected scales for beehives"`),
          "the prompt frames the reading by the name and description entered",
        )
        const rCode = rAgent.data.prompt.match(/Bearer (co_[A-Za-z0-9_-]+)/)?.[1] as string
        const rProposal = {
          source: "claude-code",
          company_name: `Hive ${run}`,
          description: "",
          zones: [
            { id: "sensors", name: "Sensors", description: "Scales and firmware", keywords: ["firmware"] },
            { id: "beekeepers", name: "Beekeepers", description: "Customers and support", keywords: ["support"] },
          ],
          items: [{ zone: "sensors", kind: "decision", title: `Firmware in Rust (${run})`, body: "Chosen for reliability on battery.", entities: [], source: { app: "onboarding", tool: "onboarding" }, confidence: 0.8 }],
        }
        assert((await upload(rCode, rProposal)).status === 201, "the proposal arrives during creation")
        const rDraft = (await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: hiveCookie })).data.draft
        const memberCookie = await createSessionValue(bob.id)
        assert(
          (await call(onboardingZonesRoute.POST, "/api/onboarding/zones", { method: "POST", session: memberCookie, body: { custom: ["Hack"] } })).status === 403,
          "admins only",
        )
        const zonesRes = await call(onboardingZonesRoute.POST, "/api/onboarding/zones", {
          method: "POST",
          session: hiveCookie,
          // "beekeepers" removed, "product" ticked in the list, "Legal" added by hand.
          body: { proposed: [rDraft.zones[0]], picked: ["product"], custom: ["Legal"], items: rDraft.items, description: "Connected scales for beehives.", token: founderToken },
        })
        const ids = (await hiveStore.listZones()).map((z) => z.id).sort().join()
        assert(zonesRes.status === 200 && ids === "core,legal,product,sensors", `zones created: the kept one, the ticked one, the added one, and the core (${ids})`)
        assert((await hiveStore.listZoneAccess(founder.id)).length === 4, "the admin reads and writes all their zones, the core included")
        assert((await hiveStore.listItems({ zones: ["sensors"] })).some((i) => i.title.startsWith("Firmware in Rust")), "the suggested knowledge is added")
        assert(zonesRes.data.prompt.includes("zones: sensors, product, legal") && zonesRes.data.prompt.includes(founderToken), "the install prompt is redone with these zones, same token")
        assert((await viewerFromCookies(hiveCookie, undefined))?.real.id === founder.id, "the dashboard session stays valid")
        assert((await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: hiveCookie })).data.draft === null, "the proposal is cleared")
        const empty = await root.createTenantOrg({ name: `Empty ${run}`, description: "", zones: [] })
        const emptyAdmin = await storeForOrg(empty.id).createProfile({ name: `Yann ${run}`, role: "admin", manager_id: null, token_hash: hashToken(newToken()) })
        const none = await call(onboardingZonesRoute.POST, "/api/onboarding/zones", { method: "POST", session: await createSessionValue(emptyAdmin.id), body: {} })
        assert(none.status === 400, "without any zone: refused")
        const other = await call(onboardingZonesRoute.POST, "/api/onboarding/zones", { method: "POST", session: hiveCookie, body: { custom: ["Ops"], token: newToken() } })
        assert(other.status === 200 && other.data.prompt === null, "a token that is not theirs: zones added, but no prompt")
      }

      console.log("\n— New zones created automatically (daily job)")
      {
        const carolRow = await acmeStore.createProfile({ name: `Carol ${run}`, role: "member", manager_id: null, token_hash: hashToken(newToken()) })
        const carol: Viewer = { profile: carolRow, real: carolRow, access: await getAccess(carolRow) }
        const zonesBefore = await acmeStore.listZones()
        const opsBefore = (await acmeStore.listItems({ zones: ["ops"] })).length
        const legal = ["Service agreement template", "Terms of sale: termination clause", "GDPR record of processing", "Website legal notice"]
        await runInOrg(acme.id, async () => {
          await ingestItems(alice!, Array.from({ length: 9 }, (_, n) => item("ops", `Acme oncall week ${n + 1} (${run})`)))
          await ingestItems(alice!, legal.slice(0, 3).map((t) => item("ops", `${t} (${run})`)))
          await ingestItems(carol, [item("ops", `${legal[3]} (${run})`, "task")])
        })
        const legalRefs = (input: NewZonesInput) => input.items.filter((i) => legal.some((t) => i.title.startsWith(t))).map((i) => i.ref)
        let seen: NewZonesInput | null = null
        const proposeLegal = async (input: NewZonesInput) => {
          seen = input
          return [{ name: "Legal", description: "Contracts, terms of sale and GDPR compliance.", keywords: ["contract", "terms", "gdpr", "legal"], items: legalRefs(input) }]
        }
        const first = await runInOrg(acme.id, () => runNewZones({ propose: proposeLegal }))
        assert(legalRefs(seen!).length === 4 && seen!.zones.length === zonesBefore.length, "Claude rereads the recent knowledge and the existing zones")
        assert(first.status === "created" && first.zones[0].id === "legal" && first.zones[0].items === 4, "the Legal zone is created, its 4 knowledge items are filed in it")
        const legalZone = (await acmeStore.listZones()).find((z) => z.id === "legal")
        const lastPosition = Math.max(...zonesBefore.map((z) => z.position))
        assert(legalZone && legalZone.keywords.includes("gdpr") && legalZone.position === lastPosition + 1, "with its keywords, after the existing zones")
        assert((await acmeStore.listItems({ zones: ["legal"] })).length === 4 && (await acmeStore.listItems({ zones: ["ops"] })).length === opsBefore + 9, "the other knowledge items stay in Ops")
        assert((await acmeStore.listTasks({ zones: ["legal"] })).some((t) => t.title.startsWith(legal[3])), "the task from a moved knowledge item follows it")
        const readable = async (id: string) => (await acmeStore.listZoneAccess(id)).map((a) => a.zone_id).sort().join()
        assert((await readable(bob.id)).split(",").includes("legal"), "Bob, who read Ops, also reads Legal")
        assert((await readable(carolRow.id)) === "legal", "Carol, author of one of the items, reads it too")
        const ev = (await acmeStore.listEvents({ limit: 5 })).find((e) => e.agent === "job" && e.type === "write")
        assert(ev?.zones.join() === "legal" && ev.summary?.includes("Legal"), "the new zone lights up in the activity feed")
        const again = await runInOrg(acme.id, () => runNewZones({ propose: proposeLegal }))
        assert(again.status === "unchanged" && (await acmeStore.listZones()).length === zonesBefore.length + 1, "the next day, the same proposal does not duplicate the zone")
        const log = await call(adminNewZonesRoute.GET, "/api/admin/zones/auto", { session: cookie })
        assert(log.status === 200 && log.data.runs.map((r: { status: string }) => r.status).join() === "unchanged,created", "admins see the run history")
        const bobSession = await createSessionValue(bob.id)
        assert((await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", { method: "POST", session: bobSession })).status === 403, "starting a run is reserved to admins")

        // Run done by the company's Claude Code (brain refresh-zones, subscription): material, then a proposal by ids.
        assert((await call(adminNewZonesInputRoute.GET, "/api/admin/zones/auto/input", { session: bobSession })).status === 403, "the material is reserved to admins")
        const material = await call(adminNewZonesInputRoute.GET, "/api/admin/zones/auto/input", { session: cookie })
        const oncalls = (material.data.input?.items ?? []).filter((i: { title: string }) => i.title.startsWith("Acme oncall")).map((i: { id: string }) => i.id)
        assert(material.status === 200 && oncalls.length === 9, "the company's Claude Code receives the recent knowledge, with their ids")
        assert((await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", { method: "POST", session: cookie, body: { zones: "hr" } })).status === 400, "a malformed proposal is refused")
        const agent = await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", {
          method: "POST",
          session: cookie,
          body: { zones: [{ name: "Oncall", description: "Oncall schedule.", keywords: ["oncall"], item_ids: [...oncalls.slice(0, 4), "made-up"] }] },
        })
        assert(agent.status === 200 && agent.data.status === "created" && agent.data.via === "claude-code" && agent.data.zones[0].items === 4, "its proposal is applied, a made-up id points to nothing")

        const cron = (headers: Record<string, string> = {}, qs = "") => cronNewZonesRoute.GET(new Request(`http://smoke.test/api/cron/new-zones${qs}`, { headers }))
        const prevSecret = process.env.CRON_SECRET
        try {
          delete process.env.CRON_SECRET
          assert((await cron({ authorization: "Bearer x" })).status === 503, "cron: closed as long as CRON_SECRET is not set")
          process.env.CRON_SECRET = `secret-${run}`
          assert((await cron({ authorization: "Bearer wrong" })).status === 401, "cron: wrong secret refused")
          if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
            const res = await cron({ authorization: `Bearer secret-${run}` }, "?force=1")
            const body = (await res.json()) as { ran: boolean; orgs: { org_id: string; status: string; reason?: string }[] }
            const acmeRun = body.orgs.find((o) => o.org_id === acme.id)
            assert(res.status === 200 && body.orgs[0].org_id === encore.id && acmeRun?.reason === "no_claude", "cron: every company is reviewed; without an API key, nothing is created")
          }
        } finally {
          if (prevSecret === undefined) delete process.env.CRON_SECRET
          else process.env.CRON_SECRET = prevSecret
        }

        console.log("\n— The company's Claude API key")
        const fakeKey = `sk-ant-api03-${"x".repeat(30)}${run}AbCd`
        const claudeRoute = (method: "GET" | "PUT" | "DELETE", session: string, body?: unknown) => call(adminClaudeRoute[method], "/api/admin/claude", { method, session, body })
        assert((await claudeRoute("GET", bobSession)).status === 403, "admins only")
        assert((await claudeRoute("PUT", cookie, { key: "sk-proj-not-a-claude-key-1234567890" })).status === 400, "a key that is not a Claude key is refused")
        const unchecked = await claudeRoute("PUT", cookie, { key: fakeKey })
        assert([400, 502].includes(unchecked.status) && !(await acmeStore.getOrgSetting("claude-api-key")), "a key refused by Anthropic (or unverifiable) is not saved")
        await setOrgClaudeKey(acmeStore, fakeKey, boss.id)
        const raw = (await acmeStore.getOrgSetting("claude-api-key")) ?? ""
        assert(raw && !raw.includes(fakeKey.slice(14)), "the key is encrypted in the company settings")
        assert((await getOrgClaudeKey(acmeStore)) === fakeKey && (await getClaude(acmeStore)) !== null, "the server reads it back for the company's calls")
        const info = await claudeRoute("GET", cookie)
        assert(info.status === 200 && info.data.source === "org" && info.data.last4 === "AbCd" && !JSON.stringify(info.data).includes(fakeKey), "the admin only sees its last 4 characters")
        assert(!(await getOrgClaudeKey(store)), "Encore does not have Acme's key")
        const removed = await claudeRoute("DELETE", cookie)
        assert(removed.status === 200 && removed.data.source !== "org" && !(await getOrgClaudeKey(acmeStore)), "the admin can remove it")
      }

      const demoList = await call(demoSessionRoute.GET, "/api/session/demo")
      assert(demoList.status === 404 || !demoList.data.users.some((u: { id: string }) => u.id === boss.id), "the company's accounts are not offered in the demo")
    } finally {
      if (store.kind === "file") fs.rmSync(path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain", "orgs", acme.id), { recursive: true, force: true })
      else {
        const sql = pgClient(process.env.DATABASE_URL!)
        await sql`delete from orgs where id = ${acme.id}`
        await sql`delete from brain_settings where key in (${`tenant:${acme.id}`}, ${`join:${acme.id}`}) or key like ${`org:%:${acme.id}`}`
        await sql.end()
      }
    }
  }

  console.log("\n— Onboarding: SSRF protection")
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "fec0::1", "fc00::1", "fd12:3456::1", "fe80::1%eth0", "ff02::1", "2002:7f00:1::1", "2001:db8::1", "2001::1", "anything"])
    if (!isBlockedAddress(ip)) throw new Error(`FAILED: ${ip} should be refused`)
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4007:80e::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])
    if (isBlockedAddress(ip)) throw new Error(`FAILED: ${ip} should be accepted`)
  console.log("✓ internal addresses refused (IPv4, IPv6, IPv4-mapped, NAT64, 6to4, site-local…), public addresses accepted")
  for (const raw of ["http://[::ffff:7f00:1]:3100/", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[64:ff9b::a9fe:a9fe]/", "http://2130706433/", "http://localhost./", "file:///etc/passwd"]) {
    const page = await scrapeUrl(raw)
    if (!page.error || page.text) throw new Error(`FAILED: ${raw} should have been refused (${page.error ?? "read"})`)
  }
  console.log("✓ internal URLs refused before any connection")

  // Fake local Internet: 127.0.0.1 plays the "public" address, 127.0.0.2 the internal one.
  const server = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" })
      return res.end(zlib.gzipSync("<html><head><title>Encore</title></head><body><p>Refurbished smartphones with a 2-year warranty</p></body></html>"))
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" })
      return res.end("x".repeat(3_000_000))
    }
    if (req.url === "/redirect-ip") {
      res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as { port: number }).port}/page` })
      return res.end()
    }
    if (req.url === "/redirect-name") {
      res.writeHead(302, { location: "/page" })
      return res.end()
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r))
  const port = (server.address() as { port: number }).port
  const fakeBlocked = (ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip)
  try {
    const okPage = await scrapeUrlWith(`http://public.test:${port}/page`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: fakeBlocked })
    assert(okPage.title === "Encore" && okPage.text.includes("smartphones"), "a public (gzip) page is read")
    const big = await scrapeUrlWith(`http://public.test:${port}/big`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: fakeBlocked })
    assert(!big.error && big.truncated && big.text.length <= 20000, "page size bounded")
    const viaIp = await scrapeUrlWith(`http://public.test:${port}/redirect-ip`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: fakeBlocked })
    assert(viaIp.error === "internal address refused", "redirect to an internal IP refused")
    let calls = 0
    const rebinding = async () => [{ address: calls++ === 0 ? "127.0.0.1" : "127.0.0.2", family: 4 }]
    const rebound = await scrapeUrlWith(`http://rebind.test:${port}/redirect-name`, { resolve: rebinding, isBlocked: fakeBlocked })
    assert(rebound.error === "internal address refused" && calls === 2, "DNS rebinding: the address is checked again on each connection")
    const mixed = await scrapeUrlWith(`http://mixed.test:${port}/page`, {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }],
      isBlocked: fakeBlocked,
    })
    assert(mixed.error === "internal address refused", "a name that also resolves to an internal address is refused")
    const direct = await scrapeUrlWith(`http://evil.test:${port}/page`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: isBlockedAddress })
    assert(direct.error === "internal address refused", "a name that resolves to 127.0.0.1 is refused at connection time")
  } finally {
    server.close()
  }

  for (const id of created) await store.deleteItem(id)
  console.log("\n— Monitoring: sync reports and workstation health")
  const failedReport = await store.saveSyncReport(hugo.profile.id, {
    at: new Date().toISOString(),
    ok: false,
    duration_ms: 1200,
    items_sent: 0,
    duplicates: 0,
    conversations: { claude: 2 },
    distiller: "claude-cli",
    failed: 1,
    deferred: 0,
    error: `Smoke ${run}: token expired`,
  })
  assert((await store.latestSyncReports()).find((r) => r.user_id === hugo.profile.id)?.id === failedReport.id, "each workstation's latest report is the one that just arrived")
  assert(workstationHealth({ report: failedReport, lastEventAt: null, now: Date.now() }).status === "error", "a workstation whose sync failed is \"in error\"")
  const okReport = await store.saveSyncReport(hugo.profile.id, { ...failedReport, ok: true, error: undefined, items_sent: 3, at: new Date().toISOString() })
  assert(workstationHealth({ report: okReport, lastEventAt: null, now: Date.now() }).status === "ok", "then \"up to date\" after a successful sync")
  assert((await store.listSyncReports({ userId: hugo.profile.id, limit: 10 }))[0]?.id === okReport.id, "workstation history, most recent first")

  console.log("\n— Live stream: the storage notifies on insert")
  let notified = 0
  const unsubscribe = store.onEvents(hugo.profile.org_id, () => notified++)
  await sleep(store.kind === "postgres" ? 500 : 0)
  await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} notification` }])
  for (let i = 0; i < 30 && notified === 0; i++) await sleep(50)
  unsubscribe()
  if (store.eventNotifyMode() === "local") assert(notified >= 1, "file storage: the stream subscriber is woken up")
  else console.log(`· Postgres: mode ${store.eventNotifyMode()}, ${notified} notification(s) received (the safety reread covers the rest)`)

  console.log("\n— Quality: revised decision, near-duplicate dropped, synonyms, entities")
  const qtag = `Smoke ${run} quality`
  const decision = (body: string, at: number): KnowledgeItemInput => ({
    zone: "dev",
    kind: "decision",
    title: `${qtag}: Stripe webhooks go through a queue`,
    body,
    entities: [{ type: "tool", name: "Redis" }],
    source: { app: "Terminal", tool: "claude-code", at: new Date(at).toISOString() },
    confidence: 0.8,
  })
  // The run's tag is also in the body: a smoke replayed on the same storage does not find the previous run's
  // decisions as near-duplicates.
  const firstDecision = await ingestItems(hugo, [decision(`We put Stripe webhooks in a Redis queue to absorb order peaks (run ${run}).`, Date.now() - 60_000)])
  assert(firstDecision.inserted === 1, "first version of the decision inserted")
  const near = await ingestItems(hugo, [decision(`We put Stripe webhooks in a Redis queue to absorb order peaks (run ${run})!`, Date.now() - 30_000)])
  assert(near.inserted === 0 && near.skipped === 1, "a near-duplicate (same content up to punctuation) is dropped")
  const revised = await ingestItems(hugo, [decision(`No queue after all: Stripe webhooks are processed directly, Redis removed from the infra after the load tests (run ${run}).`, Date.now() + 5_000)])
  assert(revised.inserted === 1 && revised.replaced === 1, "a revised decision (same subject, different content) replaces the old one")
  assert((await store.getItem(firstDecision.ids[0]))?.superseded_by === revised.ids[0], "the old version carries superseded_by")
  const current = await hybridSearch(`${qtag} webhooks queue`, ["dev"], 5)
  assert(current.some((i) => i.id === revised.ids[0]) && !current.some((i) => i.id === firstDecision.ids[0]), "search only offers the up-to-date version")
  assert(!(await store.listItems({ zones: ["dev"], limit: 50, excludeSuperseded: true })).some((i) => i.id === firstDecision.ids[0]), "the dashboard lists drop it too")
  assert((await hybridSearch("how do we ship a release", allZones, 5)).some((i) => /deploy/i.test(i.title)), "synonyms: \"ship a release\" finds \"Deploy\"")
  const redis = await getEntityContext(hugo, "tool", "redis")
  assert(redis !== null && redis.items.some((i) => i.id === revised.ids[0]) && !redis.items.some((i) => i.id === firstDecision.ids[0]), "an entity's page only cites up-to-date knowledge")
  assert(redis !== null && redis.name === "Redis", "the displayed name keeps its original case")
  const zoneRes = await zoneRoute.GET(new Request("http://smoke.test/api/zones/dev", { headers: { cookie: `brain_session=${hugoSession}` } }), {
    params: Promise.resolve({ id: "dev" }),
  })
  const zoneItems = ((await zoneRes.json()) as { items: { id: string }[] }).items
  assert(
    zoneRes.status === 200 && zoneItems.some((i) => i.id === revised.ids[0]) && !zoneItems.some((i) => i.id === firstDecision.ids[0]),
    "zone summary (MCP get_zone_summary, zone drawer): only the up-to-date version",
  )
  // Cleanup: a next run on the same storage must not find these decisions as near-duplicates.
  for (const id of [firstDecision.ids[0], revised.ids[0]]) assert(await store.deleteItem(id), "test decision deleted")

  console.log("\n— Knowledge graph: one hop from the best results, an entity's neighborhood (explore_entity)")
  // A customer of this run only, whose name shares no word with the search: the run's tag, reversed. Facts only: a
  // decision or a procedure could replace one of the demo's.
  const rev = [...run].reverse().join("")
  const lumen = { type: "client" as const, name: `Lumen ${rev}` }
  const fact = (zone: string, title: string, body: string): KnowledgeItemInput => ({
    zone, kind: "fact", title, body, entities: [lumen], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.8,
  })
  const linked = await ingestItems(hugo, [
    fact("dev", `Smoke ${run}: the webhook signing secret rotates every quarter`, `For this customer's integration (run ${run}).`),
    fact("dev", "Twelve-month pilot contract", `Renewal in March, invoiced yearly (ref ${rev}).`),
  ])
  const discount = await ingestItems(jm, [fact("finance", "Pilot invoiced at a discount", `Half price the first quarter (ref ${rev}).`)])
  assert(linked.inserted === 2 && discount.inserted === 1, "three items citing the same customer, one of them in finance")
  const [rotate, pilot] = linked.ids
  const graphQuery = `${run} webhook signing secret`
  const forHugo = (await queryBrain(hugo, { query: graphQuery })).items
  const firstLinked = forHugo.findIndex((i) => i.via)
  const viaPilot = forHugo.find((i) => i.id === pilot)?.via
  assert(forHugo[0]?.id === rotate, "graph: the knowledge with the query's words comes first")
  assert(viaPilot?.entity.name === lumen.name && viaPilot.from.id === rotate, "graph: the contract with the same customer comes too, without any word of the query, saying which entity links it")
  assert(firstLinked > 0 && forHugo.slice(firstLinked).every((i) => i.via), "graph: linked knowledge only takes the last places")
  assert(!forHugo.some((i) => i.id === discount.ids[0]), "graph: nothing from a zone the search does not read (finance)")
  assert((await queryBrain(claire, { query: graphQuery })).items.some((i) => i.id === discount.ids[0] && i.via), "graph: the admin, who reads finance, gets the discount too")
  const explored = await exploreEntity(hugo, { name: lumen.name.toUpperCase() })
  assert(
    explored.entity?.name === lumen.name && explored.items.map((i) => i.id).sort().join() === [rotate, pilot].sort().join() && explored.zones.join() === "dev",
    "explore_entity: whatever the case, the knowledge citing the customer in the zones read",
  )
  const jmLumen = await exploreEntity(jm, { name: lumen.name })
  assert(jmLumen.items.map((i) => i.id).join() === discount.ids[0] && jmLumen.zones.join() === "finance", "explore_entity: finance only gets finance's knowledge")
  assert((await call(entitiesRoute.GET, "/api/entities", { session: hugoSession })).status === 400, "GET /api/entities without a name: 400")
  const byRoute = await call(entitiesRoute.GET, `/api/entities?name=${rev}&agent=mcp`, { session: hugoSession })
  assert(byRoute.status === 200 && byRoute.data.entity?.name === lumen.name, "GET /api/entities: a part of the name is enough when only one entity has it")
  const explores = await lastEvent(hugo)
  assert(explores.agent === "mcp" && explores.summary === `Explores ${lumen.name}` && explores.zones.join() === "dev", "explore_entity by an agent: its zone lights up")
  const unknownLumen = await exploreEntity(hugo, { name: `Lumen ${rev}x` })
  assert(unknownLumen.entity === null && unknownLumen.suggestions.some((e) => e.name === lumen.name), "explore_entity: an unknown name, the closest names instead")
  for (const id of [rotate, pilot, discount.ids[0]]) assert(await store.deleteItem(id), "graph test item deleted")

  console.log("\n— Connectors: external tasks inserted, updated, closed")
  // Only count this run's tasks: the closing loop also returns the open tasks of a previous run.
  const mine = (ts: Task[]) => ts.filter((t) => t.external_id?.startsWith(`${run}-`))
  const ext1 = mine(
    await store.upsertExternalTasks("linear", [
      { title: `${qtag} FOU-1`, zone: "dev", status: "open", external_id: `${run}-1`, external_url: "https://linear.app/x/1" },
      { title: `${qtag} FOU-2`, zone: "dev", status: "open", external_id: `${run}-2` },
    ]),
  )
  assert(ext1.length === 2 && ext1.every((t) => t.external_source === "linear"), "two tasks imported with their source")
  const ext2 = await store.upsertExternalTasks("linear", [{ title: `${qtag} FOU-1 renamed`, zone: "dev", status: "open", external_id: `${run}-1`, external_url: "https://linear.app/x/1" }])
  const ext1a = ext2.find((t) => t.external_id === `${run}-1`)
  const ext2a = ext2.find((t) => t.external_id === `${run}-2`)
  assert(ext1a?.title.endsWith("renamed") && ext1a.id === ext1[0].id, "the same task is updated, without a duplicate")
  assert(ext2a?.status === "done", "a task gone from the tool becomes done here")
  assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.id === ext1a!.id && t.external_url === "https://linear.app/x/1"), "the link to the tool is kept")
  // Cleanup: nothing open from this run remains for the next one.
  assert((await store.updateTask(ext1a!.id, { status: "done" }))?.status === "done", "test task closed")

  console.log("\n— Moderator: a run every 15 min (the CEO's Claude Code in CI, or the server)")
  {
    const keep = (ref: number) => ({ ref, decision: "publish" as const, category: null, reason: "", zone: null, kind: null, title: null, body: null })
    // What was already waiting (seed, previous runs) is reviewed first: empty the queue.
    for (let n = 0; n < 50; n++) if ((await runModeration(async (input) => input.items.map((i) => keep(i.ref)))).status !== "done") break
    assert("skipped" in (await moderationInput()), "moderator queue empty at the start")

    const tag = `Moderation ${run}`
    const posted = await ingestItems(hugo, [
      { ...item("dev", `${tag}: Stripe webhooks go through a Redis queue`, "decision"), body: "To absorb the Black Friday spikes." },
      { ...item("dev", `${tag}: doctor's appointment on Thursday`, "task"), source: { app: "Screenpipe", tool: "agent", at: new Date().toISOString() } },
      { ...item("dev", `${tag}: VAT to file`), body: "Return before the 19th of the month." },
    ])
    assert(posted.inserted === 3, "three knowledge items arrive, published right away")
    const [good, perso, vat] = posted.ids
    assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.source_item_id === perso), "the appointment created a task")
    const material = await moderationInput()
  assert(!("skipped" in material) && [...material.input.items.map((i) => i.id!)].sort().join() === [...posted.ids].sort().join(), "the next run reviews exactly what arrived")
    assert(!("skipped" in material) && material.input.items[0].author === "Hugo Bernard", "with the author's name")
    const claireSession = await createSessionValue(claire.profile.id)
    const jmSession = await createSessionValue(jm.profile.id)
    assert((await call(adminModerationInputRoute.GET, "/api/admin/moderation/input", { session: jmSession })).status === 403, "admins only")

    // Decisions of Claude Code (in CI), sent by `brain moderate`.
    const verdicts = [
      { id: good, decision: "publish" },
      { id: perso, decision: "reject", category: "personal", reason: "The employee's medical appointment." },
      { id: vat, decision: "edit", zone: "finance", kind: "procedure", title: `${tag}: file the VAT before the 19th` },
    ]
    const applied = await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: posted.ids, verdicts } })
    assert(applied.status === 200 && applied.data.reviewed === 3 && applied.data.edited === 1 && applied.data.rejected === 1, "three reviewed, one edited, one removed")
    assert((await store.getItem(perso)) === null, "the personal knowledge is removed from the brain")
    const boardAfter = await store.listTasks({ zones: ["dev"] })
    assert(!boardAfter.some((t) => t.source_item_id === perso || t.title.includes("doctor")), "its task leaves the board with it")
    assert(boardAfter.some((t) => t.id === ext1a!.id && t.external_source === "linear"), "tasks imported from a tool are not touched")
    const fixed = await store.getItem(vat)
    assert(fixed?.zone === "finance" && fixed.kind === "procedure" && fixed.title.endsWith("file the VAT before the 19th"), "the edit is applied in place (zone, kind, title)")
    assert((await store.getItem(good))?.title.includes("Stripe webhooks"), "the good one stays as is")
    const log = await loadModerationLog()
    assert(log[0]?.decision !== undefined && !JSON.stringify(log).includes("doctor") && !JSON.stringify(log).includes("appointment"), "the log does not keep the removed text")
    assert(log.some((e) => e.decision === "reject" && e.category === "personal" && !e.reason), "\"personal\" removal: reason id only, without Claude's sentence")
    const modEvents = (await store.listEvents({ limit: 20, type: "write" })).filter((e) => e.summary?.startsWith("Moderator"))
    assert(modEvents.some((e) => e.summary === "Moderator: 1 knowledge item removed (personal content)" && e.zones.join() === "dev"), "the activity feed shows the removal, without the text")
    assert("skipped" in (await moderationInput()), "already reviewed: the next run has nothing to do")
    const replay = await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: [good], verdicts: [{ id: good, decision: "reject", category: "vague" }] } })
    assert(replay.data.reviewed === 0 && (await store.getItem(good)) !== null, "a verdict on knowledge already reviewed is ignored")

    // Server run: a batch without an answer from Claude stays waiting, the cursor does not skip it.
    const later = await ingestItems(hugo, [item("dev", `${tag}: revised go-live procedure`, "procedure")])
    const failed = await runModeration(async () => null)
    assert(failed.status === "claude_error" && failed.remaining === 1, "silent Claude: nothing reviewed, the knowledge waits")
    const ok = await runModeration(async (input) => input.items.map((i) => keep(i.ref)))
    assert(ok.status === "done" && ok.reviewed === 1 && ok.via === "server", "reviewed at the next run")

    await setModerationEnabled(false)
    assert((await moderationInput()).hasOwnProperty("skipped") && (await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: [], verdicts: [] } })).status === 409, "off: no more runs")
    await setModerationEnabled(true)
    for (const id of [good, vat, later.ids[0]]) assert(await store.deleteItem(id), "test knowledge deleted")
  }

  console.log("\nAll green.")
  if ("end" in store) await (store as unknown as { end: () => Promise<void> }).end()
}

if (process.argv[2] === "--writer") {
  writer(process.argv[3], process.argv[4], Number(process.argv[5])).then(
    () => process.exit(0),
    (e) => {
      console.error(e)
      process.exit(1)
    },
  )
} else {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
