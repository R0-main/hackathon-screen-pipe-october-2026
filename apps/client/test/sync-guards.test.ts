// Garde-fous de la synchro : point de départ de la planification, aperçu partiel, échecs du LLM, indices perso,
// secrets du poste, décompte par zone d'après la réponse du cerveau.

import { strict as assert } from "node:assert"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ZoneTally, applyPrivacy, insertedByZone, runSync } from "../src/sync"
import { finalizeItems } from "../src/distill"
import { prepareSchedule } from "../src/install"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const user = (s: string, text: string, minAgo: number) => line({ type: "user", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "user", content: text } })
const assistant = (s: string, text: string, minAgo: number, stop_reason = "end_turn") =>
  line({ type: "assistant", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "text", text }], stop_reason } })
const toolUse = (s: string, minAgo: number) =>
  line({ type: "assistant", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: "tool_use" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

/** Faux secrets assemblés à l'exécution (aucun motif de secret en clair dans le dépôt). */
const fake = (...parts: string[]) => parts.join("")

function workstation(brainUrl: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const codex = tempDir()
  const proj = join(claude, "projects", "-home-ines-app")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brainUrl, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], ...extra }))
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = codex
  delete process.env.ANTHROPIC_API_KEY
  return {
    home,
    claude,
    codex,
    proj,
    state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")),
    setConfig: (patch: Record<string, unknown>) => {
      const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
      writeFileSync(join(home, "config.json"), JSON.stringify({ ...cfg, ...patch }))
    },
  }
}

type Row = { n: number; at: number; app: string; window: string; text: string }

/** Faux Screenpipe : /search par fenêtre de temps, du plus récent au plus ancien, avec total. */
async function screenpipe(rows: Row[]) {
  return mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/health") return { body: { status: "healthy" } }
    if (u.pathname === "/workflows") return { body: { workflows: [] } }
    if (u.pathname !== "/search") return undefined
    if (u.searchParams.get("content_type") !== "ocr") return { body: { data: [], pagination: { total: 0 } } }
    const a = Date.parse(u.searchParams.get("start_time")!)
    const b = Date.parse(u.searchParams.get("end_time")!)
    const limit = Number(u.searchParams.get("limit"))
    const offset = Number(u.searchParams.get("offset"))
    const sel = rows.filter((r) => r.at >= a && r.at <= b).sort((x, y) => y.at - x.at)
    const data = sel.slice(offset, offset + limit).map((r) => ({
      type: "OCR",
      content: { frame_id: r.n, text: r.text, timestamp: new Date(r.at).toISOString(), app_name: r.app, window_name: r.window },
    }))
    return { body: { data, pagination: { limit, offset, total: sel.length } } }
  })
}

const nums = (v: unknown, re = /QZX(\d+)/g) => [...JSON.stringify(v).matchAll(re)].map((m) => Number(m[1]))

