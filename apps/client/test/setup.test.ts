import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { externalScreenpipeBin, parseAuthToken, recordArgs, screenpipeBinPath } from "../src/screenpipe-cli"
import { MACOS_PANES, captureState, waitForCapture } from "../src/setup"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))

// Réponse réelle de GET /health (Screenpipe 0.4.52) avant toute capture, abrégée.
const NOT_STARTED = {
  status: "degraded",
  status_code: 503,
  frame_status: "not_started",
  last_frame_timestamp: null,
  ui_recorder: { configured: true, running: false, mode: "off" },
  message: "some systems are not healthy: vision",
}
const CAPTURING = { ...NOT_STARTED, status: "healthy", frame_status: "ok", last_frame_timestamp: "2026-10-17T09:30:00Z" }
const ALL_GOOD = { ...CAPTURING, ui_recorder: { configured: true, running: true } }

test("recordArgs : micro coupé par défaut, contexte « memory », médias gardés 14 jours", () => {
  assert.deepEqual(recordArgs(), ["--disable-audio", "--app-context", "memory", "--retention-days", "14"])
  assert.ok(!recordArgs({ audio: true }).includes("--disable-audio"))
})

test("screenpipeBinPath : binaire du paquet de la plateforme, null si non publié", () => {
  assert.equal(screenpipeBinPath("/h/sp", "darwin", "arm64"), join("/h/sp", "node_modules", "@screenpipe", "cli-darwin-arm64", "bin", "screenpipe"))
  assert.match(screenpipeBinPath("/h/sp", "win32", "x64") ?? "", /cli-win32-x64[\\/]bin[\\/]screenpipe\.exe$/)
  assert.equal(screenpipeBinPath("/h/sp", "linux", "arm64"), null)
})

test("externalScreenpipeBin : CLI déjà installé dans le PATH ; sous Windows, un .exe seulement", { skip: process.platform === "win32" }, () => {
  const dir = tempDir("brain-sp-path-")
  assert.equal(externalScreenpipeBin(join(dir, "vide")), null)
  writeFileSync(join(dir, "screenpipe"), "#!/bin/sh\n", { mode: 0o755 })
  assert.equal(externalScreenpipeBin(dir), join(dir, "screenpipe"))
  // Windows : seul un .exe compte (un raccourci .cmd de npm -g ne se lance pas sans shell).
  assert.equal(externalScreenpipeBin(dir, "win32"), null)
})

test("parseAuthToken : ignore les journaux, garde la ligne du jeton", () => {
  assert.equal(parseAuthToken("2026-10-17 INFO starting\nsp-0a1b2c3d\n"), "sp-0a1b2c3d")
  assert.equal(parseAuthToken("no API token found. start screenpipe first"), null)
})

test("captureState : lit /health (200 même dégradé)", () => {
  assert.deepEqual(captureState(null), { up: false, screen: false, accessibility: null })
  const s = captureState(NOT_STARTED)
  assert.equal(s.up, true)
  assert.equal(s.screen, false)
  assert.equal(s.accessibility, false)
  assert.equal(captureState(CAPTURING).screen, true)
  assert.equal(captureState(ALL_GOOD).accessibility, true)
  assert.equal(captureState({ frame_status: "ok" }).accessibility, null)
})

/** Faux Screenpipe : renvoie les réponses /health dans l'ordre, puis la dernière. */
async function fakeScreenpipe(sequence: unknown[]) {
  let i = 0
  return mockServer((req) => (req.url.startsWith("/health") ? { body: sequence[Math.min(i++, sequence.length - 1)] } : undefined))
}

