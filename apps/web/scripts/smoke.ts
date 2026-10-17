// Test de fumée du cerveau sur le stockage courant (fichier ou Postgres) : npm run smoke
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { fork } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { tokenize, type KnowledgeItemInput } from "@brain/core"
import { getStore } from "../lib/store"
import { FileStore } from "../lib/store/file"
import { PostgresStore } from "../lib/store/postgres"
import { getAccess, redactEvent } from "../lib/access"
import {
  createEventPoller,
  getPersonContext,
  getState,
  ingestItems,
  itemAuthorOrAdmin,
  queryBrain,
  recordEvents,
  refreshStatus,
  runAutomationDetection,
  statusForViewer,
  streamStartId,
} from "../lib/brain"
import { createLoginCode, createSessionValue, hashToken, newToken, verifyLoginCode, viewerFromCookies, type Viewer } from "../lib/auth"
import { isBlockedAddress, scrapeUrl, scrapeUrlWith } from "../lib/scrape"

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
  const inesQuery = await queryBrain(ines, { query: "quel est le salaire urssaf" })
  assert(inesQuery.zones_hit.length === 0 && inesQuery.zones_restricted.includes("compta"), "recherche d'Inès sur la compta : rien de lisible")
  const inesEvent = (await store.listEvents({ userId: ines.profile.id, limit: 1 }))[0]
  const sarahView = (await getState(sarah)).events.find((e) => e.id === inesEvent?.id)
  assert(inesEvent?.summary === "quel est le salaire urssaf" && sarahView && !sarahView.summary, "cette recherche n'est pas diffusée à Sarah")

  console.log("\n— « Où en est la boîte » limité aux zones lisibles (D4)")
  const jmStatus = await statusForViewer(jm)
  assert(jmStatus && jmStatus.zones.every((z) => z.zone === "compta"), "Jean-Marc ne reçoit que la zone compta")
  assert(jmStatus && jmStatus.headline !== status.headline && jmStatus.headline.startsWith(`Dans votre zone (${zoneName("compta")})`), `titre recalculé sur sa zone : « ${jmStatus?.headline} »`)
  assert((await getState(jm)).status?.headline === jmStatus?.headline, "même titre dans l'état du dashboard")
  assert((await statusForViewer(hugo))?.headline.startsWith("Dans vos zones ("), "Hugo : titre sur ses trois zones")
  assert((await statusForViewer(claire))?.headline === status.headline, "l'admin garde le titre global")

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