test("PRIVACY-8b : après install-schedule, ni la suite Screenpipe ni les conversations reportées ne partent toutes seules", async () => {
  const brain = await mockBrain()
  const now = Date.now()
  // 40 fenêtres Screenpipe (40 conversations) sur les 6 dernières heures : l'aperçu (limite 30) en reporte 10.
  const rows: Row[] = []
  for (let k = 0; k < 40; k++) {
    const t = now - 6 * 3600_000 + k * 8 * 60_000
    rows.push({ n: 2 * k, at: t, app: "Terminal", window: `claude — sujet ${k}`, text: `QZX${k} On a décidé de garder Qonto pour la trésorerie du lot ${k}.` })
    rows.push({ n: 2 * k + 1, at: t + 30_000, app: "Terminal", window: `claude — sujet ${k}`, text: `1. Ouvrir le relevé ${k}\n2. Rapprocher le relevé ${k}` })
  }
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe", "claude"] })
    // Claude Code : une session reportée par la limite n'est pas relue non plus, et un tour en cours non plus.
    writeFileSync(join(ws.proj, "pending.jsonl"), user("p", "QZX900 Comment on clôture la TVA ?", 3) + toolUse("p", 2))

    const dry = capture()
    const r = await runSync({ dryRun: true, full: true, since: "24h", distiller: "heuristic" }, dry.io)
    const shown = new Set(nums(r.items))
    assert.ok(shown.size >= 25 && shown.size < 40, `conversations montrées : ${shown.size}`)
    assert.equal(r.deferred, 40 - shown.size)
    // L'aperçu dit clairement qu'il est partiel, et pourquoi.
    assert.match(dry.text(), /Attention, aperçu partiel/)
    assert.match(dry.text(), /conversations reportées : limite de 30 segments/)
    assert.match(dry.text(), /tour de conversation en cours/)
    assert.match(dry.text(), /Après install-schedule, ce qui n'a pas été relu n'est jamais envoyé/)

    await runSync({ confirm: true }, capture().io)
    assert.deepEqual(new Set(nums(brain.ingested)), shown)
    prepareSchedule({ PATH: "/usr/bin" }, () => {})
    const st = ws.state()
    assert.ok(st.screenpipe.last_timestamp >= st.baseline_at, "checkpoint Screenpipe relevé à la mise en place")
    assert.ok(st.claude.files[join(ws.proj, "pending.jsonl")], "fichier Claude Code repris à sa fin actuelle")

    // La synchro planifiée ne remonte rien d'antérieur…
    const before = brain.ingested.length
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.ingested.length, before, `envoyé après la mise en place : ${JSON.stringify(brain.ingested.slice(before))}`)
    // … mais l'activité nouvelle part.
    rows.push({ n: 999, at: Date.now() + 1000, app: "Terminal", window: "claude — nouveau", text: "QZX777 On a décidé de passer les notes de frais sur Swile." })
    appendFileSync(join(ws.proj, "pending.jsonl"), assistant("p", "QZX901 On a décidé de clôturer la TVA le 5.", 0))
    await new Promise((res) => setTimeout(res, 1100))
    await runSync({ distiller: "heuristic" }, capture().io)
    const later = nums(brain.ingested.slice(before))
    assert.ok(later.includes(777), `nouvelle capture absente : ${later}`)
    assert.ok(later.includes(901), `réponse arrivée après la mise en place absente : ${later}`)
    assert.ok(!later.includes(900), "la question antérieure à la mise en place (jamais relue) est partie")
    assert.ok(!later.some((n) => n < 40), `historique Screenpipe non relu envoyé : ${later}`)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("PRIVACY-8b : un aperçu Screenpipe tronqué le dit, et la planification ne reprend pas la suite", async () => {
  const brain = await mockBrain()
  const now = Date.now()
  // 2600 captures en 2 h : plus que ce qu'un passage lit (20 pages de 100).
  const rows: Row[] = Array.from({ length: 2600 }, (_, i) => ({
    n: i,
    at: now - 2 * 3600_000 + i * 2500,
    app: "Terminal",
    window: `claude — compta ${Math.floor(i / 400)}`,
    text: `QZX${i} rapprochement bancaire ligne ${i}`,
  }))
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe"] })
    const dry = capture()
    await runSync({ dryRun: true, full: true, since: "24h", distiller: "heuristic", limit: 200 }, dry.io)
    assert.match(dry.text(), /Attention, aperçu partiel/)
    assert.match(dry.text(), /Screenpipe : captures lues jusqu'au .* seulement/)
    const preview = JSON.parse(readFileSync(join(ws.home, "preview.json"), "utf8"))
    const maxShown = Math.max(...nums(preview.items))
    assert.ok(maxShown < 2599)
    await runSync({ confirm: true }, capture().io)
    prepareSchedule({ PATH: "/usr/bin" }, () => {})
    const before = brain.ingested.length
    await runSync({ distiller: "heuristic", limit: 200 }, capture().io)
    const later = nums(brain.ingested.slice(before))
    assert.deepEqual(later, [], `captures antérieures à la mise en place envoyées (jusqu'à #${Math.max(-1, ...later)})`)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("R-count : le décompte par zone ne compte que les items insérés (réponse du cerveau)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "d.jsonl"), user("d", "Comment on déploie l'API en production ?", 50) + assistant("d", "On a décidé de déployer avec Vercel.\n1. Merger\n2. Tagger\n3. Surveiller", 49))
    const first = capture()
    const r1 = await runSync({ distiller: "heuristic" }, first.io)
    assert.ok(r1.sent > 0)
    assert.match(first.text(), new RegExp(`Envoyé : ${r1.sent} connaissances? au cerveau \\(dev : ${r1.sent}\\)\\.`))
    // Renvoi complet : tout est déjà connu, aucune zone ne doit être créditée.
    const again = capture()
    const r2 = await runSync({ distiller: "heuristic", reset: true }, again.io)
    assert.equal(r2.sent, 0)
    assert.deepEqual(r2.zones, {})
    assert.match(again.text(), new RegExp(`Envoyé : 0 connaissance au cerveau, ${r2.duplicates} déjà connues? ignorées? par le cerveau\\.`))
    assert.deepEqual(ws.state().last_sync.zones, {})
  } finally {
    await brain.close()
  }
})

test("R-count : insertedByZone / ZoneTally (per_zone, zone unique, zones touchées, cas ambigu)", () => {
  const batch = [{ zone: "dev" }, { zone: "dev" }, { zone: "compta" }, { zone: "sales" }]
  assert.deepEqual(insertedByZone(batch, { inserted: 3, zones: ["dev", "compta"], per_zone: { dev: 2, compta: 1 } }), { dev: 2, compta: 1 })
  assert.deepEqual(insertedByZone(batch, { inserted: 0, zones: [] }), {})
  assert.deepEqual(insertedByZone(batch, { inserted: 4, zones: ["dev", "compta", "sales"] }), { dev: 2, compta: 1, sales: 1 })
  assert.deepEqual(insertedByZone(batch, { inserted: 1, zones: ["dev"] }), { dev: 1 })
  // Les items des zones non touchées ont tous été ignorés : le reste est exact.
  assert.deepEqual(insertedByZone(batch, { inserted: 3, zones: ["dev", "compta"] }), { dev: 2, compta: 1 })
  // Un des deux items « dev » ignoré, « compta » inséré : impossible de trancher sans per_zone.
  assert.equal(insertedByZone(batch, { inserted: 2, zones: ["dev", "compta"] }), null)
  const t = new ZoneTally()
  t.add(batch, { inserted: 4, zones: ["dev", "compta", "sales"] })
  t.add(batch, { inserted: 2, zones: ["dev", "compta"] })
  assert.equal(t.line(), "dev : 2, compta : 1, sales : 1, compta ou dev : 2")
})

/** Fausse CLI `claude` : journalise chaque appel ; échoue si le prompt contient ECHEC (ou toujours, réseau coupé, avec failAll). */
function fakeClaudeSh(dir: string, opts: { failAll?: boolean } = {}) {
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const out = join(dir, "out.json")
  writeFileSync(
    out,
    JSON.stringify({
      result: JSON.stringify({ items: [{ zone: "compta", kind: "decision", title: "Clôture de la TVA le 5 du mois", body: "Décision prise : la TVA est clôturée le 5.", entities: [], confidence: 0.9 }] }),
    }),
  )
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then echo "--no-session-persistence --tools"; exit 0; fi
input=$(cat)
echo call >> "${join(dir, "calls.log")}"
${opts.failAll ? 'echo "API Error: Connection error." >&2; exit 1' : 'case "$input" in *ECHEC*) echo "boom" >&2; exit 1;; esac'}
cat "${out}"
`,
  )
  chmodSync(join(bin, "claude"), 0o755)
  return { bin, calls: () => (readFileSync(join(dir, "calls.log"), "utf8").match(/call/g) ?? []).length }
}

test("PRIVACY-4c : Claude ne répond pas → rien n'est distillé par l'heuristique, checkpoint inchangé, retenté plus tard", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const f = join(ws.proj, "tva.jsonl")
    writeFileSync(f, user("t", "Comment on clôture la TVA ce mois-ci ?", 50) + assistant("t", "On a décidé de clôturer la TVA le 5.\n1. Exporter\n2. Déclarer", 49))
    for (let i = 0; i < 4; i++) writeFileSync(join(ws.proj, `x${i}.jsonl`), user(`x${i}`, `Comment on configure le module ${i} ?`, 40 - i) + assistant(`x${i}`, `On a décidé d'utiliser la stratégie ${i}.`, 39 - i))
    const down = fakeClaudeSh(tempDir(), { failAll: true })
    const out = capture()
    const r = await withPath(down.bin, () => runSync({}, out.io))
    assert.equal(r.distiller, "claude-cli")
    assert.equal(brain.received.length, 0, "l'heuristique a servi de secours")
    assert.equal(r.failed, 5)
    // Au plus MAX_SYSTEMIC_FAILURES appels (+ celui en cours) : on n'insiste pas quand Claude est injoignable.
    assert.ok(down.calls() <= 4, `appels : ${down.calls()}`)
    assert.match(out.text(), /non distillées .*Connection error/)
    assert.match(out.text(), /l'heuristique n'est pas utilisée à la place : elles? seront retentées/)
    assert.match(out.text(), /Panne générale \(Claude injoignable ou saturé\) : aucun essai n'est décompté/)
    assert.equal(ws.state().claude?.files?.[f], undefined, "checkpoint avancé malgré l'échec")
    assert.equal(ws.state().distill_failures, undefined, "panne générale comptée comme échec de conversation")

    // Claude revient : la conversation est distillée par Claude et envoyée.
    const up = fakeClaudeSh(tempDir())
    const r2 = await withPath(up.bin, () => runSync({}, capture().io))
    assert.equal(r2.failed, 0)
    assert.ok(brain.ingested.length >= 1)
    assert.ok(ws.state().claude.files[f])
  } finally {
    await brain.close()
  }
})

test("PRIVACY-4c : une conversation que Claude n'arrive pas à distiller (les autres passent) est abandonnée après 3 essais, sans rien envoyer", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const bad = join(ws.proj, "bad.jsonl")
    writeFileSync(bad, user("b", "ECHEC Comment on clôture la TVA ?", 50) + assistant("b", "On a décidé de clôturer la TVA le 5.", 49))
    const cli = fakeClaudeSh(tempDir())
    for (let run = 1; run <= 3; run++) {
      writeFileSync(join(ws.proj, `ok${run}.jsonl`), user(`ok${run}`, `Question compta ${run} ?`, 30) + assistant(`ok${run}`, `Réponse compta ${run}.`, 29))
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      if (run < 3) {
        assert.equal(r.failed, 1)
        assert.equal(ws.state().distill_failures?.b?.n, run)
        assert.equal(ws.state().claude.files[bad], undefined)
      } else {
        assert.match(out.text(), /1 conversation abandonnée après 3 essais infructueux : rien n'a été envoyé/)
        assert.equal(ws.state().distill_failures, undefined)
        assert.ok(ws.state().claude.files[bad], "conversation abandonnée : son checkpoint avance")
      }
    }
    assert.ok(!JSON.stringify(brain.received).includes("ECHEC"))
  } finally {
    await brain.close()
  }
})