test("waitForCapture (macOS) : ouvre Enregistrement de l'écran puis Accessibilité et reprend dès qu'elles sont accordées", async () => {
  const sp = await fakeScreenpipe([NOT_STARTED, NOT_STARTED, NOT_STARTED, CAPTURING, CAPTURING, ALL_GOOD])
  const opened: string[] = []
  const logs: string[] = []
  try {
    const st = await waitForCapture({ url: sp.url, waitMs: 5000, pollMs: 5, platform: "darwin", open: (u) => opened.push(u), log: (s) => logs.push(s) })
    assert.equal(st.screen, true)
    assert.equal(st.accessibility, true)
    assert.deepEqual(opened, [MACOS_PANES.screen, MACOS_PANES.accessibility])
    assert.ok(logs.some((l) => l.startsWith("✓ Enregistrement de l'écran")))
    assert.ok(logs.some((l) => l.startsWith("✓ Accessibilité")))
  } finally {
    await sp.close()
  }
})

test("waitForCapture (macOS) : délai dépassé → écran non autorisé, on ne demande pas l'Accessibilité", async () => {
  const sp = await fakeScreenpipe([NOT_STARTED])
  const opened: string[] = []
  try {
    const st = await waitForCapture({ url: sp.url, waitMs: 60, pollMs: 5, platform: "darwin", open: (u) => opened.push(u), log: () => {} })
    assert.equal(st.up, true)
    assert.equal(st.screen, false)
    assert.deepEqual(opened, [MACOS_PANES.screen])
  } finally {
    await sp.close()
  }
})

test("waitForCapture : déjà autorisé → rien à ouvrir ; Linux → aucun réglage ; Screenpipe éteint → up false", async () => {
  const sp = await fakeScreenpipe([ALL_GOOD])
  const opened: string[] = []
  try {
    assert.equal((await waitForCapture({ url: sp.url, waitMs: 1000, pollMs: 5, platform: "darwin", open: (u) => opened.push(u), log: () => {} })).screen, true)
    assert.equal((await waitForCapture({ url: sp.url, waitMs: 1000, pollMs: 5, platform: "linux", open: (u) => opened.push(u), log: () => {} })).screen, true)
    assert.equal(opened.length, 0)
  } finally {
    await sp.close()
  }
  const down = await waitForCapture({ url: sp.url, waitMs: 1000, pollMs: 5, platform: "darwin", open: (u) => opened.push(u), log: () => {} })
  assert.equal(down.up, false)
  assert.equal(opened.length, 0)
})

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: clientDir, env })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("close", (code) => resolve({ code, out }))
  })
}

