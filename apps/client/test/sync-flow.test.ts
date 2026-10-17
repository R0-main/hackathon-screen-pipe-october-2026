import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { applyPrivacy, runSync } from "../src/sync"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const user = (s: string, text: string, minAgo: number) => line({ type: "user", sessionId: s, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "user", content: text } })
const assistant = (s: string, text: string, minAgo: number) =>
  line({ type: "assistant", sessionId: s, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

/** Un poste de test : dossiers Claude / Codex / client, config pointant vers le faux cerveau. */
function workstation(brainUrl: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const proj = join(claude, "projects", "-home-hugo-fournil")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brainUrl, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], screenpipe_agent: false, ...extra }))
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, claude, proj, state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")) }
}

function session(i: number) {
  return (
    user(`s${i}`, `Comment on configure le module ${i} de facturation ?`, 200 - i) +
    assistant(
      `s${i}`,
      `On a décidé d'utiliser la stratégie ${i} pour le module ${i}.\n1. Créer la table module_${i}\n2. Migrer les données du module ${i}\n3. Vérifier le module ${i} en recette\nTODO: documenter le module ${i} dans le wiki`,
      199 - i,
    )
  )
}

test("envoi interrompu au 2e lot : les lots déjà acceptés ne sont pas renvoyés (checkpoints par lot)", async () => {
  const brain = await mockBrain({ failIngestAt: [2] })
  try {
    const ws = workstation(brain.url)
    for (let i = 1; i <= 30; i++) writeFileSync(join(ws.proj, `s${String(i).padStart(2, "0")}.jsonl`), session(i))
    await assert.rejects(runSync({ distiller: "heuristic" }, capture().io), /500/)
    assert.equal(brain.ingested.length, 50)
    // Les conversations entièrement envoyées ont leur checkpoint.
    const saved = Object.keys(ws.state().claude.files).length
    assert.ok(saved >= 12, `checkpoints enregistrés : ${saved}`)

    const out = capture()
    const r = await runSync({ distiller: "heuristic" }, out.io)
    const total = brain.ingested.length
    assert.ok(total >= 115, `connaissances uniques : ${total}`)
    const resent = brain.received.length - total
    // Au plus les items de la conversation à cheval sur le lot raté (4 ici), et le cerveau les ignore.
    assert.ok(resent <= 4, `renvoyés : ${resent}`)
    assert.equal(r.duplicates, resent)
    assert.equal(r.sent + 50, total)
    const again = await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(again.items.length, 0)
  } finally {
    await brain.close()
  }
})

test("simulation : textes abrégés par défaut, complets avec --full ; --confirm envoie exactement l'aperçu", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    const steps = Array.from({ length: 5 }, (_, n) => `${n + 1}. Étape ${n + 1} du runbook de mise en production de l'API Fournil, avec vérification des journaux`).join("\n")
    const f = join(ws.proj, "deploy.jsonl")
    writeFileSync(f, user("d", "Comment on déploie l'API en production ?", 20) + assistant("d", `Voici la procédure.\n${steps}`, 19))

    const short = capture()
    await runSync({ dryRun: true, distiller: "heuristic" }, short.io)
    assert.match(short.text(), /Textes abrégés : ajoutez --full/)
    assert.ok(!short.text().includes("Étape 5 du runbook"))

    const full = capture()
    const preview = await runSync({ dryRun: true, full: true, distiller: "heuristic" }, full.io)
    // Toutes les étapes, quelle que soit la mise en forme de la procédure par le distillateur.
    for (let n = 1; n <= 5; n++) assert.ok(full.text().includes(`Étape ${n} du runbook`), `étape ${n} absente de l'aperçu`)
    assert.ok(!full.text().includes("Textes abrégés"))
    assert.match(full.text(), /sync --confirm/)
    assert.equal(brain.ingested.length, 0)
    assert.equal(statSync(join(ws.home, "preview.json")).mode & 0o777, 0o600)
    assert.ok(!existsSync(join(ws.home, "state.json")))

    // De l'activité arrive entre l'aperçu et l'accord : elle ne part pas avec --confirm.
    appendFileSync(f, user("d", "Et pour le rollback de la base ?", 5) + assistant("d", "On a décidé de garder les snapshots Supabase quotidiens.", 4))
    const sent = await runSync({ confirm: true }, capture().io)
    assert.deepEqual(brain.ingested, JSON.parse(JSON.stringify(preview.items)))
    assert.equal(sent.sent, preview.items.length)
    assert.ok(!existsSync(join(ws.home, "preview.json")))
    assert.ok(ws.state().last_sync.items_sent === preview.items.length)
    assert.ok(!JSON.stringify(brain.ingested).includes("snapshots"))

    // La synchro suivante reprend après l'aperçu : seule la nouvelle activité part.
    await runSync({ distiller: "heuristic" }, capture().io)
    const later = brain.ingested.slice(preview.items.length)
    assert.ok(later.length > 0 && JSON.stringify(later).includes("snapshots"))
    assert.ok(!JSON.stringify(later).includes("Étape 1 du runbook"))

    await assert.rejects(runSync({ confirm: true }, capture().io), /Aucune simulation à confirmer/)
  } finally {
    await brain.close()
  }
})