test("H-personal-signals : indices montrés en simulation ; indices faibles d'une conversation active → réexaminée (non traitée)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    const weak = join(ws.proj, "weak.jsonl")
    const strong = join(ws.proj, "strong.jsonl")
    const oldWeak = join(ws.proj, "old.jsonl")
    writeFileSync(weak, user("w", "Exporte les relevés de mon compte bancaire et prépare la TVA", 20) + assistant("w", "D'accord.", 19))
    writeFileSync(strong, user("s", "Écris un mail à mon avocat pour le divorce", 20) + assistant("s", "Voici un brouillon.", 19))
    writeFileSync(oldWeak, user("o", "Exporte les relevés de mon compte bancaire", 300) + assistant("o", "D'accord.", 299))
    const dry = capture()
    await runSync({ dryRun: true, distiller: "heuristic", since: "24h" }, dry.io)
    assert.match(dry.text(), /écartée : s \(contenu personnel : divorce\)/)
    assert.match(dry.text(), /écartée : w \(contenu personnel, indices faibles : mon compte bancaire \(vocabulaire pro : 1\) ; réexaminée à la prochaine synchro/)
    assert.match(dry.text(), /écartée : o \(contenu personnel, indices faibles : mon compte bancaire \(vocabulaire pro : 0\)\)/)

    await runSync({ distiller: "heuristic", since: "24h" }, capture().io)
    const files = ws.state().claude.files
    assert.ok(files[strong], "conversation clairement perso : traitée (écartée pour de bon)")
    assert.ok(files[oldWeak], "conversation inactive depuis longtemps : traitée")
    assert.equal(files[weak], undefined, "indices faibles, conversation active : doit être réexaminée")
    // La conversation se poursuit avec du vrai travail : réexaminée en entier, elle passe.
    appendFileSync(weak, user("w", "Fais le rapprochement bancaire Qonto avec Pennylane, liste les écarts de TVA et les factures fournisseurs", 2) + assistant("w", "On a décidé de rapprocher chaque facture fournisseur dans Pennylane.", 1))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.ok(ws.state().claude.files[weak])
    assert.ok(JSON.stringify(brain.ingested).includes("Pennylane"))
    assert.equal(brain.ingested.length > 0, true)
    assert.ok(!JSON.stringify(brain.received).includes("divorce"))
  } finally {
    await brain.close()
  }
})

