// Test de fumée du cerveau sur le stockage courant (fichier ou Postgres) : npm run smoke
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
import { DISTILL_MARKER, buildCliStatusPrompt, parseStatusJson, posteHealth, slugify, tokenize, type CompanyStatus, type KnowledgeItemInput, type NewZonesInput, type StatusInput, type Task } from "@brain/core"
import { getRootStore, getStore, isStoreSetupError, runInOrg, storeForOrg, type BrainStore } from "../lib/store"
import { FileStore } from "../lib/store/file"
import { PostgresStore } from "../lib/store/postgres"
import { getAccess, redactEvent } from "../lib/access"
import {
  createEventPoller,
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
import { createLoginCode, createOnboardingCode, createSessionValue, hashToken, newToken, profileFromToken, verifyLoginCode, viewerFromCookies, type Viewer } from "../lib/auth"
import { isBlockedAddress, scrapeUrl, scrapeUrlWith } from "../lib/scrape"
import * as automationsRoute from "../app/api/automations/route"
import * as adminZonesRoute from "../app/api/admin/zones/route"
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
import * as onboardingImportRoute from "../app/api/onboarding/import/route"
import * as onboardingApplyRoute from "../app/api/onboarding/apply/route"
import * as joinStatusRoute from "../app/api/join/status/route"
import * as adminJoinRoute from "../app/api/admin/join/route"
import * as adminJoinIdRoute from "../app/api/admin/join/[id]/route"
import * as skillsRoute from "../app/api/skills/route"
import * as skillRoute from "../app/api/skills/[id]/route"
import { DEMO_VISITOR_TITLE, demoVisitorManager, seedDemoBrain, upgradeDemoBrain } from "../lib/demo-seed"
import { SkillError, canPublishSkills, listVisibleSkills, publishSkill, removeSkill, setSkillZone } from "../lib/skills"

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ÉCHEC : ${msg}`)
  console.log(`✓ ${msg}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function viewer(name: string): Promise<Viewer> {
  const p = (await getStore().listProfiles()).find((x) => x.name.startsWith(name))
  if (!p) throw new Error(`profil ${name} introuvable (lancez le seed)`)
  return { profile: p, real: p, access: await getAccess(p) }
}

function item(zone: string, title: string, kind: KnowledgeItemInput["kind"] = "fact"): KnowledgeItemInput {
  return { zone, kind, title, body: `${title}. Test de fumée.`, entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.7 }
}

type Handler = (req: Request, ctx: any) => Promise<Response>

/** Appelle une route de l'API comme le ferait Next (cookie de session du dashboard). */
async function call(handler: Handler, url: string, opts: { method?: string; session?: string; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.session) headers.cookie = `brain_session=${opts.session}`
  const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
  const res = await handler(new Request(`http://smoke.test${url}`, { method: opts.method ?? "GET", headers, body }), { params: Promise.resolve({}) })
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

function pgClient(url: string, max = 2) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
  return postgres(url, { prepare: false, max, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
}

/** Applique les migrations sur `url` (scripts/migrate.ts dans un processus enfant). */
function migrate(url: string): Promise<void> {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrate.ts")
  return new Promise((resolve, reject) => {
    const child = fork(script, [], { env: { ...process.env, DATABASE_URL: url }, execArgv: process.execArgv, stdio: "ignore" })
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrations : code ${code}`))))
  })
}

/**
 * E3 : reset() pendant qu'une autre instance relit l'organisation. Dans une base jetable (le reset vide tout) :
 * ignoré si le rôle ne peut pas créer de base.
 */
async function orgRaceTest(baseUrl: string, run: string) {
  const dbName = `brain_smoke_e3_${run}`.replace(/[^a-z0-9_]/g, "_")
  const admin = pgClient(baseUrl, 1)
  try {
    await admin.unsafe(`create database "${dbName}"`)
  } catch (err) {
    console.log(`⚠ test de course E3 ignoré (création d'une base jetable impossible : ${(err as Error).message})`)
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
    assert(fresh === 1 && o1.id === o2.id, "base neuve : deux instances qui démarrent ensemble ne créent qu'une organisation")

    // B fait le reseed (latence ajoutée DANS la transaction, entre la purge et la création, comme depuis un laptop) ;
    // A relit son org en continu (cache expiré), C fait comme une instance qui démarre (aucun cache).
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
      `20 reseeds pendant que deux autres instances relisent l'org : jamais d'org parasite (${refreshes} relectures, ${starts} démarrages)`,
    )
    A.orgCache.at = 0
    assert((await A.getOrg()).name === "Smoke org 19", "l'autre instance suit la nouvelle organisation")

    // Purge faite par un autre outil (ancien seed : truncate puis création séparée) : un rafraîchissement ne crée rien.
    await sql`truncate orgs cascade`
    A.orgCache.at = 0
    const kept = await A.getOrg()
    const [{ n: afterPurge }] = await sql`select count(*)::int as n from orgs`
    assert(afterPurge === 0 && kept.name === "Smoke org 19", "table vidée ailleurs : un rafraîchissement du cache ne crée jamais d'organisation")
    const [x1, x2] = await Promise.all([open().getOrg(), open().getOrg()])
    const [{ n: recreated }] = await sql`select count(*)::int as n from orgs`
    assert(recreated === 1 && x1.id === x2.id, "base vide : deux premiers chargements simultanés créent une seule organisation (insertion atomique)")
    await open().createProfile({ name: "Smoke", role: "admin", token_hash: `smoke-${run}` })
    await sql`insert into orgs (name, description, created_at) values ('Org parasite', '', now() - interval '1 day')`
    assert((await open().getOrg()).id === x1.id, "une organisation vide plus ancienne (parasite) est ignorée au profit de celle qui a des comptes")
  } finally {
    await Promise.all(stores.map((st) => st.end().catch(() => {})))
    await sql.end({ timeout: 5 })
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`).catch((err) => console.log(`⚠ base jetable ${dbName} non supprimée : ${err.message}`))
    await admin.end({ timeout: 5 })
  }
}

/** Processus enfant (test du verrou du stockage fichier) : écrit des événements et des items dans `dir`. */
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
  console.log(`Stockage : ${store.kind}`)
  const claire = await viewer("Claire")
  const jm = await viewer("Jean-Marc")
  const hugo = await viewer("Hugo")
  const ines = await viewer("Inès")
  const sarah = await viewer("Sarah")
  const zones = await store.listZones()
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id

  assert(claire.access.isAdmin && claire.access.readable.length >= 6, "l'admin lit toutes les zones")
  assert(jm.access.readable.join() === "compta", "Jean-Marc ne lit que la compta")

  const devForJm = await queryBrain(jm, { query: "déployer en production" })
  assert(devForJm.items.length === 0, "RLS : la compta ne voit rien de la zone dev")
  assert(devForJm.zones_restricted.includes("dev"), "la zone dev est signalée comme restreinte")
  const devForHugo = await queryBrain(hugo, { query: "déployer en production" })
  assert(devForHugo.items.some((i) => i.title.includes("Déployer Fournil")), "Hugo trouve la procédure de déploiement")
  const compta = await queryBrain(jm, { query: "rapprochement Qonto Pennylane" })
  assert(compta.items[0]?.zone === "compta" && compta.zones_hit.includes("compta"), "Jean-Marc trouve le rapprochement, la zone compta s'allume")

  const before = (await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0
  const res = await ingestItems(hugo, [
    {
      zone: "inconnue", kind: "task", title: `Ajouter un index sur les précommandes (${run})`, body: "TODO avant la mise en prod. Contact : hugo@fournil.example, clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      entities: [{ type: "tool", name: "Postgres" }], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.7,
    },
  ])
  const it = await store.getItem(res.ids[0])
  assert(it && it.zone === "dev", "une zone inconnue est reclassée (dev)")
  assert(it && !it.body.includes("sk-ant") && !it.body.includes("@fournil"), "secrets et emails masqués côté serveur")
  assert(((await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0) === before + 1, "le compteur de la zone dev augmente")
  assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.source_item_id === res.ids[0]), "une tâche est créée depuis l'item")

  const evs = await recordEvents(hugo, [{ agent: "claude-code", type: "query", summary: "corrige le bug du webhook stripe en prod" }])
  assert(evs[0].zones.includes("dev") && evs[0].summary, "un prompt sans zone est classé (dev) et garde son résumé")
  const after = await store.listEvents({ afterId: evs[0].id - 1, limit: 10 })
  assert(after[0]?.id === evs[0].id, "le flux temps réel relit les événements dans l'ordre")

  const stJm = await getState(jm)
  assert(stJm.items.every((i) => i.zone === "compta"), "l'état de Jean-Marc ne contient que la compta")
  assert(stJm.zones.find((z) => z.id === "dev")?.locked === true, "la zone dev est verrouillée pour Jean-Marc")
  assert(stJm.automations.every((a) => a.user_id === jm.profile.id), "Jean-Marc ne voit que ses automatisations")

  const autos = await runAutomationDetection()
  assert(autos.some((a) => a.title.includes("Qonto")), "l'automatisation du rapprochement de 9 h est détectée")
  const status = await refreshStatus(claire)
  assert(status.zones.length >= 6 && status.headline.length > 10, `état de l'entreprise généré (${status.generator})`)
  const ctx = await getPersonContext(claire, hugo.profile.id)
  assert(ctx && ctx.zones[0]?.zone === "dev" && ctx.items.length > 0, "contexte de passation de Hugo")

  assert(await store.deleteItem(res.ids[0]), "l'auteur peut supprimer une connaissance")

  console.log("\n— Skills de l'entreprise : publication sous autorisation, attribution à un cortex")
  const names = async (v: Viewer) => (await listVisibleSkills(v)).map((x) => x.name)
  const jmSkills = await names(jm)
  assert(jmSkills.includes("ton-fournil") && jmSkills.includes("rapprochement-qonto-pennylane"), "Jean-Marc reçoit les skills de toute l'entreprise et du cortex compta")
  assert(!jmSkills.includes("deployer-fournil"), "mais pas celui du cortex dev")
  assert((await names(hugo)).includes("deployer-fournil") && !(await names(hugo)).includes("rapprochement-qonto-pennylane"), "Hugo reçoit le skill dev, pas celui de la compta")
  assert((await names(claire)).length >= 5, "l'admin voit tous les skills")
  assert(canPublishSkills(claire) && canPublishSkills(hugo) && !canPublishSkills(ines), "publier : admins et membres autorisés seulement")
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
    { path: "SKILL.md", content: "# Test de fumée\n\nLancer scripts/run.py." },
    { path: "scripts/run.py", content: "import os\nprint(os.environ['PENNYLANE_TOKEN'])\n" },
  ]
  assert(await refused(publishSkill(ines, { name: skillName, description: "Test", zone: null, files }), 403), "Inès (sans autorisation) ne peut pas publier")
  assert(await refused(publishSkill(jm, { name: skillName, description: "Test", zone: "dev", files }), 403), "Jean-Marc ne peut pas attribuer un skill au cortex dev, qu'il ne lit pas")
  const leak = [...files, { path: "scripts/leak.sh", content: `curl -H "Authorization: Bearer ${["sk-ant-", "api03-", "z".repeat(40)].join("")}" https://api.example` }]
  try {
    await publishSkill(jm, { name: skillName, description: "Test", zone: "compta", files: leak })
    throw new Error("ÉCHEC : un skill avec un secret aurait dû être refusé")
  } catch (err) {
    assert(err instanceof SkillError && err.status === 400 && err.details?.some((d) => d.startsWith("scripts/leak.sh")), "un script qui contient un secret est refusé, en nommant le fichier")
  }
  assert(await refused(publishSkill(jm, { name: skillName, description: "Test", zone: "compta", files: [...files, { path: "../../.bashrc", content: "x" }] }), 400), "un chemin qui sort du skill est refusé")
  const v1 = await publishSkill(jm, { name: skillName, description: "Test de fumée des skills", zone: "compta", files })
  assert(v1.created && v1.skill.version === 1 && v1.skill.zone === "compta", "Jean-Marc publie un skill dans le cortex compta")
  assert(v1.skill.files[0].content.startsWith(`---\nname: ${skillName}\ndescription: "Test de fumée des skills"\n---`), "SKILL.md reçoit l'en-tête que Claude Code attend")
  assert((await store.listEvents({ limit: 5 })).some((e) => e.type === "write" && e.zones.join() === "compta" && e.summary?.includes(skillName)), "la publication allume le cortex compta")
  const v2 = await publishSkill(jm, { name: skillName, description: "", files })
  assert(!v2.created && v2.skill.version === 2 && v2.skill.zone === "compta" && v2.skill.description === "Test de fumée des skills", "même nom : version 2, cortex et description gardés")
  assert(await refused(publishSkill(hugo, { name: skillName, description: "x", zone: "dev", files }), 409), "un nom pris dans un cortex illisible est refusé sans rien en dire")
  assert(await refused(setSkillZone(hugo, v1.skill.id, null), 404), "Hugo ne voit pas le skill de la compta (404)")
  await setSkillZone(jm, v1.skill.id, null)
  assert((await names(hugo)).includes(skillName), "attribué à toute l'entreprise, Hugo le reçoit")
  assert(await refused(setSkillZone(hugo, v1.skill.id, "dev"), 403), "seul l'auteur ou un admin change son cortex")
  await setSkillZone(claire, v1.skill.id, "dev")
  assert(!(await names(jm)).includes(skillName) && (await names(hugo)).includes(skillName), "l'admin l'attribue au cortex dev : Jean-Marc ne le reçoit plus")
  assert((await getState(jm)).totals.skills === (await names(jm)).length, "le compteur de l'onglet Skills suit les droits")
  const ineSession = await createSessionValue(ines.profile.id)
  const listed = await call(skillsRoute.GET, "/api/skills", { session: ineSession })
  assert(listed.status === 200 && listed.data.can_publish === false && listed.data.skills.every((x: { zone: string | null }) => x.zone === null || ines.access.readable.includes(x.zone)), "GET /api/skills : les skills d'Inès, sans droit de publier")
  const denied = await call(skillsRoute.POST, "/api/skills", { method: "POST", session: ineSession, body: { name: `${skillName}-b`, description: "x", files } })
  assert(denied.status === 403 && /autorisation/.test(denied.data.error), "POST /api/skills sans autorisation : 403")
  const jmSession = await createSessionValue(jm.profile.id)
  const patched = await skillRoute.PATCH(
    new Request(`http://smoke.test/api/skills/${v1.skill.id}`, { method: "PATCH", headers: { cookie: `brain_session=${jmSession}`, "content-type": "application/json" }, body: JSON.stringify({ zone: null }) }),
    { params: Promise.resolve({ id: v1.skill.id }) },
  )
  assert(patched.status === 404, "PATCH d'un skill hors de ses cortex : 404")
  await removeSkill(claire, v1.skill.id)
  assert(!(await store.getSkill(v1.skill.id)), "l'admin retire le skill")

  console.log("\n— Démo remplie par une version antérieure : complétée sans rien effacer")
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-upgrade-"))
    try {
      const old = new FileStore(tmp)
      await seedDemoBrain(old)
      // Avant les rattachements et les skills : organigramme à plat, aucun skill, personne n'a le droit de publier.
      const team = await old.listProfiles()
      for (const p of team) await old.updateProfile(p.id, { manager_id: null, can_publish_skills: false })
      for (const sk of await old.listSkills()) await old.deleteSkill(sk.id)
      const visitor = await old.createProfile({ name: "Visiteur 1234", title: DEMO_VISITOR_TITLE, role: "member", token_hash: hashToken(newToken()) })
      const itemsBefore = (await old.listItems({})).length
      const res = await upgradeDemoBrain(old)
      const after = new Map((await old.listProfiles()).map((p) => [p.name, p]))
      const id = (n: string) => team.find((p) => p.name.startsWith(n))!.id
      assert(after.get("Inès Lefèvre")?.manager_id === id("Hugo") && after.get("Jean-Marc Dubois")?.manager_id === id("Claire"), "l'organigramme à plat retrouve ses rattachements")
      assert(after.get("Claire Martin")?.manager_id == null, "la CEO reste en tête")
      assert(after.get("Visiteur 1234")?.manager_id === id("Hugo"), "les visiteurs rejoignent l'équipe du lead dev")
      assert(res.skills === 5 && (await old.listSkills()).find((x) => x.name === "deployer-fournil")?.version === 3, "les skills de démo sont ajoutés")
      assert(after.get("Hugo Bernard")?.can_publish_skills === true && after.get("Inès Lefèvre")?.can_publish_skills === false, "Hugo et Jean-Marc reçoivent le droit de publier")
      assert((await old.listItems({})).length === itemsBefore && visitor.id === after.get("Visiteur 1234")?.id, "rien n'est effacé")
      await old.updateProfile(id("Inès"), { manager_id: id("Claire") })
      const again = await upgradeDemoBrain(old)
      assert(again.managers === 0 && again.skills === 0 && (await old.getProfile(id("Inès")))?.manager_id === id("Claire"), "relancé : ne touche plus aux choix d'un admin")
      assert((await demoVisitorManager(old)) === id("Hugo"), "un nouveau visiteur est rattaché au lead dev")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log("\n— Écriture libre, droit de regard de l'auteur (D1)")
  const jmDev = await ingestItems(jm, [item("dev", `Smoke ${run} déploiement Vercel par la compta`, "procedure")])
  created.push(...jmDev.ids)
  assert(jmDev.inserted === 1 && jmDev.zones.join() === "dev", "tout le monde nourrit le cerveau : Jean-Marc (compta) écrit en dev")
  const jmCtx = await getPersonContext(jm, jm.profile.id)
  assert(jmCtx?.items.some((i) => i.id === jmDev.ids[0]), "Mon contexte : Jean-Marc voit son item rangé en dev")
  assert(jmCtx?.unreadable_zones.includes("dev"), "la zone non lisible de son item est signalée")
  const asJm: Viewer = { profile: jm.profile, real: claire.real, access: jm.access }
  assert((await getPersonContext(asJm, jm.profile.id))?.items.some((i) => i.id === jmDev.ids[0]), "« voir en tant que Jean-Marc » montre aussi son item")
  const jmSearch = await queryBrain(jm, { query: `Smoke ${run} déploiement Vercel` })
  assert(jmSearch.items.some((i) => i.id === jmDev.ids[0]), "sa propre recherche retrouve son item")
  assert(jmSearch.items.every((i) => i.zone === "compta" || i.author_id === jm.profile.id), "mais rien d'autre de la zone dev")
  assert(!jmSearch.zones_hit.includes("dev"), "sa recherche n'allume pas (et n'est pas diffusée dans) la zone dev")
  assert((await queryBrain(jm, { query: `Smoke ${run} déploiement`, zones: ["sales"] })).items.length === 0, "le filtre de zones s'applique aussi à ses propres items")
  assert(!(await queryBrain(sarah, { query: `Smoke ${run} déploiement Vercel` })).items.some((i) => i.id === jmDev.ids[0]), "Sarah (sans dev) ne le voit pas")
  assert((await queryBrain(hugo, { query: `Smoke ${run} déploiement Vercel` })).items.some((i) => i.id === jmDev.ids[0]), "Hugo (dev) le voit")
  const jmItem = await store.getItem(jmDev.ids[0])
  assert(jmItem && itemAuthorOrAdmin(jm, jmItem) && !itemAuthorOrAdmin(hugo, jmItem), "seul l'auteur (ou un admin) peut le supprimer")

  console.log("\n— Déduplication à l'ingestion (D6)")
  const again = await ingestItems(jm, [item("dev", `SMOKE ${run}  Déploiement vercel par la COMPTA`, "procedure")])
  assert(again.inserted === 0 && again.skipped === 1, "même auteur, même zone, même titre normalisé : ignoré")
  const dup = await ingestItems(hugo, [item("dev", `Smoke ${run} doublon`), item("dev", `smoke ${run} doublon`), item("produit", `Smoke ${run} doublon`)])
  created.push(...dup.ids)
  assert(dup.inserted === 2 && dup.skipped === 1, "doublon dans un même lot ignoré, même titre dans une autre zone gardé")
  const sameTitle = `Smoke ${run} claude — fournil`
  const fact1 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "On a décidé de passer à Pennylane." }])
  const fact2 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "On a aussi décidé de garder Qonto pour la trésorerie." }])
  created.push(...fact1.ids, ...fact2.ids)
  assert(fact1.inserted === 1 && fact2.inserted === 1 && fact2.skipped === 0, "même titre mais contenu différent : les deux faits sont gardés (E1)")
  const fact3 = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "On a aussi  décidé de garder QONTO pour la trésorerie. " }])
  assert(fact3.inserted === 0 && fact3.skipped === 1, "même titre et même contenu (normalisés) : ignoré")
  const partly = await ingestItems(hugo, [{ ...item("dev", sameTitle), body: "On a décidé de passer à Pennylane." }, item("produit", `Smoke ${run} idée produit`)])
  created.push(...partly.ids)
  assert(partly.inserted === 1 && partly.skipped === 1 && partly.zones.join() === "produit", "réponse d'ingestion : seules les zones qui ont vraiment reçu un item")

  console.log("\n— Événements d'écriture par zone et résumés (D2)")
  const batch = await ingestItems(claire, [item("compta", `Smoke ${run} trésorerie : 2 mois de cash restants`), item("dev", `Smoke ${run} migration Postgres des précommandes`)])
  created.push(...batch.ids)
  const writes = (await store.listEvents({ limit: 20, type: "write" })).filter((e) => e.user_id === claire.profile.id && e.summary?.includes(`Smoke ${run}`))
  const comptaWrite = writes.find((e) => e.zones.join() === "compta")
  const devWrite = writes.find((e) => e.zones.join() === "dev")
  assert(writes.length === 2 && comptaWrite && devWrite, "un lot sur deux zones émet un événement d'écriture par zone")
  assert(comptaWrite!.summary!.includes("trésorerie") && !devWrite!.summary!.includes("trésorerie"), "chaque résumé ne cite que les items de sa zone")
  const hugoState = await getState(hugo)
  const hugoSeesCompta = hugoState.events.find((e) => e.id === comptaWrite!.id)
  assert(hugoSeesCompta && !hugoSeesCompta.summary && hugoSeesCompta.restricted, "Hugo (sans compta) voit l'écriture compta sans son résumé")
  assert(hugoState.events.find((e) => e.id === devWrite!.id)?.summary?.includes("migration"), "Hugo voit le résumé de l'écriture dev")
  const [multi] = await recordEvents(claire, [{ agent: "mcp", type: "query", zones: ["dev", "compta"], summary: `Smoke ${run} multi-zone` }])
  assert(!redactEvent(multi, hugo.access, hugo.profile.id).summary && !redactEvent(multi, jm.access, jm.profile.id).summary, "événement sur dev+compta : résumé caché à qui ne lit pas les deux")
  assert(redactEvent(multi, claire.access, hugo.profile.id).summary, "l'admin voit le résumé")

  const personal = "écris une lettre à mon médecin à cause de ma dépression et de mon divorce"
  const [priv] = await recordEvents(hugo, [{ agent: "mcp", type: "query", summary: personal, fingerprint: "fp-smoke", session_id: "s-smoke" }])
  assert(priv.zones.length === 0, "un texte personnel n'est rattaché à aucune zone")
  const jmView = (await getState(jm)).events.find((e) => e.id === priv.id)
  assert(jmView && !jmView.summary && !jmView.fingerprint && !jmView.session_id && jmView.restricted_reason === "private", "événement sans zone : ni résumé, ni empreinte, ni session pour les autres")
  assert((await getState(hugo)).events.find((e) => e.id === priv.id)?.summary === personal, "l'auteur voit son propre événement")
  const [hookPersonal, hookOff] = await recordEvents(hugo, [
    { agent: "claude-code", type: "query", summary: personal, fingerprint: "fp-perso" },
    { agent: "claude-code", type: "query", summary: "raconte-moi une blague sur les chats", fingerprint: "fp-blague" },
  ])
  assert(!hookPersonal.summary && hookPersonal.fingerprint === "fp-perso", "prompt personnel (hook) : empreinte seule, pas de résumé stocké")
  assert(!hookOff.summary && hookOff.zones.length === 0, "prompt hors zone (hook) : pas de résumé stocké")
  const [dupZones] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev", "dev", "produit", "dev"], summary: `Smoke ${run} zones` }])
  assert(dupZones.zones.join() === "dev,produit", "zones d'un événement dédoublonnées")

  console.log("\n— Recherches : texte gardé seulement sans zone illisible ni contenu personnel (E2)")
  const lastEvent = async (v: Viewer) => (await store.listEvents({ userId: v.real.id, limit: 1 }))[0]
  const inesQuery = await queryBrain(ines, { query: "quel est le salaire urssaf" })
  assert(inesQuery.zones_hit.length === 0 && inesQuery.zones_restricted.includes("compta"), "recherche d'Inès sur la compta : rien de lisible")
  const inesEvent = await lastEvent(ines)
  const sarahView = (await getState(sarah)).events.find((e) => e.id === inesEvent?.id)
  assert(inesEvent && !inesEvent.summary && sarahView && !sarahView.summary, "cette recherche n'est ni conservée ni diffusée à Sarah")
  const mixedText = "licenciement de Hugo et son salaire, prévoir la mise à jour du déploiement"
  const mixed = await queryBrain(ines, { query: mixedText })
  const mixedEvent = await lastEvent(ines)
  assert(mixed.zones_hit.includes("dev") && mixed.zones_restricted.includes("compta"), "recherche d'Inès sur dev ET compta : dev s'allume, compta signalée")
  assert(mixedEvent.zones.join() === mixed.zones_hit.join() && !mixedEvent.summary, "l'événement garde les zones allumées, sans le texte de la recherche")
  const leo = await viewer("Léo")
  assert(
    !redactEvent(mixedEvent, leo.access, leo.profile.id).summary && !(await getState(hugo)).events.find((e) => e.id === mixedEvent.id)?.summary,
    "Léo et Hugo (dev, sans compta) ne lisent pas ce texte",
  )
  await queryBrain(hugo, { query: "écris une lettre à mon médecin pour ma dépression, et le déploiement" })
  const persoEvent = await lastEvent(hugo)
  assert(persoEvent.zones.includes("dev") && !persoEvent.summary, "recherche personnelle : zone allumée, texte non conservé")
  await queryBrain(hugo, { query: `Smoke ${run} déployer en production` })
  assert((await lastEvent(hugo)).summary === `Smoke ${run} déployer en production`, "recherche dans ses zones, sans rien de personnel : texte conservé")
  const both = `Smoke ${run} imprimante de tickets du support et déploiement`
  await queryBrain(hugo, { query: both })
  const bothEvent = await lastEvent(hugo)
  assert(bothEvent.summary === both && bothEvent.zones.includes("dev") && bothEvent.zones.includes("support"), "texte conservé : l'événement porte toutes les zones touchées (dev + support)")
  assert(!redactEvent(bothEvent, ines.access, ines.profile.id).summary, "Inès (dev sans support) ne lit pas ce texte qui parle aussi du support")
  await queryBrain(claire, { query: "salaire urssaf et déploiement vercel" })
  assert((await lastEvent(claire)).summary === "salaire urssaf et déploiement vercel", "l'admin lit toutes les zones : texte conservé")
  const jmOwn = await queryBrain(jm, { query: `Smoke ${run}` })
  assert(jmOwn.items.some((i) => i.id === jmDev.ids[0]) && !(await lastEvent(jm)).summary, "recherche qui retrouve son propre item rangé dans une zone non lisible : texte non conservé")

  console.log("\n— « Où en est la boîte » limité aux zones lisibles (D4)")
  const jmStatus = await statusForViewer(jm)
  assert(jmStatus && jmStatus.zones.every((z) => z.zone === "compta"), "Jean-Marc ne reçoit que la zone compta")
  assert(jmStatus && jmStatus.headline !== status.headline && jmStatus.headline.startsWith(`Dans votre zone (${zoneName("compta")})`), `titre recalculé sur sa zone : « ${jmStatus?.headline} »`)
  assert((await getState(jm)).status?.headline === jmStatus?.headline, "même titre dans l'état du dashboard")
  assert((await statusForViewer(hugo))?.headline.startsWith("Dans vos zones ("), "Hugo : titre sur ses trois zones")
  assert((await statusForViewer(claire))?.headline === status.headline, "l'admin garde le titre global")

  console.log("\n— API : automatisations remontées par Screenpipe")
  const hugoSession = await createSessionValue(hugo.profile.id)
  const claireSession = await createSessionValue(claire.profile.id)
  const wf = await call(automationsRoute.POST, "/api/automations", {
    method: "POST",
    session: hugoSession,
    body: {
      workflows: [
        {
          id: `smoke-${run}`,
          title: "Relancer marie.durand@gmail.com au 06 12 34 56 78",
          description: "Exporter les relevés, clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
          schedule: "chaque lundi, écrire à jean@perso.fr",
          zone: "inconnue",
        },
      ],
    },
  })
  const savedWf = (await store.listAutomations()).find((a) => a.key === `screenpipe:${hugo.profile.id}:smoke-${run}`)
  assert(wf.status === 201 && savedWf, "POST /api/automations enregistre le workflow")
  const wfText = `${savedWf!.title} ${savedWf!.description} ${savedWf!.schedule}`
  assert(!/marie\.durand|06 12 34 56 78|sk-ant|jean@perso/.test(wfText) && wfText.includes("masqué"), `titre, description et horaire masqués côté serveur (« ${savedWf!.title} »)`)
  assert(savedWf!.zone === undefined, "zone inconnue écartée")
  await store.updateAutomation(savedWf!.id, { status: "dismissed" })

  console.log("\n— API : création de zone")
  const existing = zones.find((z) => slugify(z.name) === z.id)!
  const clash = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { name: existing.name.toUpperCase() } })
  const untouched = (await store.listZones()).find((z) => z.id === existing.id)!
  assert(clash.status === 409 && /existe déjà/.test(clash.data?.error ?? ""), `nom déjà pris sans identifiant explicite : 409 (« ${clash.data?.error} »)`)
  assert(untouched.keywords.length === existing.keywords.length && untouched.description === existing.description, "la zone existante n'est pas écrasée")
  const edit = await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: claireSession, body: { id: existing.id, name: existing.name } })
  const edited = (await store.listZones()).find((z) => z.id === existing.id)!
  assert(edit.status === 200 && edited.keywords.length === existing.keywords.length && edited.description === existing.description, "avec son identifiant : mise à jour, mots-clés et description conservés")
  assert((await call(adminZonesRoute.POST, "/api/admin/zones", { method: "POST", session: hugoSession, body: { name: `Smoke ${run}` } })).status === 403, "réservé aux admins (403)")

  console.log("\n— État de l'entreprise produit sur un poste (E4)")
  const originalStatus = await store.getStatus()
  try {
    const denied = await call(statusInputRoute.GET, "/api/status/input", { session: hugoSession })
    assert(denied.status === 403 && denied.data?.error, "GET /api/status/input : réservé aux admins (403)")
    const inputRes = await call(statusInputRoute.GET, "/api/status/input", { session: claireSession })
    const si = inputRes.data as StatusInput
    assert(inputRes.status === 200 && si.company_name === (await store.getOrg()).name && /^\d{4}-\d{2}-\d{2}$/.test(si.generated_for), `matière du résumé : ${si.company_name}, ${si.generated_for}`)
    assert(si.zones.length === zones.length && si.zones.every((z) => z.id && z.name && typeof z.description === "string"), "toutes les zones (id, nom, description)")
    const oldest = Date.now() - 30 * 86400_000 - 60_000
    assert(si.items.length > 0 && si.items.length <= 400 && si.items.every((i) => Date.parse(i.created_at) >= oldest), `connaissances des 30 derniers jours, 400 au plus (${si.items.length})`)
    assert(si.items.every((i, k) => k === 0 || si.items[k - 1].created_at >= i.created_at), "les plus récentes d'abord")
    const names = new Set((await store.listProfiles()).map((p) => p.name))
    assert(si.items.every((i) => names.has(i.author)) && !JSON.stringify(si).includes(hugo.profile.id), "auteur = nom du membre (aucun identifiant)")
    assert(si.tasks.length > 0 && si.tasks.some((t) => t.assignee) && si.tasks.every((t) => (t.status === "open" || t.status === "done") && (!t.assignee || names.has(t.assignee))), "tâches avec le nom de la personne assignée")

    const pushedStatus = {
      headline: `Smoke ${run} : la boîte avance, détails à claire.perso@gmail.com`,
      zones: [
        { zone: "dev", summary: "Mise en prod prête, clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz", objectives: ["Tenir la mise en prod"], progress: "80 %", next_steps: ["Relire la PR"], who_did_what: [{ person: "Hugo Bernard", did: "a migré Postgres" }] },
        { zone: "compta", summary: "Trésorerie : 2 mois de cash", objectives: [], progress: "", next_steps: [], who_did_what: [] },
        { zone: "inconnue", summary: "zone inventée", objectives: [], progress: "", next_steps: [], who_did_what: [] },
        { zone: "dev", summary: "doublon", objectives: [], progress: "", next_steps: [], who_did_what: [] },
      ],
    }
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: hugoSession, body: { status: pushedStatus } })).status === 403, "POST /api/status avec un résumé : réservé aux admins (403)")
    const evBefore = (await store.listEvents({ limit: 1 }))[0]?.id ?? 0
    const pushed = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: pushedStatus } })
    const saved = pushed.data as CompanyStatus
    assert(pushed.status === 200 && saved.generator === "claude" && Math.abs(Date.parse(saved.generated_at) - Date.now()) < 60_000, "résumé du poste enregistré (généré par Claude, maintenant)")
    assert(saved.zones.map((z) => z.zone).join() === "dev,compta", "zones inconnues et doublons écartés")
    assert(!/sk-ant|claire\.perso/.test(JSON.stringify(saved)) && saved.headline.includes("masqué"), "texte masqué côté serveur")
    assert(isDeepStrictEqual(await store.getStatus(), saved), "c'est l'état stocké qui est renvoyé")
    const statusEvent = (await store.listEvents({ afterId: evBefore, limit: 50 })).find((e) => e.agent === "job" && e.summary === "Mise à jour de l'état de l'entreprise")
    assert(statusEvent && statusEvent.zones.length === zones.length && statusEvent.user_id === claire.profile.id, "le même événement « Mise à jour de l'état de l'entreprise » est émis")
    const jmPushed = await statusForViewer(jm)
    assert(jmPushed?.zones.map((z) => z.zone).join() === "compta" && jmPushed.headline !== saved.headline, "Jean-Marc n'en reçoit que la compta, avec son propre titre (D4)")
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, raw: "{pas du json" })).status === 400, "corps illisible : 400")
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: { headline: "x", zones: "dev" } } })).status === 400, "résumé mal formé : 400")
    assert((await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { headline: "Résumé sans enveloppe", zones: [{ zone: "dev" }] } })).status === 400, "résumé sans { status } : 400, pas de recalcul qui l'écraserait")
    const unknownOnly = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: { headline: "x", zones: [{ zone: "inconnue" }] } } })
    assert(unknownOnly.status === 400 && /aucune zone/.test(unknownOnly.data?.error ?? ""), "aucune zone connue : 400")
    assert(isDeepStrictEqual(await store.getStatus(), saved), "un résumé refusé ne remplace pas l'état")
    // Chaîne complète du poste : prompt (cœur) → réponse de `claude -p --output-format json` → parseStatusJson → POST.
    const prompt = buildCliStatusPrompt(si)
    assert(prompt.startsWith(DISTILL_MARKER) && prompt.includes(si.company_name) && si.zones.every((z) => prompt.includes(z.id)), "prompt du poste : marqueur anti-ingestion et matière du serveur")
    const answer = JSON.stringify({
      headline: `Smoke ${run} via le poste`,
      zones: [
        { zone: "dev", summary: "Prod prête", objectives: ["Livrer"], progress: "80 %", next_steps: ["PR"], who_did_what: [{ person: "Hugo Bernard", did: "migration" }] },
        { zone: "zz", summary: "x", objectives: [], progress: "", next_steps: [], who_did_what: [] },
      ],
    })
    const envelope = JSON.stringify({ type: "result", is_error: false, result: `Voici l'état :\n\`\`\`json\n${answer}\n\`\`\`` })
    const parsedReply = parseStatusJson(envelope, si.zones.map((z) => z.id))
    const viaCli = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession, body: { status: parsedReply } })
    assert(
      parsedReply && viaCli.status === 200 && viaCli.data.headline === `Smoke ${run} via le poste` && viaCli.data.zones.map((z: { zone: string }) => z.zone).join() === "dev",
      "réponse de Claude lue par le cœur (parseStatusJson) puis acceptée par POST /api/status",
    )
    const regen = await call(statusRoute.POST, "/api/status", { method: "POST", session: claireSession })
    assert(regen.status === 200 && regen.data.zones.length >= 1 && regen.data.generated_at !== saved.generated_at, `sans corps : régénération côté serveur comme avant (${regen.data.generator})`)
  } finally {
    if (originalStatus) await store.setStatus(originalStatus)
  }

  console.log("\n— Sessions du dashboard (D5)")
  const savedSecret = process.env.BRAIN_SESSION_SECRET
  delete process.env.BRAIN_SESSION_SECRET
  try {
    const secret = await store.getSessionSecret()
    assert(/^[0-9a-f]{64}$/.test(secret), "secret de session aléatoire de 32 octets")
    if (store.kind === "file") {
      const dataDir = path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain")
      assert(((await new FileStore(dataDir).getSessionSecret()) === secret), "le secret est conservé sur disque (relu par une autre instance)")
      assert((fs.statSync(path.join(dataDir, "session-secret")).mode & 0o777) === 0o600, "fichier session-secret en mode 600")
    } else {
      const other = new PostgresStore(process.env.DATABASE_URL!)
      assert((await other.getSessionSecret()) === secret, "le secret est conservé en base (brain_settings, relu par une autre instance)")
      await other.end()
    }
    const legacy = createHash("sha256")
      .update(`company-brain:${process.env.DATABASE_URL ?? ""}:${process.env.BRAIN_DATA_DIR ?? ".brain"}:${process.cwd()}`)
      .digest("hex")
    const exp = String(Date.now() + 3600_000)
    const forged = `${claire.profile.id}.${exp}.${createHmac("sha256", legacy).update(`${claire.profile.id}.${exp}`).digest("base64url")}`
    assert(!(await viewerFromCookies(forged, undefined)), "un cookie admin forgé avec l'ancien secret devinable est refusé")
    const cookie = await createSessionValue(hugo.profile.id)
    assert((await viewerFromCookies(cookie, undefined))?.real.id === hugo.profile.id, "une session signée est acceptée")
    const code = await createLoginCode(hugo.profile.id)
    assert((await verifyLoginCode(code)) === hugo.profile.id, "un lien de connexion (setup) signé est accepté")
    assert(!(await viewerFromCookies(code, undefined)), "un lien de connexion ne vaut pas cookie de session")
    assert(!(await verifyLoginCode(cookie)), "un cookie de session ne vaut pas lien de connexion")
    const [codeUser, , codeSig] = code.split(".")
    assert(!(await verifyLoginCode(`${codeUser}.${Date.now() + 86400_000}.${codeSig}`)), "un lien dont on repousse l'échéance est refusé")
    assert(!(await viewerFromCookies(`${cookie.slice(0, -3)}${cookie.endsWith("AAA") ? "BBB" : "AAA"}`, undefined)), "une signature modifiée est refusée")
    assert((await viewerFromCookies(cookie, jm.profile.id))?.profile.id === hugo.profile.id, "un membre ne peut pas « voir en tant que »")
    const claireCookie = await createSessionValue(claire.profile.id)
    assert((await viewerFromCookies(claireCookie, jm.profile.id))?.profile.id === jm.profile.id, "un admin peut « voir en tant que »")
    const original = await store.getTokenHash(hugo.profile.id)
    await store.updateProfile(hugo.profile.id, { token_hash: hashToken(newToken()) })
    try {
      assert(!(await viewerFromCookies(cookie, undefined)), "régénérer le jeton invalide les sessions existantes")
    } finally {
      await store.updateProfile(hugo.profile.id, { token_hash: original! })
    }
    assert((await viewerFromCookies(cookie, undefined))?.real.id === hugo.profile.id, "jeton restauré : la session redevient valide")
    process.env.BRAIN_SESSION_SECRET = `smoke-${run}-${"x".repeat(40)}`
    assert(!(await viewerFromCookies(cookie, undefined)), "BRAIN_SESSION_SECRET prend le dessus sur le secret stocké")
    assert((await viewerFromCookies(await createSessionValue(hugo.profile.id), undefined))?.real.id === hugo.profile.id, "et signe les nouvelles sessions")
  } finally {
    if (savedSecret === undefined) delete process.env.BRAIN_SESSION_SECRET
    else process.env.BRAIN_SESSION_SECRET = savedSecret
  }

  console.log("\n— Recherche : préfixe seulement pour les mots longs")
  const allZones = zones.map((z) => z.id)
  const pr = await store.searchItems("pr", allZones, 20)
  assert(pr.every((i) => tokenize(`${i.title} ${i.body} ${i.entities.map((e) => e.name).join(" ")}`).includes("pr")), `« pr » ne trouve que le mot exact (${pr.length} résultat(s))`)
  assert((await store.searchItems("deplo", allZones, 5)).length > 0, "« deplo » trouve « déployer » (préfixe ≥ 4 lettres)")

  console.log("\n— Flux temps réel")
  const latest = (await store.listEvents({ limit: 1 }))[0]?.id ?? 0
  assert((await streamStartId(latest + 100_000)) === latest, "?after= au-delà du dernier événement (cerveau réinitialisé) : repart du dernier")
  assert((await streamStartId(null)) === latest && (await streamStartId(Math.max(0, latest - 3))) === Math.max(0, latest - 3), "?after= valide respecté")
  assert((await streamStartId(0)) >= latest - 200, "rattrapage borné pour un ?after= trop ancien")
  const poller = createEventPoller(latest)
  const [ev1] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} flux` }])
  const got = await poller.poll()
  assert(got.some((e) => e.id === ev1.id) && !(await poller.poll()).some((e) => e.id === ev1.id), "le flux livre chaque événement une seule fois")
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
        values (${org.id}, ${hugo.profile.id}, 'mcp', 'query', ${tx.array(["dev"])}, ${`Smoke ${run} lent`}, now()) returning id`
      slowId = Number(r.id)
      await held
    })
    while (!slowId) await sleep(10)
    const [fast] = await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} rapide` }])
    const first = await poller.poll()
    assert(fast.id > slowId && first.some((e) => e.id === fast.id) && !first.some((e) => e.id === slowId), "Postgres : un id plus grand est validé avant un id plus petit")
    release()
    await slow
    const second = await poller.poll()
    assert(second.some((e) => e.id === slowId), "l'événement validé en retard est quand même livré")
    assert(!(await poller.poll()).some((e) => e.id === slowId || e.id === fast.id), "sans doublon")
    await sql.end({ timeout: 5 })

    console.log("\n— Postgres : organisation relue (reseed, onboarding sur une autre instance)")
    const other = new PostgresStore(url)
    const orgBefore = await store.getOrg()
    await other.updateOrg({ name: `${orgBefore.name} (smoke)` })
    await sleep(5200)
    const seen = (await store.getOrg()).name
    await other.updateOrg({ name: orgBefore.name })
    await other.end()
    assert(seen === `${orgBefore.name} (smoke)`, "une instance voit le changement d'organisation fait ailleurs, sans redémarrer")

    console.log("\n— Postgres : table brain_settings absente (migration non appliquée)")
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
      assert((await viewerFromCookies(oldCookie, undefined)) === null, "session invérifiable : refusée sans planter (retour à la connexion)")
      assert((await call(stateRoute.GET, "/api/state", { session: oldCookie })).status === 401, "route du dashboard : 401 et non 500")
      let setupErr: unknown
      await createSessionValue(hugo.profile.id).catch((err) => (setupErr = err))
      assert(isStoreSetupError(setupErr) && setupErr.status === 503 && /db:migrate/.test(setupErr.message), "connexion : erreur de configuration claire")
      process.env.BRAIN_DEMO = "1"
      const login = await call(demoSessionRoute.POST, "/api/session/demo", { method: "POST", body: { userId: hugo.profile.id } })
      assert(login.status === 503 && /migrations/.test(login.data?.error ?? ""), `POST /api/session/demo : 503 (« ${login.data?.error} »)`)
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
    assert((await viewerFromCookies(oldCookie, undefined))?.real.id === hugo.profile.id, "table rétablie : la session redevient valide")

    console.log("\n— Postgres : reset atomique, jamais d'organisation parasite (E3)")
    await orgRaceTest(url, run)
  }

  if (store.kind === "file") {
    console.log("\n— Stockage fichier : plusieurs processus écrivent en même temps")
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
              child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`écrivain ${tag} : code ${code}`))))
            }),
        ),
      )
      const all = await copy.listEvents({ sinceIso: "1970-01-01", limit: 100_000 })
      assert(all.length === eventsBefore + 3 * n, `aucune écriture perdue (${all.length - eventsBefore}/${3 * n} événements)`)
      assert(new Set(all.map((e) => e.id)).size === all.length, "aucun identifiant d'événement réutilisé")
      assert((await copy.listItems({ limit: 100_000 })).length === itemsBefore + 3 * Math.ceil(n / 10), "aucun item perdu")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log("\n— Créer son entreprise (/creer) : un cerveau à part")
  {
    const root = getRootStore()
    const fournil = await root.getOrg()
    const tenantsBefore = await root.countTenantOrgs()
    const acme = await root.createTenantOrg({
      name: `Acme ${run}`,
      description: "Test de fumée",
      zones: [{ id: "ops", name: "Ops", description: "", color: "#2a78d6", keywords: ["ops", "astreinte"], position: 0 }],
    })
    const acmeStore = storeForOrg(acme.id)
    try {
      assert((await root.countTenantOrgs()) === tenantsBefore + 1, "une entreprise créée est comptée")
      assert((await root.getOrg()).id === fournil.id && !(await root.isEmpty()), "le cerveau de la base reste celui de Fournil")
      assert((await acmeStore.listZones()).map((z) => z.id).join() === "ops", "la nouvelle entreprise n'a que ses zones")
      const token = newToken()
      const boss = await acmeStore.createProfile({ name: `Alice ${run}`, role: "admin", manager_id: null, token_hash: hashToken(token) })
      assert(boss.org_id === acme.id, "son premier compte lui appartient")
      assert((await profileFromToken(token))?.id === boss.id, "son jeton est reconnu (connexion du poste)")
      const cookie = await createSessionValue(boss.id)
      const alice = await viewerFromCookies(cookie, claire.profile.id)
      assert(alice?.real.id === boss.id && alice.profile.id === boss.id, "sa session est reconnue ; « voir en tant que » ne sort pas de son entreprise")
      assert(!(await store.listProfiles()).some((p) => p.id === boss.id), "Fournil ne voit pas ce compte")

      const st = await call(stateRoute.GET, "/api/state", { session: cookie })
      assert(st.status === 200 && st.data.zones.map((z: { id: string }) => z.id).join() === "ops" && st.data.items.length === 0, "son dashboard ne montre que son entreprise")
      const inv = await call(adminUsersRoute.POST, "/api/admin/users", { method: "POST", session: cookie, body: { name: `Bob ${run}`, zones: ["ops", "dev"] } })
      assert(inv.status === 201 && inv.data.prompt.includes(`Acme ${run}`) && inv.data.prompt.includes(" ops."), "inviter un collègue : prompt à son nom, zones de l'entreprise seulement")
      assert((await acmeStore.listProfiles()).length === 2 && !(await store.listProfiles()).some((p) => p.id === inv.data.profile.id), "le collègue rejoint l'entreprise, pas Fournil")

      const bob = (await profileFromToken(inv.data.token))!
      const bobViewer: Viewer = { profile: bob, real: bob, access: await getAccess(bob) }
      const team0 = await call(adminTeamRoute.GET, "/api/admin/team", { session: cookie })
      assert(team0.status === 200 && team0.data.users.every((u: { last_at: string | null }) => u.last_at === null), "équipe : personne n'est encore branché")
      await runInOrg(acme.id, () => recordEvents(bobViewer, [{ agent: "claude-code", type: "started" }]))
      const team1 = await call(adminTeamRoute.GET, "/api/admin/team", { session: cookie })
      assert(team1.data.users.find((u: { id: string }) => u.id === bob.id)?.last_at, "équipe : le poste de Bob apparaît branché")

      const ing = await runInOrg(acme.id, () => ingestItems(bobViewer, [item("ops", `Procédure d'astreinte Acme (${run})`)]))
      assert((await acmeStore.getItem(ing.ids[0]))?.zone === "ops", "une connaissance du poste de Bob arrive dans l'entreprise")
      const fromFournil = await queryBrain(claire, { query: `astreinte Acme ${run}` })
      assert(fromFournil.items.every((i) => i.org_id === fournil.id), "Fournil n'en voit rien")
      const fromAcme = await runInOrg(acme.id, () => queryBrain(alice!, { query: "déployer en production" }))
      assert(fromAcme.items.length === 0, "et l'entreprise ne voit rien de Fournil")
      const fournilItem = created[0]
      const del = await itemRoute.DELETE(new Request(`http://smoke.test/api/items/${fournilItem}`, { method: "DELETE", headers: { cookie: `brain_session=${cookie}` } }), {
        params: Promise.resolve({ id: fournilItem }),
      })
      assert(del.status === 404 && (await store.getItem(fournilItem)), "une connaissance de Fournil est introuvable (et intacte) depuis l'entreprise")
      console.log("\n— Message d'équipe : demander à rejoindre, un admin accepte")
      const decide = (id: string, session: string, body: unknown) =>
        adminJoinIdRoute.POST(new Request(`http://smoke.test/api/admin/join/${id}`, { method: "POST", headers: { cookie: `brain_session=${session}`, "content-type": "application/json" }, body: JSON.stringify(body) }), {
          params: Promise.resolve({ id }),
        })
      const team = await call(adminJoinRoute.GET, "/api/admin/join", { session: cookie })
      assert(team.status === 200 && team.data.prompt.includes(team.data.code) && team.data.prompt.includes("Tu vas demander à rejoindre NOS Brainer"), "un message d'équipe par entreprise, avec son code")
      assert((await call(adminJoinRoute.GET, "/api/admin/join", { session: cookie })).data.code === team.data.code, "le code reste le même d'une ouverture à l'autre")
      const leaToken = newToken()
      const unknown = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: `cj_${"x".repeat(24)}`, token_hash: hashToken(leaToken) } })
      assert(unknown.status === 404, "un code inconnu ne crée rien")
      const asked = await call(joinRoute.POST, "/api/join", {
        method: "POST",
        body: { code: team.data.code, name: "Léa Test", title: "<poste>", email: "pas un email", hostname: "mac-lea", token_hash: hashToken(leaToken) },
      })
      assert(asked.status === 201 && asked.data.org === acme.name, "la demande arrive dans l'entreprise du code")
      const [pending] = await acmeStore.listJoinRequests({ status: "pending" })
      assert(pending?.name === "Léa Test" && pending.title === null && pending.email === null && pending.hostname === "mac-lea", "ce que son Claude ne savait pas reste vide (gabarit « <poste> » compris)")
      assert((await profileFromToken(leaToken)) === null, "aucun accès avant l'acceptation")
      const status0 = await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: leaToken } })
      assert(status0.status === 200 && status0.data.status === "pending", "le poste suit sa demande : en attente")
      assert((await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: newToken() } })).status === 404, "personne d'autre ne peut suivre la demande")
      const fournilAdmin = await createSessionValue(claire.profile.id)
      assert((await call(adminJoinRoute.GET, "/api/admin/join", { session: fournilAdmin })).data.requests.every((r: { id: string }) => r.id !== asked.data.id), "Fournil ne voit pas la demande")
      assert((await decide(asked.data.id, fournilAdmin, { action: "accept", name: "Intrus" })).status === 404, "ni ne peut l'accepter")
      const accepted = await decide(asked.data.id, cookie, { action: "accept", name: "Léa Bernard", title: "Designer", zones: ["ops"], manager_id: boss.id })
      assert(accepted.status === 200, "un admin de l'entreprise complète et accepte")
      const lea = await profileFromToken(leaToken)
      assert(lea?.name === "Léa Bernard" && lea.title === "Designer" && lea.org_id === acme.id && lea.manager_id === boss.id, "le jeton du poste ouvre son compte, tel que l'admin l'a réglé")
      assert((await acmeStore.listZoneAccess(lea!.id)).map((a) => a.zone_id).join() === "ops", "avec les zones choisies")
      const status1 = await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: asked.data.id, token: leaToken } })
      assert(status1.data.status === "accepted", "le poste voit l'acceptation (et enchaîne sur setup)")
      assert((await decide(asked.data.id, cookie, { action: "reject" })).status === 409, "une demande se traite une seule fois")
      const noName = newToken()
      const anon = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: team.data.code, token_hash: hashToken(noName) } })
      assert((await decide(anon.data.id, cookie, { action: "reject" })).status === 200, "une demande se refuse")
      assert((await call(joinStatusRoute.POST, "/api/join/status", { method: "POST", body: { id: anon.data.id, token: noName } })).data.status === "rejected", "et le poste le sait")
      const rotated = await call(adminJoinRoute.POST, "/api/admin/join", { method: "POST", session: cookie, body: { rotate: true } })
      assert(rotated.status === 200 && rotated.data.code !== team.data.code, "changer le code")
      const stale = await call(joinRoute.POST, "/api/join", { method: "POST", body: { code: team.data.code, token_hash: hashToken(newToken()) } })
      assert(stale.status === 404, "l'ancien message ne marche plus")

      console.log("\n— Onboarding préparé par Claude Code ou Codex")
      const agent = await call(onboardingAgentRoute.POST, "/api/onboarding/agent", { method: "POST", session: cookie })
      const sendCode = agent.data.prompt.match(/Bearer (co_[A-Za-z0-9_-]+)/)?.[1] as string
      assert(agent.status === 200 && sendCode && agent.data.prompt.includes("~/.codex/sessions"), "prompt d'onboarding avec un code d'envoi")
      const upload = (code: string, body: unknown) =>
        onboardingImportRoute.POST(new Request("http://smoke.test/api/onboarding/import", { method: "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
      const proposal = {
        source: "codex",
        company_name: `Acme ${run}`,
        description: "Studio de design. Contact : alice@acme.example",
        zones: [{ id: "ops", name: "Ops", description: "Exploitation", keywords: ["astreinte"] }, { id: "design", name: "Design", description: "Maquettes", keywords: ["figma"] }],
        items: [{ zone: "design", kind: "procedure", title: `Livrer une maquette (${run})`, body: "Export Figma puis revue. Clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz", entities: [{ type: "tool", name: "Figma" }], source: { app: "onboarding", tool: "onboarding" }, confidence: 0.8 }],
      }
      assert((await upload(`co_${"A".repeat(40)}`, proposal)).status === 401, "un code inventé est refusé")
      assert((await upload(await createOnboardingCode(bob.id), proposal)).status === 401, "le code d'un membre (non admin) est refusé")
      assert((await upload(sendCode, { ...proposal, items: [{ zone: "x" }] })).status === 400, "une proposition mal formée est refusée")
      const sent = await upload(sendCode, proposal)
      assert(sent.status === 201, "l'agent dépose sa proposition")
      const pendingDraft = (await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: cookie })).data.draft
      assert(pendingDraft?.source === "codex" && pendingDraft.items.length === 1, "la page Onboarding la retrouve (elle se remplit toute seule)")
      assert(!JSON.stringify(pendingDraft).includes("sk-ant") && !JSON.stringify(pendingDraft).includes("alice@"), "secrets et emails masqués dès la réception")
      assert((await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: fournilAdmin })).data.draft === null, "Fournil ne la voit pas")
      assert((await acmeStore.listZones()).every((z) => z.id !== "design"), "rien n'est appliqué avant validation")
      const { source: _src, ...validated } = pendingDraft
      const applied = await call(onboardingApplyRoute.POST, "/api/onboarding/apply", { method: "POST", session: cookie, body: validated })
      assert(applied.status === 200 && (await acmeStore.listZones()).some((z) => z.id === "design"), "validée : zones et connaissances appliquées")
      assert((await call(onboardingImportRoute.GET, "/api/onboarding/import", { session: cookie })).data.draft === null, "et la proposition est écartée")

      console.log("\n— Nouvelles zones créées automatiquement (job quotidien)")
      {
        const carolRow = await acmeStore.createProfile({ name: `Carol ${run}`, role: "member", manager_id: null, token_hash: hashToken(newToken()) })
        const carol: Viewer = { profile: carolRow, real: carolRow, access: await getAccess(carolRow) }
        const zonesBefore = await acmeStore.listZones()
        const opsBefore = (await acmeStore.listItems({ zones: ["ops"] })).length
        const legal = ["Modèle de contrat de prestation", "CGV : clause de résiliation", "Registre RGPD des traitements", "Mentions légales du site"]
        await runInOrg(acme.id, async () => {
          await ingestItems(alice!, Array.from({ length: 9 }, (_, n) => item("ops", `Astreinte Acme semaine ${n + 1} (${run})`)))
          await ingestItems(alice!, legal.slice(0, 3).map((t) => item("ops", `${t} (${run})`)))
          await ingestItems(carol, [item("ops", `${legal[3]} (${run})`, "task")])
        })
        const legalRefs = (input: NewZonesInput) => input.items.filter((i) => legal.some((t) => i.title.startsWith(t))).map((i) => i.ref)
        let seen: NewZonesInput | null = null
        const proposeLegal = async (input: NewZonesInput) => {
          seen = input
          return [{ name: "Juridique", description: "Contrats, CGV et conformité RGPD.", keywords: ["contrat", "cgv", "rgpd", "juridique"], items: legalRefs(input) }]
        }
        const first = await runInOrg(acme.id, () => runNewZones({ propose: proposeLegal }))
        assert(legalRefs(seen!).length === 4 && seen!.zones.length === zonesBefore.length, "Claude relit les connaissances récentes et les zones existantes")
        assert(first.status === "created" && first.zones[0].id === "juridique" && first.zones[0].items === 4, "la zone Juridique est créée, ses 4 connaissances y sont rangées")
        const juridique = (await acmeStore.listZones()).find((z) => z.id === "juridique")
        const lastPosition = Math.max(...zonesBefore.map((z) => z.position))
        assert(juridique && juridique.keywords.includes("rgpd") && juridique.position === lastPosition + 1, "avec ses mots-clés, après les zones existantes")
        assert((await acmeStore.listItems({ zones: ["juridique"] })).length === 4 && (await acmeStore.listItems({ zones: ["ops"] })).length === opsBefore + 9, "les autres connaissances restent dans Ops")
        assert((await acmeStore.listTasks({ zones: ["juridique"] })).some((t) => t.title.startsWith(legal[3])), "la tâche issue d'une connaissance déplacée la suit")
        const readable = async (id: string) => (await acmeStore.listZoneAccess(id)).map((a) => a.zone_id).sort().join()
        assert((await readable(bob.id)).split(",").includes("juridique"), "Bob, qui lisait Ops, lit aussi Juridique")
        assert((await readable(carolRow.id)) === "juridique", "Carol, autrice d'une des connaissances, la lit aussi")
        const ev = (await acmeStore.listEvents({ limit: 5 })).find((e) => e.agent === "job" && e.type === "write")
        assert(ev?.zones.join() === "juridique" && ev.summary?.includes("Juridique"), "la nouvelle zone s'allume dans le fil d'activité")
        const again = await runInOrg(acme.id, () => runNewZones({ propose: proposeLegal }))
        assert(again.status === "unchanged" && (await acmeStore.listZones()).length === zonesBefore.length + 1, "le lendemain, la même proposition ne double pas la zone")
        const log = await call(adminNewZonesRoute.GET, "/api/admin/zones/auto", { session: cookie })
        assert(log.status === 200 && log.data.runs.map((r: { status: string }) => r.status).join() === "unchanged,created", "les admins voient l'historique des passages")
        const bobSession = await createSessionValue(bob.id)
        assert((await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", { method: "POST", session: bobSession })).status === 403, "lancer un passage est réservé aux admins")

        // Passage fait par le Claude Code de l'entreprise (brain refresh-zones, abonnement) : matière, puis proposition par identifiants.
        assert((await call(adminNewZonesInputRoute.GET, "/api/admin/zones/auto/input", { session: bobSession })).status === 403, "la matière est réservée aux admins")
        const material = await call(adminNewZonesInputRoute.GET, "/api/admin/zones/auto/input", { session: cookie })
        const astreintes = (material.data.input?.items ?? []).filter((i: { title: string }) => i.title.startsWith("Astreinte Acme")).map((i: { id: string }) => i.id)
        assert(material.status === 200 && astreintes.length === 9, "le Claude Code de l'entreprise reçoit les connaissances récentes, avec leurs identifiants")
        assert((await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", { method: "POST", session: cookie, body: { zones: "rh" } })).status === 400, "une proposition mal formée est refusée")
        const agent = await call(adminNewZonesRoute.POST, "/api/admin/zones/auto", {
          method: "POST",
          session: cookie,
          body: { zones: [{ name: "Astreintes", description: "Planning d'astreinte.", keywords: ["astreinte"], item_ids: [...astreintes.slice(0, 4), "inventé"] }] },
        })
        assert(agent.status === 200 && agent.data.status === "created" && agent.data.via === "claude-code" && agent.data.zones[0].items === 4, "sa proposition est appliquée, un identifiant inventé ne désigne rien")

        const cron = (headers: Record<string, string> = {}, qs = "") => cronNewZonesRoute.GET(new Request(`http://smoke.test/api/cron/new-zones${qs}`, { headers }))
        const prevSecret = process.env.CRON_SECRET
        try {
          delete process.env.CRON_SECRET
          assert((await cron({ authorization: "Bearer x" })).status === 503, "cron : fermé tant que CRON_SECRET n'est pas défini")
          process.env.CRON_SECRET = `secret-${run}`
          assert((await cron({ authorization: "Bearer mauvais" })).status === 401, "cron : mauvais secret refusé")
          if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
            const res = await cron({ authorization: `Bearer secret-${run}` }, "?force=1")
            const body = (await res.json()) as { ran: boolean; orgs: { org_id: string; status: string; reason?: string }[] }
            const acmeRun = body.orgs.find((o) => o.org_id === acme.id)
            assert(res.status === 200 && body.orgs[0].org_id === fournil.id && acmeRun?.reason === "no_claude", "cron : toutes les entreprises sont passées en revue ; sans clé API, rien n'est créé")
          }
        } finally {
          if (prevSecret === undefined) delete process.env.CRON_SECRET
          else process.env.CRON_SECRET = prevSecret
        }

        console.log("\n— Clé API Claude de l'entreprise")
        const fakeKey = `sk-ant-api03-${"x".repeat(30)}${run}AbCd`
        const claudeRoute = (method: "GET" | "PUT" | "DELETE", session: string, body?: unknown) => call(adminClaudeRoute[method], "/api/admin/claude", { method, session, body })
        assert((await claudeRoute("GET", bobSession)).status === 403, "réservé aux admins")
        assert((await claudeRoute("PUT", cookie, { key: "sk-proj-pas-une-cle-claude-1234567890" })).status === 400, "une clé qui n'est pas une clé Claude est refusée")
        const unchecked = await claudeRoute("PUT", cookie, { key: fakeKey })
        assert([400, 502].includes(unchecked.status) && !(await acmeStore.getOrgSetting("claude-api-key")), "une clé refusée par Anthropic (ou invérifiable) n'est pas enregistrée")
        await setOrgClaudeKey(acmeStore, fakeKey, boss.id)
        const raw = (await acmeStore.getOrgSetting("claude-api-key")) ?? ""
        assert(raw && !raw.includes(fakeKey.slice(14)), "la clé est chiffrée dans les réglages de l'entreprise")
        assert((await getOrgClaudeKey(acmeStore)) === fakeKey && (await getClaude(acmeStore)) !== null, "le serveur la relit pour les appels de l'entreprise")
        const info = await claudeRoute("GET", cookie)
        assert(info.status === 200 && info.data.source === "org" && info.data.last4 === "AbCd" && !JSON.stringify(info.data).includes(fakeKey), "l'admin n'en voit que les 4 derniers caractères")
        assert(!(await getOrgClaudeKey(store)), "Fournil n'a pas la clé d'Acme")
        const removed = await claudeRoute("DELETE", cookie)
        assert(removed.status === 200 && removed.data.source !== "org" && !(await getOrgClaudeKey(acmeStore)), "l'admin peut la retirer")
      }

      const demoList = await call(demoSessionRoute.GET, "/api/session/demo")
      assert(demoList.status === 404 || !demoList.data.users.some((u: { id: string }) => u.id === boss.id), "les comptes de l'entreprise ne sont pas proposés dans la démo")
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

  console.log("\n— Onboarding : protection SSRF")
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "fec0::1", "fc00::1", "fd12:3456::1", "fe80::1%eth0", "ff02::1", "2002:7f00:1::1", "2001:db8::1", "2001::1", "n'importe quoi"])
    if (!isBlockedAddress(ip)) throw new Error(`ÉCHEC : ${ip} devrait être refusée`)
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4007:80e::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])
    if (isBlockedAddress(ip)) throw new Error(`ÉCHEC : ${ip} devrait être acceptée`)
  console.log("✓ adresses internes refusées (IPv4, IPv6, IPv4 mappée, NAT64, 6to4, site local…), adresses publiques acceptées")
  for (const raw of ["http://[::ffff:7f00:1]:3100/", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[64:ff9b::a9fe:a9fe]/", "http://2130706433/", "http://localhost./", "file:///etc/passwd"]) {
    const page = await scrapeUrl(raw)
    if (!page.error || page.text) throw new Error(`ÉCHEC : ${raw} aurait dû être refusée (${page.error ?? "lue"})`)
  }
  console.log("✓ URL internes refusées avant toute connexion")

  // Faux Internet local : 127.0.0.1 joue l'adresse « publique », 127.0.0.2 l'adresse interne.
  const server = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" })
      return res.end(zlib.gzipSync("<html><head><title>Fournil</title></head><body><p>Logiciel pour boulangeries</p></body></html>"))
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
    assert(okPage.title === "Fournil" && okPage.text.includes("boulangeries"), "une page publique (gzip) est lue")
    const big = await scrapeUrlWith(`http://public.test:${port}/big`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: fakeBlocked })
    assert(!big.error && big.truncated && big.text.length <= 20000, "taille de page bornée")
    const viaIp = await scrapeUrlWith(`http://public.test:${port}/redirect-ip`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: fakeBlocked })
    assert(viaIp.error === "adresse interne refusée", "redirection vers une IP interne refusée")
    let calls = 0
    const rebinding = async () => [{ address: calls++ === 0 ? "127.0.0.1" : "127.0.0.2", family: 4 }]
    const rebound = await scrapeUrlWith(`http://rebind.test:${port}/redirect-name`, { resolve: rebinding, isBlocked: fakeBlocked })
    assert(rebound.error === "adresse interne refusée" && calls === 2, "rebinding DNS : l'adresse est revérifiée à chaque connexion")
    const mixed = await scrapeUrlWith(`http://mixed.test:${port}/page`, {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }],
      isBlocked: fakeBlocked,
    })
    assert(mixed.error === "adresse interne refusée", "un nom qui résout aussi vers une adresse interne est refusé")
    const direct = await scrapeUrlWith(`http://evil.test:${port}/page`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: isBlockedAddress })
    assert(direct.error === "adresse interne refusée", "un nom qui résout vers 127.0.0.1 est refusé à la connexion")
  } finally {
    server.close()
  }

  for (const id of created) await store.deleteItem(id)
  console.log("\n— Supervision : comptes rendus de synchro et état des postes")
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
    error: `Smoke ${run} : jeton expiré`,
  })
  assert((await store.latestSyncReports()).find((r) => r.user_id === hugo.profile.id)?.id === failedReport.id, "le dernier compte rendu de chaque poste est celui qui vient d'arriver")
  assert(posteHealth({ report: failedReport, lastEventAt: null, now: Date.now() }).status === "error", "un poste dont la synchro a échoué est « en erreur »")
  const okReport = await store.saveSyncReport(hugo.profile.id, { ...failedReport, ok: true, error: undefined, items_sent: 3, at: new Date().toISOString() })
  assert(posteHealth({ report: okReport, lastEventAt: null, now: Date.now() }).status === "ok", "puis « à jour » après une synchro réussie")
  assert((await store.listSyncReports({ userId: hugo.profile.id, limit: 10 }))[0]?.id === okReport.id, "historique du poste, le plus récent d'abord")

  console.log("\n— Flux temps réel : le stockage prévient à l'insertion")
  let notified = 0
  const unsubscribe = store.onEvents(hugo.profile.org_id, () => notified++)
  await sleep(store.kind === "postgres" ? 500 : 0)
  await recordEvents(hugo, [{ agent: "mcp", type: "query", zones: ["dev"], summary: `Smoke ${run} notification` }])
  for (let i = 0; i < 30 && notified === 0; i++) await sleep(50)
  unsubscribe()
  if (store.eventNotifyMode() === "local") assert(notified >= 1, "stockage fichier : l'abonné du flux est réveillé")
  else console.log(`· Postgres : mode ${store.eventNotifyMode()}, ${notified} notification(s) reçue(s) (la relecture de sécurité couvre le reste)`)

  console.log("\n— Qualité : décision revue, quasi-doublon écarté, synonymes, entités")
  const qtag = `Smoke ${run} qualité`
  const decision = (body: string, at: number): KnowledgeItemInput => ({
    zone: "dev",
    kind: "decision",
    title: `${qtag} : les webhooks Stripe passent par une file d'attente`,
    body,
    entities: [{ type: "tool", name: "Redis" }],
    source: { app: "Terminal", tool: "claude-code", at: new Date(at).toISOString() },
    confidence: 0.8,
  })
  // Le tag du passage figure aussi dans le corps : un smoke rejoué sur le même stockage ne retrouve pas les décisions du
  // passage précédent comme quasi-doublons.
  const firstDecision = await ingestItems(hugo, [decision(`On met les webhooks Stripe dans une file Redis pour absorber les pics de commandes (passage ${run}).`, Date.now() - 60_000)])
  assert(firstDecision.inserted === 1, "première version de la décision insérée")
  const near = await ingestItems(hugo, [decision(`On met les webhooks Stripe dans une file Redis pour absorber les pics de commandes (passage ${run}) !`, Date.now() - 30_000)])
  assert(near.inserted === 0 && near.skipped === 1, "un quasi-doublon (même contenu à la ponctuation près) est écarté")
  const revised = await ingestItems(hugo, [decision(`Finalement pas de file : les webhooks Stripe sont traités en direct, Redis retiré de l'infra après les tests de charge (passage ${run}).`, Date.now() + 5_000)])
  assert(revised.inserted === 1 && revised.replaced === 1, "une décision revue (même sujet, contenu différent) remplace l'ancienne")
  assert((await store.getItem(firstDecision.ids[0]))?.superseded_by === revised.ids[0], "l'ancienne version porte superseded_by")
  const current = await hybridSearch(`${qtag} file d'attente webhooks`, ["dev"], 5)
  assert(current.some((i) => i.id === revised.ids[0]) && !current.some((i) => i.id === firstDecision.ids[0]), "la recherche ne propose que la version à jour")
  assert(!(await store.listItems({ zones: ["dev"], limit: 50, excludeSuperseded: true })).some((i) => i.id === firstDecision.ids[0]), "les listes du dashboard l'écartent aussi")
  assert((await hybridSearch("how do we ship a release", allZones, 5)).some((i) => /d[ée]ployer/i.test(i.title)), "synonymes FR/EN : « ship a release » trouve « Déployer »")
  const redis = await getEntityContext(hugo, "tool", "redis")
  assert(redis !== null && redis.items.some((i) => i.id === revised.ids[0]) && !redis.items.some((i) => i.id === firstDecision.ids[0]), "la page d'une entité ne cite que les connaissances à jour")
  assert(redis !== null && redis.name === "Redis", "le nom affiché garde sa casse d'origine")
  // Nettoyage : un passage suivant sur le même stockage ne doit pas retrouver ces décisions comme quasi-doublons.
  for (const id of [firstDecision.ids[0], revised.ids[0]]) assert(await store.deleteItem(id), "décision de test supprimée")

  console.log("\n— Connecteurs : tâches externes insérées, mises à jour, fermées")
  // Ne compter que les tâches de ce passage : la boucle de fermeture renvoie aussi les tâches ouvertes d'un passage précédent.
  const mine = (ts: Task[]) => ts.filter((t) => t.external_id?.startsWith(`${run}-`))
  const ext1 = mine(
    await store.upsertExternalTasks("linear", [
      { title: `${qtag} FOU-1`, zone: "dev", status: "open", external_id: `${run}-1`, external_url: "https://linear.app/x/1" },
      { title: `${qtag} FOU-2`, zone: "dev", status: "open", external_id: `${run}-2` },
    ]),
  )
  assert(ext1.length === 2 && ext1.every((t) => t.external_source === "linear"), "deux tâches importées avec leur source")
  const ext2 = await store.upsertExternalTasks("linear", [{ title: `${qtag} FOU-1 renommée`, zone: "dev", status: "open", external_id: `${run}-1`, external_url: "https://linear.app/x/1" }])
  const ext1a = ext2.find((t) => t.external_id === `${run}-1`)
  const ext2a = ext2.find((t) => t.external_id === `${run}-2`)
  assert(ext1a?.title.endsWith("renommée") && ext1a.id === ext1[0].id, "la même tâche est mise à jour, sans doublon")
  assert(ext2a?.status === "done", "une tâche disparue chez l'outil passe faite ici")
  assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.id === ext1a!.id && t.external_url === "https://linear.app/x/1"), "le lien vers l'outil est conservé")
  // Nettoyage : rien d'ouvert de ce passage ne reste pour le suivant.
  assert((await store.updateTask(ext1a!.id, { status: "done" }))?.status === "done", "tâche de test fermée")

  console.log("\n— Modérateur : passage toutes les 15 min (Claude Code du CEO en CI, ou le serveur)")
  {
    const keep = (ref: number) => ({ ref, decision: "publish" as const, category: null, reason: "", zone: null, kind: null, title: null, body: null })
    // Ce qui attendait déjà (seed, passages précédents) est relu d'abord : on vide la file.
    for (let n = 0; n < 50; n++) if ((await runModeration(async (input) => input.items.map((i) => keep(i.ref)))).status !== "done") break
    assert("skipped" in (await moderationInput()), "file du modérateur vide au départ")

    const tag = `Modération ${run}`
    const posted = await ingestItems(hugo, [
      { ...item("dev", `${tag} : les webhooks Stripe passent par une file Redis`, "decision"), body: "Pour absorber les pics de précommandes." },
      { ...item("dev", `${tag} : rendez-vous chez le médecin jeudi`), source: { app: "Screenpipe", tool: "agent", at: new Date().toISOString() } },
      { ...item("dev", `${tag} : TVA à déclarer`), body: "Déclaration avant le 19 du mois." },
    ])
    assert(posted.inserted === 3, "trois connaissances arrivent, publiées tout de suite")
    const [good, perso, tva] = posted.ids
    const material = await moderationInput()
  assert(!("skipped" in material) && [...material.input.items.map((i) => i.id!)].sort().join() === [...posted.ids].sort().join(), "le passage suivant relit exactement ce qui est arrivé")
    assert(!("skipped" in material) && material.input.items[0].author === "Hugo Bernard", "avec le nom de l'auteur")
    const claireSession = await createSessionValue(claire.profile.id)
    const jmSession = await createSessionValue(jm.profile.id)
    assert((await call(adminModerationInputRoute.GET, "/api/admin/moderation/input", { session: jmSession })).status === 403, "réservé aux admins")

    // Décisions de Claude Code (en CI), envoyées par `brain moderate`.
    const verdicts = [
      { id: good, decision: "publish" },
      { id: perso, decision: "reject", category: "personnel", reason: "Rendez-vous médical de l'employé." },
      { id: tva, decision: "edit", zone: "compta", kind: "procedure", title: `${tag} : déclarer la TVA avant le 19` },
    ]
    const applied = await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: posted.ids, verdicts } })
    assert(applied.status === 200 && applied.data.reviewed === 3 && applied.data.edited === 1 && applied.data.rejected === 1, "trois relues, une corrigée, une retirée")
    assert((await store.getItem(perso)) === null, "la connaissance personnelle est retirée du cerveau")
    const fixed = await store.getItem(tva)
    assert(fixed?.zone === "compta" && fixed.kind === "procedure" && fixed.title.endsWith("déclarer la TVA avant le 19"), "la correction est appliquée sur place (zone, type, titre)")
    assert((await store.getItem(good))?.title.includes("webhooks Stripe"), "la bonne reste telle quelle")
    const log = await loadModerationLog()
    assert(log[0]?.decision !== undefined && !JSON.stringify(log).includes("médecin") && !JSON.stringify(log).includes("Rendez-vous"), "le journal ne garde pas le texte retiré")
    assert(log.some((e) => e.decision === "reject" && e.category === "personnel" && !e.reason), "retrait « personnel » : motif seul, sans la phrase de Claude")
    const modEvents = (await store.listEvents({ limit: 20, type: "write" })).filter((e) => e.summary?.startsWith("Modérateur"))
    assert(modEvents.some((e) => e.summary === "Modérateur : 1 connaissance retirée (contenu personnel)" && e.zones.join() === "dev"), "le fil d'activité montre le retrait, sans le texte")
    assert("skipped" in (await moderationInput()), "déjà relues : le passage suivant n'a rien à faire")
    const replay = await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: [good], verdicts: [{ id: good, decision: "reject", category: "vague" }] } })
    assert(replay.data.reviewed === 0 && (await store.getItem(good)) !== null, "un verdict sur une connaissance déjà relue est ignoré")

    // Passage du serveur : un lot sans réponse de Claude reste en attente, le curseur ne le saute pas.
    const later = await ingestItems(hugo, [item("dev", `${tag} : procédure de mise en prod revue`, "procedure")])
    const failed = await runModeration(async () => null)
    assert(failed.status === "claude_error" && failed.remaining === 1, "Claude muet : rien de relu, la connaissance attend")
    const ok = await runModeration(async (input) => input.items.map((i) => keep(i.ref)))
    assert(ok.status === "done" && ok.reviewed === 1 && ok.via === "server", "relue au passage suivant")

    await setModerationEnabled(false)
    assert((await moderationInput()).hasOwnProperty("skipped") && (await call(adminModerationRoute.POST, "/api/admin/moderation", { method: "POST", session: claireSession, body: { ids: [], verdicts: [] } })).status === 409, "coupé : plus de passage")
    await setModerationEnabled(true)
    for (const id of [good, tva, later.ids[0]]) assert(await store.deleteItem(id), "connaissance de test supprimée")
  }

  console.log("\nTout est vert.")
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