test("setup --skip-screenpipe --no-open : config, hooks, néon, sans rien toucher hors du dossier de test", async () => {
  const brain = await mockBrain()
  const home = tempDir("brain-setup-")
  try {
    const { code, out } = await runCli(["setup", "--url", brain.url, "--token", "cb_test_token_123456", "--skip-screenpipe", "--no-open"], {
      HOME: home,
      COMPANY_BRAIN_HOME: join(home, "brain"),
      COMPANY_BRAIN_SCRIPT: join(home, "brain", "brain.mjs"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      // PATH vide : ni `claude`, ni crontab, ni launchctl ; le test ne modifie rien sur la machine.
      PATH: join(home, "vide"),
    })
    assert.equal(code, 0, out)
    for (const step of ["[1/6]", "[2/6]", "[4/6]", "[5/6]", "[6/6]", "C'est branché"]) assert.ok(out.includes(step), `absent : ${step}\n${out}`)
    assert.match(out, /Connexion au cerveau OK : Hugo Bernard .*chez Fournil/)
    assert.match(out, /claude mcp add company-brain --scope user --/)
    const cfg = JSON.parse(readFileSync(join(home, "brain", "config.json"), "utf8"))
    assert.equal(cfg.token, "cb_test_token_123456")
    const settings = readFileSync(join(home, "claude", "settings.json"), "utf8")
    assert.match(settings, /brain\.mjs\\" hook/)
    assert.ok(brain.requests.some((r) => r.method === "POST" && r.url === "/api/events"))
    assert.ok(!existsSync(join(home, "brain", "screenpipe")))
  } finally {
    await brain.close()
  }
})

test("setup : Screenpipe qui ne démarre pas (bibliothèque manquante) → le reste est branché quand même, code 6", { skip: `${process.platform}-${process.arch}` !== "linux-x64" }, async () => {
  const brain = await mockBrain()
  const home = tempDir("brain-setup-nosp-")
  const brainDir = join(home, "brain")
  // Faux binaire Screenpipe « installé par le client », qui échoue comme sur une distribution trop ancienne.
  const bin = screenpipeBinPath(join(brainDir, "screenpipe"), "linux", "x64")!
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, "#!/bin/sh\necho 'screenpipe: error while loading shared libraries: libpipewire-0.3.so.0: cannot open shared object file' >&2\nexit 127\n", { mode: 0o755 })
  try {
    const { code, out } = await runCli(
      ["setup", "--url", brain.url, "--token", "cb_test_token_123456", "--screenpipe-url", "http://127.0.0.1:9", "--no-open"],
      {
        HOME: home,
        COMPANY_BRAIN_HOME: brainDir,
        COMPANY_BRAIN_SCRIPT: join(brainDir, "brain.mjs"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        PATH: join(home, "vide"),
      },
    )
    assert.equal(code, 6, out)
    assert.match(out, /Screenpipe ne démarre pas sur ce poste \(« screenpipe: error while loading shared libraries: libpipewire/)
    assert.match(out, /glibc ≥ 2\.39/)
    for (const step of ["[4/6]", "[5/6]", "[6/6]"]) assert.ok(out.includes(step), `étape sautée : ${step}\n${out}`)
    assert.match(out, /BRANCHÉ SANS SCREENPIPE : .* Détail et correction : .* doctor/)
    assert.match(readFileSync(join(home, "claude", "settings.json"), "utf8"), /brain\.mjs\\" hook/)
    assert.ok(brain.requests.some((r) => r.method === "POST" && r.url === "/api/events"), "néon envoyé")
  } finally {
    await brain.close()
  }
})

test("setup : Screenpipe déjà installé dans le PATH → lancé tel quel, rien n'est réinstallé", { skip: process.platform === "win32" }, async () => {
  const brain = await mockBrain()
  const home = tempDir("brain-setup-sp-")
  const brainDir = join(home, "brain")
  const binDir = join(home, "bin")
  const marker = join(home, "service-install")
  mkdirSync(binDir, { recursive: true })
  // Faux CLI installé à part (Homebrew, npm -g…) : `service install` note ses arguments ; Screenpipe « démarre » alors.
  writeFileSync(join(binDir, "screenpipe"), `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 })
  const sp = createServer((req, res) => {
    if (!existsSync(marker)) return req.socket.destroy()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(req.url?.startsWith("/health") ? ALL_GOOD : { data: [] }))
  })
  await new Promise<void>((r) => sp.listen(0, "127.0.0.1", r))
  const port = (sp.address() as { port: number }).port
  try {
    const { out } = await runCli(
      ["setup", "--url", brain.url, "--token", "cb_test_token_123456", "--screenpipe-url", `http://127.0.0.1:${port}`, "--no-open"],
      {
        HOME: home,
        COMPANY_BRAIN_HOME: brainDir,
        COMPANY_BRAIN_SCRIPT: join(brainDir, "brain.mjs"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        PATH: binDir,
      },
    )
    assert.ok(out.includes(`Screenpipe déjà installé sur le poste (${join(binDir, "screenpipe")}) : on s'en sert, sans le réinstaller.`), out)
    assert.match(readFileSync(marker, "utf8"), /^service install --record-args=--disable-audio --app-context memory/m)
    assert.ok(!existsSync(join(brainDir, "screenpipe")), "pas de seconde installation")
    assert.doesNotMatch(out, /Installation de Screenpipe/)
    assert.equal(JSON.parse(readFileSync(join(brainDir, "state.json"), "utf8")).screenpipe_bin, join(binDir, "screenpipe"))
    assert.match(out, /Screenpipe capture l'écran\./)
  } finally {
    sp.close()
    await brain.close()
  }
})