test("OFF-TOPIC : une conversation hors travail (prix d'une PS5 Pro) n'est ni envoyée ni citée dans les logs", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    const ps5 = join(ws.proj, "ps5.jsonl")
    const work = join(ws.proj, "work.jsonl")
    writeFileSync(ps5, user("ps5sess", "Combien coûte une PS5 Pro ? Et où l'acheter moins cher ?", 300) + assistant("ps5sess", "La PS5 Pro coûte environ 799 € chez Fnac et Darty.", 299))
    writeFileSync(work, user("worksess", "On déploie l'API en production avec la migration SQL ?", 20) + assistant("worksess", "On a décidé de déployer la migration SQL en staging avant la production.", 19))
    for (const opts of [{ dryRun: true }, { dryRun: true, verbose: true }, { verbose: true }]) {
      const out = capture()
      await runSync({ distiller: "heuristic", since: "24h", ...opts }, out.io)
      assert.match(out.text(), /1 conversation hors travail ignorée/)
      assert.doesNotMatch(out.text(), /ps5|799|fnac|ps5sess/i, out.text())
    }
    assert.ok(ws.state().claude.files[ps5], "conversation inactive : traitée (écartée pour de bon)")
    assert.ok(brain.received.length > 0)
    assert.doesNotMatch(JSON.stringify(brain.received), /ps5|799/i)
  } finally {
    await brain.close()
  }
})

