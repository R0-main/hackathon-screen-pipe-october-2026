// brain doctor : diagnostic en lecture seule, sur un faux poste complet (faux cerveau, faux Screenpipe, faux `claude`,
// faux crontab) monté dans un dossier temporaire. Rien n'est lu ni écrit hors de ce dossier.

import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { captureDiagnosis, formatDoctor, lastLoggedRun, recentHookErrors, reinstallCommand, runDoctor, type DoctorReport } from "../src/doctor"
import { cronLine, hookEntry, mcpArgs, mergeHooks } from "../src/install"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const TOKEN = "cb_test_token_123456"
const SP_TOKEN = "sp-0a1b2c3d4e5f"
const HEALTHY = {
  status: "healthy",
  frame_status: "ok",
  vision_reason: "ok",
  last_frame_timestamp: new Date().toISOString(),
  ui_recorder: { configured: true, running: true },
  audio_capture_mode: "disabled",
}

type Post = { root: string; home: string; script: string; claudeDir: string; bin: string; env: Record<string, string> }

/** Un poste branché comme le ferait setup : config, raccourci, hooks, MCP et synchro planifiée sur le client « actuel ». */
function makePost(brainUrl: string, spUrl: string, opts: { token?: string } = {}): Post {
  const root = tempDir("brain-doctor-")
  const home = join(root, "brain")
  const claudeDir = join(root, "claude")
  const bin = join(root, "bin")
  for (const d of [home, claudeDir, bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  // Le « client » : répond à `_probe` comme brain.mjs.
  const script = join(home, "brain.mjs")
  writeFileSync(
    script,
    `if (process.argv.includes("_probe")) console.log(JSON.stringify({ version: "0.1.0", node: process.execPath, script: process.argv[1], home: process.env.COMPANY_BRAIN_HOME }))\n`,
  )
  writeFileSync(join(home, "brain"), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 })
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: brainUrl, token: opts.token ?? TOKEN, screenpipe_url: spUrl, screenpipe_token: SP_TOKEN, sources: ["claude", "codex", "screenpipe"], use_claude_cli: true }),
    { mode: 0o600 },
  )
  // Faux `claude` (version) et faux crontab (notre ligne), seuls dans le PATH.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "2.1.302 (Claude Code)"\n`, { mode: 0o755 })
  const env = { COMPANY_BRAIN_HOME: home, COMPANY_BRAIN_SCRIPT: script, CLAUDE_CONFIG_DIR: claudeDir, PATH: bin, HOME: root }
  withEnv(env, () => {
    writeFileSync(join(bin, "crontab"), `#!/bin/sh\necho ${JSON.stringify(cronLine(process.execPath, script, home, {}))}\n`, { mode: 0o755 })
    const { settings } = mergeHooks({}, hookEntry({ platform: "linux", script }))
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2))
    writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { type: "stdio", command: process.execPath, args: mcpArgs(script), env: {} } } }))
  })
  return { root, home, script, claudeDir, bin, env }
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
    process.env[k] = env[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function doctorIn(post: Post): Promise<DoctorReport> {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(post.env)) {
    saved[k] = process.env[k]
    process.env[k] = post.env[k]
  }
  try {
    return await runDoctor({ version: "0.1.0", platform: "linux" })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function fakeScreenpipe(health: unknown, search: { status?: number; body?: unknown } = { body: { data: [{ type: "parsed" }] } }) {
  return mockServer((req) => {
    if (req.url.startsWith("/health")) return { body: health }
    if (req.url.startsWith("/search")) return req.headers.authorization === `Bearer ${SP_TOKEN}` ? search : { status: 401, body: { error: "unauthorized" } }
    return undefined
  })
}

const byId = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id)

const POSIX = process.platform !== "win32"

test("doctor : poste bien branché → aucun KO, code 0, chaque groupe vérifié", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  try {
    const r = await doctorIn(post)
    const fails = r.checks.filter((c) => c.status === "fail")
    assert.deepEqual(fails, [], formatDoctor(r))
    assert.equal(r.exit_code, 0)
    for (const id of ["raccourci", "config", "connexion", "screenpipe", "capture", "screenpipe-jeton", "screenpipe-parsed", "claude", "mcp", "hooks", "planification", "distillation"]) {
      assert.equal(byId(r, id)?.status, "ok", `${id} : ${JSON.stringify(byId(r, id))}`)
    }
    assert.match(byId(r, "connexion")!.detail, /Hugo Bernard chez Fournil/)
    assert.match(byId(r, "capture")!.detail, /capture de l'écran active.*micro : coupé/)
    // Aucun jeton, même en partie, ni en texte ni en JSON (la sortie finit dans la session de Claude Code).
    for (const out of [formatDoctor(r), JSON.stringify(r)]) {
      for (const secret of [TOKEN, SP_TOKEN]) assert.ok(!out.includes(secret.slice(0, 6)) && !out.includes(secret.slice(-4)), `fragment de ${secret.slice(0, 3)}… affiché`)
    }
    assert.match(formatDoctor(r), /^Bilan : \d+ OK, \d+ à surveiller, 0 KO/m)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor : lecture seule (aucun fichier du poste créé ni modifié)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  const snapshot = () =>
    [post.home, post.claudeDir]
      .flatMap((d) => readdirSync(d).map((f) => join(d, f)))
      .map((f) => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`)
      .sort()
  try {
    const before = snapshot()
    await doctorIn(post)
    assert.deepEqual(snapshot(), before)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor : jeton révoqué, branchements sur un ancien client, Screenpipe sans autorisation → KO avec la commande qui répare", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe({ ...HEALTHY, status: "degraded", frame_status: "not_started", vision_reason: "permission_denied", last_frame_timestamp: null })
  const post = makePost(brain.url, sp.url, { token: "cb_revoque_000000000000" })
  try {
    // Hooks, MCP et crontab restés sur un client déplacé.
    const old = join(post.root, "ancien", "brain.mjs")
    withEnv(post.env, () => {
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", script: old }))
      writeFileSync(join(post.claudeDir, "settings.json"), JSON.stringify(settings))
      writeFileSync(join(post.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: process.execPath, args: [old, "mcp"] } } }))
      writeFileSync(join(post.bin, "crontab"), `#!/bin/sh\necho ${JSON.stringify(cronLine(process.execPath, old, post.home, {}))}\n`, { mode: 0o755 })
    })
    const r = await doctorIn(post)
    assert.equal(r.exit_code, 1)
    const conn = byId(r, "connexion")!
    assert.equal(conn.status, "fail")
    assert.match(conn.detail, /refuse le jeton de ce poste \(401\)/)
    assert.match(conn.fix!, /nouveau prompt d'installation/)
    assert.ok(!JSON.stringify(r).includes("cb_revoque_000000000000"))

    const hooks = byId(r, "hooks")!
    assert.equal(hooks.status, "fail")
    assert.match(hooks.detail, /ne démarre pas/)
    assert.match(hooks.command!, /install-hooks$/)
    assert.equal(hooks.safe, true)
    for (const id of ["mcp", "planification"]) {
      assert.equal(byId(r, id)?.status, "fail", id)
      assert.match(byId(r, id)!.command!, /setup$/)
      assert.equal(byId(r, id)!.safe, true)
    }
    const cap = byId(r, "capture")!
    assert.equal(cap.status, "fail")
    assert.match(cap.detail, /refuse la capture/)
    assert.match(cap.command!, /setup$/)
    // Le premier KO dans l'ordre du diagnostic : la connexion au cerveau.
    assert.equal(r.next?.id, "connexion")
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor : Screenpipe éteint, jeton Screenpipe refusé, hooks en double", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  try {
    const cfgFile = join(post.home, "config.json")
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"))
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, screenpipe_token: "sp-mauvais-jeton" }), { mode: 0o600 })
    const settingsFile = join(post.claudeDir, "settings.json")
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"))
    settings.hooks.Stop.push(structuredClone(settings.hooks.Stop[0]))
    writeFileSync(settingsFile, JSON.stringify(settings))
    let r = await doctorIn(post)
    assert.equal(byId(r, "screenpipe-jeton")?.status, "fail")
    assert.match(byId(r, "screenpipe-jeton")!.detail, /est refusé/)
    assert.equal(byId(r, "hooks")?.status, "warn")
    assert.match(byId(r, "hooks")!.detail, /en double : Stop/)

    await sp.close()
    r = await doctorIn(post)
    const s = byId(r, "screenpipe")!
    assert.equal(s.status, "fail")
    assert.match(s.detail, /ne répond pas/)
    assert.match(s.command!, /setup$/)
    assert.equal(byId(r, "capture"), undefined, "rien d'autre à vérifier sans Screenpipe")
  } finally {
    await brain.close()
  }
})