test("--confirm refuse un aperçu périmé (synchro entre-temps)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "a.jsonl"), session(1))
    await runSync({ dryRun: true, distiller: "heuristic" }, capture().io)
    writeFileSync(join(ws.home, "state.json"), JSON.stringify({ claude: { files: {} }, last_sync: { at: ts(0) } }))
    await assert.rejects(runSync({ confirm: true }, capture().io), /Une synchronisation a eu lieu depuis la simulation/)
    assert.equal(brain.ingested.length, 0)
  } finally {
    await brain.close()
  }
})

test("après install-schedule (baseline) : l'historique non relu ne part pas, l'activité nouvelle oui", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.home, "state.json"), JSON.stringify({ baseline_at: ts(10) }))
    writeFileSync(
      join(ws.proj, "x.jsonl"),
      user("x", "Comment on clôture le mois ?", 60) +
        assistant("x", "On a décidé de clôturer le 5 du mois suivant.", 59) +
        user("x", "Et pour les notes de frais ?", 3) +
        assistant("x", "On a décidé de passer les notes de frais sur Swile.", 2),
    )
    await runSync({ distiller: "heuristic" }, capture().io)
    const json = JSON.stringify(brain.ingested)
    assert.ok(json.includes("Swile"), json)
    assert.ok(!json.includes("clôturer le 5"), "un échange antérieur à la mise en place est parti")
  } finally {
    await brain.close()
  }
})

test("workflows Screenpipe : montrés en simulation (filtrés, masqués), seuls ceux-là sont remontés", async () => {
  const brain = await mockBrain()
  const sp = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [], pagination: { total: 0 } } }
    if (u.pathname === "/workflows")
      return {
        body: {
          workflows: [
            { title: "Répond sur WhatsApp à Julie", description: "Messages perso du soir", occurrences: 9, days: 5 },
            { title: "Relance des factures", description: "Mail puis Excel", apps: ["Mail"], occurrences: 6, days: 4 },
            { title: "Point TVA quotidien avec Claude", description: "Puis écrit à compta@fournil.fr", app_name: "Claude", occurrences: 8, days: 6, typical_time: "09:00" },
          ],
        },
      }
    return undefined
  })
  try {
    workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe"] })
    const out = capture()
    await runSync({ dryRun: true, distiller: "heuristic" }, out.io)
    assert.match(out.text(), /W1\. Point TVA quotidien avec Claude .*8 fois sur 6 jours, vers 09:00/)
    assert.match(out.text(), /2 workflows Screenpipe écartés/)
    assert.ok(!out.text().includes("compta@fournil.fr") && !out.text().includes("WhatsApp"))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.automations.length, 1)
    assert.ok(!JSON.stringify(brain.automations).includes("compta@fournil.fr"))
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("applyPrivacy : jeton du poste masqué, session d'installation écartée", () => {
  const conv = (id: string, text: string) => ({
    id,
    tool: "claude" as const,
    app: "Terminal",
    started_at: ts(5),
    ended_at: ts(4),
    messages: [
      { role: "user" as const, text },
      { role: "assistant" as const, text: "D'accord, on déploie l'API." },
    ],
  })
  const r = applyPrivacy(
    [
      conv("a", "Le déploiement de l'API renvoie 401, voici l'en-tête copié : cb_AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
      conv("b", "Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Hugo."),
      conv("c", "Le déploiement plante avec maclesecrete-123456789 dans les logs"),
    ],
    ["maclesecrete-123456789"],
  )
  assert.equal(r.kept.length, 1)
  assert.ok(!r.kept[0].messages[0].text.includes("cb_AbCd"))
  assert.match(r.kept[0].messages[0].text, /\[jeton masqué\]/)
  assert.deepEqual(
    r.dropped.map((d) => d.reason),
    ["session d'installation du cerveau", "session d'installation du cerveau"],
  )
})

test("sync --scheduled --home : environnement minimal (comme cron), PATH et dossiers repris de la config", { skip: process.platform === "win32" }, async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "a.jsonl"), session(1))
    const bin = tempDir()
    // Fausse CLI `claude` : répond une extraction vide.
    writeFileSync(join(bin, "claude"), '#!/bin/sh\ncat > /dev/null\necho \'{"result":"{\\"items\\":[]}"}\'\n')
    chmodSync(join(bin, "claude"), 0o755)
    const cfg = JSON.parse(readFileSync(join(ws.home, "config.json"), "utf8"))
    writeFileSync(join(ws.home, "config.json"), JSON.stringify({ ...cfg, use_claude_cli: true, schedule_env: { PATH: `${bin}${delimiter}/usr/bin`, CLAUDE_CONFIG_DIR: ws.claude } }))
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "sync", "--scheduled", "--dry-run", "--home", ws.home], {
        cwd: clientDir,
        // Comme cron : PATH minimal, sans le dossier de node (où se trouve aussi la vraie CLI `claude` sur ce poste).
        env: { HOME: tempDir(), PATH: `/usr/bin${delimiter}/bin` },
      })
      let s = ""
      child.stdout.on("data", (d) => (s += d))
      child.stderr.on("data", (d) => (s += d))
      child.on("close", () => resolve(s))
    })
    assert.match(out, new RegExp(`CLI trouvée \\(${join(bin, "claude").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), out)
    assert.match(out, /Claude Code : 1 conversation/, out)
  } finally {
    await brain.close()
  }
})