test("OFF-TOPIC : finalizeItems retire un item hors travail retenu par le LLM dans une session mixte", () => {
  const source = { app: "Claude Code", tool: "claude-code" as const, at: new Date().toISOString() }
  const items = finalizeItems([
    { zone: "dev", kind: "fact", title: "Prix de la PS5 Pro", body: "La PS5 Pro coûte 799 € chez Fnac.", entities: [], source, confidence: 0.6 },
    { zone: "dev", kind: "decision", title: "Migration SQL en staging d'abord", body: "On déploie la migration en staging avant la production.", entities: [], source, confidence: 0.8 },
  ])
  assert.deepEqual(items.map((i) => i.title), ["Migration SQL en staging d'abord"])
})

test("H-redact-literals : les secrets du poste (jeton Claude Code compris) sont masqués tels quels, ou la session est écartée", async () => {
  const oauth = fake("sk-ant-", "oat01-", "Zq9", "x".repeat(40))
  const spTok = fake("sp", "-local-", "Kd83hQ", "pz2Lm")
  const secrets = ["cb_test_token_123456", spTok, oauth]
  const conv = (id: string, title: string, text: string) => ({
    id,
    tool: "claude" as const,
    app: "Terminal",
    title,
    started_at: ts(5),
    ended_at: ts(4),
    messages: [
      { role: "user" as const, text },
      { role: "assistant" as const, text: "On a décidé de déployer l'API vendredi." },
    ],
  })
  const r = applyPrivacy([conv("a", `Terminal ${spTok} déploiement`, "Comment déployer l'API ?"), conv("b", "API", `Le déploiement échoue avec ${oauth}`)], secrets)
  assert.equal(r.kept.length, 1)
  assert.ok(!r.kept[0].title?.includes(spTok))
  assert.match(r.kept[0].title ?? "", /masqué/)
  assert.deepEqual(r.dropped.map((d) => [d.id, d.reason]), [["b", "session d'installation du cerveau"]])

  // De bout en bout : la session où le jeton Claude Code apparaît ne part pas.
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { claude_oauth_token: oauth, screenpipe_token: spTok })
    writeFileSync(join(ws.proj, "tok.jsonl"), user("k", `export CLAUDE_CODE_OAUTH_TOKEN=${oauth} puis on déploie l'API`, 20) + assistant("k", "On a décidé de déployer l'API.", 19))
    writeFileSync(join(ws.proj, "ok.jsonl"), user("ok", "Comment on déploie l'API en production ?", 20) + assistant("ok", "On a décidé de déployer avec Vercel.", 19))
    await runSync({ distiller: "heuristic" }, capture().io)
    const sent = JSON.stringify(brain.received)
    assert.ok(sent.includes("Vercel"))
    assert.ok(!sent.includes(oauth) && !sent.includes("oat01"))
  } finally {
    await brain.close()
  }
})