test("doctor : synchro planifiée en échec et Claude déconnecté, lus dans sync.log (masqués)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  try {
    const now = new Date()
    const stamp = now.toLocaleString("fr-FR")
    writeFileSync(
      join(post.home, "sync.log"),
      [
        `brain-sync — ${stamp}`,
        "Sources :",
        "  Claude Code n'est plus connecté sur ce poste : le jeton Claude a expiré ou a été révoqué. Lancez `claude setup-token`…",
        "Envoyé : 0 connaissance au cerveau.",
        `[${now.toISOString()}] hook : Impossible de joindre le cerveau (${brain.url}) : ECONNREFUSED ${TOKEN}`,
        "",
      ].join("\n"),
    )
    let r = await doctorIn(post)
    const auth = byId(r, "claude-connexion")!
    assert.equal(auth.status, "fail")
    assert.match(auth.command!, /init --claude-token <jeton>$/)
    assert.equal(auth.safe, false, "jamais lancé sans l'employé")
    const hookErr = byId(r, "hooks-erreurs")!
    assert.equal(hookErr.status, "warn")
    assert.ok(!hookErr.detail.includes(TOKEN), hookErr.detail)

    writeFileSync(join(post.home, "sync.log"), `brain-sync — ${stamp}\nImpossible de joindre le cerveau (${brain.url}) : fetch failed\n`)
    r = await doctorIn(post)
    assert.equal(byId(r, "journal")?.status, "fail")
    assert.match(byId(r, "journal")!.detail, /a échoué : « Impossible de joindre le cerveau/)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor lancé avec un autre Node.js que celui du poste : pas de faux KO (référence : le raccourci)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  // « Autre » Node.js : le même binaire sous un autre chemin (lien dur, sinon copie).
  const otherNode = join(post.root, "node-du-poste")
  try {
    linkSync(process.execPath, otherNode)
  } catch {
    copyFileSync(process.execPath, otherNode)
    chmodSync(otherNode, 0o755)
  }
  try {
    withEnv(post.env, () => {
      writeFileSync(join(post.home, "brain"), `#!/bin/sh\nexec '${otherNode}' '${post.script}' "$@"\n`, { mode: 0o755 })
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", execPath: otherNode, script: post.script }))
      writeFileSync(join(post.claudeDir, "settings.json"), JSON.stringify(settings))
      writeFileSync(join(post.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: otherNode, args: mcpArgs(post.script) } } }))
      writeFileSync(join(post.bin, "crontab"), `#!/bin/sh\necho ${JSON.stringify(cronLine(otherNode, post.script, post.home, {}))}\n`, { mode: 0o755 })
    })
    const r = await doctorIn(post)
    for (const id of ["raccourci", "mcp", "hooks", "planification"]) assert.equal(byId(r, id)?.status, "ok", `${id} : ${byId(r, id)?.detail}`)

    // Un hook resté sur le Node.js du processus (et non celui du raccourci) : signalé comme tel.
    withEnv(post.env, () => {
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", execPath: process.execPath, script: post.script }))
      writeFileSync(join(post.claudeDir, "settings.json"), JSON.stringify(settings))
    })
    const r2 = await doctorIn(post)
    assert.equal(byId(r2, "hooks")?.status, "fail")
    assert.match(byId(r2, "hooks")!.detail, /lance un autre Node\.js/)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor : un MCP « company-brain » qui n'est pas notre client n'est jamais lancé", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  const marker = join(post.root, "lance")
  try {
    writeFileSync(join(post.bin, "npx"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    writeFileSync(join(post.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: join(post.bin, "npx"), args: ["-y", "un-autre-serveur"] } } }))
    const r = await doctorIn(post)
    assert.equal(byId(r, "mcp")?.status, "fail")
    assert.match(byId(r, "mcp")!.detail, /pas le client du cerveau/)
    assert.ok(!existsSync(marker), "la commande enregistrée a été lancée")
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor sans config : KO config en premier, le reste vérifié quand même", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const post = makePost(brain.url, sp.url)
  try {
    writeFileSync(join(post.home, "config.json"), "")
    const r = await doctorIn(post)
    assert.equal(byId(r, "config")?.status, "fail")
    assert.equal(r.next?.id, "config")
    assert.equal(byId(r, "connexion")?.status, "skip")
    assert.equal(byId(r, "hooks")?.status, "ok")
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor --json : un seul objet JSON sur la sortie, code 1 s'il reste un KO", { skip: !POSIX }, async () => {
  const root = tempDir("brain-doctor-cli-")
  const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--json"], {
      cwd: clientDir,
      env: { HOME: root, COMPANY_BRAIN_HOME: join(root, "brain"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: join(root, "vide") },
    })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("close", (code) => resolve({ code, stdout }))
  })
  const r = JSON.parse(out.stdout) as DoctorReport
  assert.equal(out.code, 1)
  assert.equal(r.schema, 1)
  assert.equal(r.exit_code, 1)
  assert.equal(r.next?.id, "config")
  assert.ok(r.checks.every((c) => typeof c.detail === "string" && ["ok", "warn", "fail", "skip", "info"].includes(c.status)))
})

