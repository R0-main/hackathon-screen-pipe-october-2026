import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { parseAuthToken, recordArgs, screenpipeBinPath } from "../src/screenpipe-cli"
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