const tags = (v: unknown) => [...new Set([...JSON.stringify(v).matchAll(/QZX[A-Z]*\d+/g)].map((m) => m[0]))].sort()

test("STALL : des conversations que Claude refuse toujours (les plus anciennes) ne bloquent ni les suivantes ni leurs checkpoints, et sont abandonnées après 3 essais", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const bad = [0, 1, 2, 3].map((k) => join(ws.proj, `bad${k}.jsonl`))
    bad.forEach((f, k) => writeFileSync(f, user(`bad${k}`, `QZXBAD${k} Comment on clôture la TVA ?`, 120 - k) + assistant(`bad${k}`, "On clôture le 5.", 119 - k)))
    const good = [0, 1, 2, 3, 4].map((k) => join(ws.proj, `ok${k}.jsonl`))
    good.forEach((f, k) => writeFileSync(f, user(`ok${k}`, `QZX${k} Comment on déploie l'API ?`, 60 - k) + assistant(`ok${k}`, "On a décidé de déployer avec Vercel.", 59 - k)))

    // 1er passage : les 4 refus ne coupent pas la synchro, les 5 conversations suivantes partent (même passage).
    const out1 = capture()
    const r1 = await withPath(cli.bin, () => runSync({}, out1.io))
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4"])
    assert.equal(r1.failed, 4)
    assert.equal(cli.calls().length, 9, "toutes les conversations sont tentées")
    assert.doesNotMatch(out1.text(), /non tentée|Panne générale|Vérifiez que `claude -p` fonctionne/)
    assert.match(out1.text(), /Échec lié au contenu de 4 conversations \(essai 1\/3\)/)
    for (const f of good) assert.ok(ws.state().claude.files[f], "conversation distillée : checkpoint avancé")
    for (const f of bad) assert.equal(ws.state().claude.files[f], undefined)
    assert.deepEqual(Object.values(ws.state().distill_failures).map((f) => (f as { n: number }).n), [1, 1, 1, 1])

    // 2e passage : seules les conversations refusées restent ; le modèle répond (en prose) : l'essai est décompté.
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.deepEqual(Object.values(ws.state().distill_failures).map((f) => (f as { n: number }).n), [2, 2, 2, 2])
    // 3e passage : abandonnées, sans rien envoyer ; leurs checkpoints avancent.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({}, out3.io))
    assert.match(out3.text(), /4 conversations abandonnées après 3 essais infructueux : rien n'a été envoyé pour elles/)
    assert.equal(ws.state().distill_failures, undefined)
    for (const f of bad) assert.ok(ws.state().claude.files[f], "conversation abandonnée : checkpoint avancé")
    const calls = cli.calls().length
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(cli.calls().length, calls, "conversations abandonnées retentées")
    assert.ok(!JSON.stringify(brain.received).includes("QZXBAD"))
  } finally {
    await brain.close()
  }
})