test("captureDiagnosis : vision_reason d'abord (autorisation, pause, blocage), puis l'âge de la dernière image", () => {
  const now = Date.parse("2026-10-17T10:00:00Z")
  assert.equal(captureDiagnosis({ vision_reason: "permission_denied" }, "darwin", now).status, "fail")
  assert.match(captureDiagnosis({ vision_reason: "permission_denied" }, "darwin", now).detail, /macOS n'autorise pas/)
  assert.equal(captureDiagnosis({ vision_reason: "screenshots_disabled_by_power_profile" }, "darwin", now).status, "info")
  assert.equal(captureDiagnosis({ vision_reason: "capture_stalled" }, "linux", now).reason, "stalled")
  assert.equal(captureDiagnosis({ frame_status: "not_started", last_frame_timestamp: null }, "darwin", now).reason, "not-started")
  assert.equal(captureDiagnosis({ frame_status: "stale", last_frame_timestamp: "2026-10-17T08:00:00Z" }, "linux", now).status, "warn")
  const ok = captureDiagnosis({ frame_status: "ok", vision_reason: "ok", last_frame_timestamp: "2026-10-17T09:58:00Z" }, "darwin", now)
  assert.equal(ok.status, "ok")
  assert.match(ok.detail, /il y a 2 min/)
})

test("lastLoggedRun / recentHookErrors : dernière synchro du journal, erreurs des hooks sur 24 h", () => {
  const log = [
    "brain-sync — 16/10/2026 09:00:00",
    "Envoyé : 3 connaissances au cerveau.",
    "brain-sync — 17/10/2026 09:15:00 (simulation : rien ne sera envoyé)",
    "brain-sync — 17/10/2026 09:30:00",
    "[2026-10-17T09:30:01.000Z] hook : délai dépassé",
    "Erreur : Le cerveau a répondu 500",
  ].join("\n")
  const run = lastLoggedRun(log)!
  assert.equal(run.sent, false)
  assert.equal(run.auth, false)
  assert.equal(run.error, "Erreur : Le cerveau a répondu 500")
  assert.equal(new Date(run.at!).getHours(), 9)
  assert.equal(lastLoggedRun("rien"), null)
  assert.deepEqual(recentHookErrors(log, Date.parse("2026-10-17T10:00:00Z")), { count: 1, last: "délai dépassé" })
  assert.equal(recentHookErrors(log, Date.parse("2026-10-19T10:00:00Z")).count, 0)
})

test("reinstallCommand : la commande d'installation du système, sans jeton (la config le garde)", () => {
  assert.equal(
    reinstallCommand("https://c.example", "darwin"),
    "(curl -fsSL --create-dirs https://c.example/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://c.example",
  )
  assert.match(reinstallCommand("https://c.example", "win32"), /install\.ps1" --url https:\/\/c\.example; exit \$LASTEXITCODE$/)
  assert.ok(!/--token/.test(reinstallCommand("https://c.example", "win32")))
})