test("STALL : une fenêtre Screenpipe que Claude refuse ne bloque pas le checkpoint Screenpipe : abandonnée au 3e passage, la suite est lue", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  const now = Date.now()
  const start = now - 2 * 3600_000
  // La plus ancienne fenêtre est refusée par Claude ; puis 2600 captures (plus qu'un passage n'en lit).
  const rows: Row[] = [
    { n: 0, at: start, app: "Terminal", window: "claude — mauvais", text: "QZXBAD1 Conversation que Claude refuse de traiter." },
    { n: 1, at: start + 20_000, app: "Terminal", window: "claude — mauvais", text: "QZXBAD1 suite de la conversation refusée." },
  ]
  for (let i = 0; i < 2600; i++) {
    const w = Math.floor(i / 100)
    rows.push({ n: i + 2, at: start + 60_000 + i * 2500, app: "Terminal", window: `claude — compta ${w}`, text: `QZXW${w} rapprochement bancaire ligne ${i}` })
  }
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { use_claude_cli: true, screenpipe_url: sp.url, sources: ["screenpipe"] })
    const r1 = await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(r1.failed, 1)
    const firstPass = tags(brain.ingested)
    assert.ok(firstPass.length > 5, `1er passage : ${firstPass}`)
    const lastWindow = (t: string[]) => Math.max(...t.map((x) => Number(x.slice(4))))
    assert.ok(lastWindow(firstPass) < 25, "le 1er passage ne lit pas tout (lecture plafonnée)")
    assert.equal(ws.state().screenpipe?.last_timestamp, undefined, "checkpoint avancé au-delà d'une fenêtre non distillée")
    const failing = () => Object.values(ws.state().distill_failures ?? {}).map((f) => (f as { n: number }).n)
    assert.deepEqual(failing(), [1])

    // 2e passage : même fenêtre relue, seule la conversation refusée est tentée → essai décompté (le modèle a répondu).
    const r2 = await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(r2.sent, 0)
    assert.deepEqual(failing(), [2])
    // 3e passage : abandonnée ; le checkpoint Screenpipe avance enfin.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({ limit: 200 }, out3.io))
    assert.match(out3.text(), /1 conversation abandonnée après 3 essais infructueux/)
    assert.ok(ws.state().screenpipe?.last_timestamp, "checkpoint Screenpipe toujours bloqué")
    // La suite (jamais lue jusque-là) part au passage suivant.
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.ok(lastWindow(tags(brain.ingested)) > lastWindow(firstPass), `suite jamais lue : ${tags(brain.ingested)}`)
    assert.ok(!JSON.stringify(brain.received).includes("QZXBAD"))
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("STALL : tous les appels échouent pareil sans réponse de Claude → panne, rien de décompté ; une conversation en erreur → décomptée quand Claude répond aux autres, puis abandonnée", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    for (let k = 0; k < 5; k++) writeFileSync(join(ws.proj, `s${k}.jsonl`), user(`s${k}`, `QZX${k} Comment on déploie l'API ?`, 60 - k) + assistant(`s${k}`, "On a décidé de déployer avec Vercel.", 59 - k))
    const err = join(ws.proj, "err.jsonl")
    writeFileSync(err, user("err", "QZXERR1 Une conversation qui fait planter la CLI", 90) + assistant("err", "D'accord.", 89))

    // La même erreur inconnue à chaque appel : arrêt après 3 appels, aucun essai décompté.
    cli.setMode("weird")
    const out1 = capture()
    const r1 = await withPath(cli.bin, () => runSync({}, out1.io))
    assert.equal(r1.failed, 6)
    assert.ok(cli.calls().length <= 4, `appels : ${cli.calls().length}`)
    assert.match(out1.text(), /Panne générale \(tous les appels échouent de la même façon\) : aucun essai n'est décompté/)
    assert.ok(Object.values(ws.state().distill_failures ?? {}).every((f) => (f as { n: number }).n === 0))
    assert.equal(ws.state().claude?.files?.[err], undefined)

    // Claude revient : les conversations jamais en échec passent d'abord, celle qui fait planter la CLI est décomptée.
    cli.setMode("")
    const before = cli.calls().length
    await withPath(cli.bin, () => runSync({}, capture().io))
    const run2 = cli.calls().slice(before)
    // Ordre : s2, s3, s4 (jamais en échec), puis err, s0, s1 (déjà en échec) ; 2 appels à la fois.
    assert.ok(run2.findIndex((c) => c.tags.includes("QZXERR1")) >= 2, `ordre : ${run2.map((c) => c.tags.join("+"))}`)
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4"])
    assert.equal(ws.state().distill_failures?.err?.n, 1)
    // Seule dans la file ensuite (Claude ne répond à aucun appel) : l'échec ne prouve rien, il n'est pas décompté.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({}, out3.io))
    assert.equal(ws.state().distill_failures?.err?.n, 1)
    assert.match(out3.text(), /Panne générale \(Claude n'a répondu à aucun appel\) : aucun essai n'est décompté/)
    // Dès que Claude répond à d'autres conversations dans la même synchro, l'échec compte : abandonnée au 3e.
    for (const k of [5, 6]) {
      writeFileSync(join(ws.proj, `s${k}.jsonl`), user(`s${k}`, `QZX${k} Comment on teste l'API ?`, 30) + assistant(`s${k}`, "On a décidé de tester avec Vitest.", 29))
      const out = capture()
      await withPath(cli.bin, () => runSync({}, out.io))
      if (k === 5) assert.equal(ws.state().distill_failures?.err?.n, 2)
      else assert.match(out.text(), /1 conversation abandonnée après 3 essais infructueux/)
    }
    assert.ok(ws.state().claude.files[err])
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4", "QZX5", "QZX6"])
    assert.ok(!JSON.stringify(brain.received).includes("QZXERR"))
  } finally {
    await brain.close()
  }
})

test("R-LIMIT : une fenêtre Screenpipe qui fait toujours échouer la CLI (erreur inconnue, rien d'autre à distiller) libère le checkpoint en un jour", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  const now = Date.now()
  const start = now - 2 * 3600_000
  const rows: Row[] = [
    { n: 0, at: start, app: "Terminal", window: "claude — bloquée", text: "QZXERR1 Conversation qui fait planter la CLI." },
    { n: 1, at: start + 20_000, app: "Terminal", window: "claude — bloquée", text: "QZXERR1 suite de la conversation." },
  ]
  for (let i = 0; i < 2600; i++) rows.push({ n: i + 2, at: start + 60_000 + i * 2500, app: "Terminal", window: `claude — compta ${Math.floor(i / 100)}`, text: `QZXW${Math.floor(i / 100)} rapprochement bancaire ligne ${i}` })
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { use_claude_cli: true, screenpipe_url: sp.url, sources: ["screenpipe"] })
    const entry = () => {
      const all = Object.values(ws.state().distill_failures ?? {}) as { n: number; tries?: number }[]
      assert.ok(all.length <= 1, "une seule conversation en échec")
      return all[0]
    }
    // 1er passage : les autres fenêtres partent (Claude répond) → l'échec est probant (1/3).
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(entry()?.n, 1)
    const lastWindow = (t: string[]) => Math.max(...t.filter((x) => x.startsWith("QZXW")).map((x) => Number(x.slice(4))))
    const firstPass = lastWindow(tags(brain.ingested))
    // Ensuite seule la fenêtre bloquée est tentée, sans aucune réponse de Claude : rien de probant, pas d'abandon.
    for (let run = 2; run <= 5; run++) {
      await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
      assert.equal(entry()?.n, 1)
      assert.equal(entry()?.tries, run)
      assert.equal(ws.state().screenpipe?.last_timestamp, undefined)
    }
    // Le lendemain (échecs depuis plus de 24 h, 5 essais au moins) : abandonnée, le checkpoint avance, la suite est lue.
    const state = ws.state()
    for (const f of Object.values(state.distill_failures) as { first_at?: string }[]) f.first_at = new Date(now - 25 * 3_600_000).toISOString()
    writeFileSync(join(process.env.COMPANY_BRAIN_HOME!, "state.json"), JSON.stringify(state))
    const out = capture()
    await withPath(cli.bin, () => runSync({ limit: 200 }, out.io))
    assert.match(out.text(), /1 conversation abandonnée après plus de 24 h d'échecs/)
    assert.ok(ws.state().screenpipe?.last_timestamp, "checkpoint Screenpipe toujours bloqué")
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.ok(lastWindow(tags(brain.ingested)) > firstPass, "la suite n'a jamais été lue")
    assert.ok(!JSON.stringify(brain.received).includes("QZXERR"))
  } finally {
    await brain.close()
    await sp.close()
  }
})
