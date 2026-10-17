import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { parseAuthToken, recordArgs, screenpipeBinPath } from "../src/screenpipe-cli"
import { MACOS_PANES, captureState, waitForCapture } from "../src/setup"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))

// Real answer of GET /health (Screenpipe 0.4.52) before any capture, shortened.
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

test("recordArgs: microphone off by default, \"memory\" context, media kept 14 days", () => {
  assert.deepEqual(recordArgs(), ["--disable-audio", "--app-context", "memory", "--retention-days", "14"])
  assert.ok(!recordArgs({ audio: true }).includes("--disable-audio"))
})

test("screenpipeBinPath: binary of the platform package, null if not published", () => {
  assert.equal(screenpipeBinPath("/h/sp", "darwin", "arm64"), join("/h/sp", "node_modules", "@screenpipe", "cli-darwin-arm64", "bin", "screenpipe"))
  assert.match(screenpipeBinPath("/h/sp", "win32", "x64") ?? "", /cli-win32-x64[\\/]bin[\\/]screenpipe\.exe$/)
  assert.equal(screenpipeBinPath("/h/sp", "linux", "arm64"), null)
})

test("parseAuthToken: ignores the logs, keeps the token line", () => {
  assert.equal(parseAuthToken("2026-10-17 INFO starting\nsp-0a1b2c3d\n"), "sp-0a1b2c3d")
  assert.equal(parseAuthToken("no API token found. start screenpipe first"), null)
})

test("captureState: reads /health (200 even when degraded)", () => {
  assert.deepEqual(captureState(null), { up: false, screen: false, accessibility: null })
  const s = captureState(NOT_STARTED)
  assert.equal(s.up, true)
  assert.equal(s.screen, false)
  assert.equal(s.accessibility, false)
  assert.equal(captureState(CAPTURING).screen, true)
  assert.equal(captureState(ALL_GOOD).accessibility, true)
  assert.equal(captureState({ frame_status: "ok" }).accessibility, null)
})

/** Fake Screenpipe: returns the /health answers in order, then the last one. */
async function fakeScreenpipe(sequence: unknown[]) {
  let i = 0
  return mockServer((req) => (req.url.startsWith("/health") ? { body: sequence[Math.min(i++, sequence.length - 1)] } : undefined))
}

test("waitForCapture (macOS): opens Screen Recording then Accessibility and resumes as soon as they are granted", async () => {
  const sp = await fakeScreenpipe([NOT_STARTED, NOT_STARTED, NOT_STARTED, CAPTURING, CAPTURING, ALL_GOOD])
  const opened: string[] = []
  const logs: string[] = []
  try {
    const st = await waitForCapture({ url: sp.url, waitMs: 5000, pollMs: 5, platform: "darwin", open: (u) => opened.push(u), log: (s) => logs.push(s) })
    assert.equal(st.screen, true)
    assert.equal(st.accessibility, true)
    assert.deepEqual(opened, [MACOS_PANES.screen, MACOS_PANES.accessibility])
    assert.ok(logs.some((l) => l.startsWith("✓ Screen Recording")))
    assert.ok(logs.some((l) => l.startsWith("✓ Accessibility")))
  } finally {
    await sp.close()
  }
})

test("waitForCapture (macOS): timeout → screen not allowed, Accessibility is not asked for", async () => {
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

test("waitForCapture: already allowed → nothing to open; Linux → no setting; Screenpipe off → up false", async () => {
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

test("setup --skip-screenpipe --no-open: config, hooks, neon, without touching anything outside the test folder", async () => {
  const brain = await mockBrain()
  const home = tempDir("brain-setup-")
  try {
    const { code, out } = await runCli(["setup", "--url", brain.url, "--token", "cb_test_token_123456", "--skip-screenpipe", "--no-open"], {
      HOME: home,
      COMPANY_BRAIN_HOME: join(home, "brain"),
      COMPANY_BRAIN_SCRIPT: join(home, "brain", "brain.mjs"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      // Empty PATH: no `claude`, crontab or launchctl; the test changes nothing on the machine.
      PATH: join(home, "empty"),
    })
    assert.equal(code, 0, out)
    for (const step of ["[1/6]", "[2/6]", "[4/6]", "[5/6]", "[6/6]", "It is connected"]) assert.ok(out.includes(step), `missing: ${step}\n${out}`)
    assert.match(out, /Connection to the brain OK: Hugo Bernard .*at Fournil/)
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

test("setup: Screenpipe that does not start (missing library) → the rest is connected anyway, code 6", { skip: `${process.platform}-${process.arch}` !== "linux-x64" }, async () => {
  const brain = await mockBrain()
  const home = tempDir("brain-setup-nosp-")
  const brainDir = join(home, "brain")
  // Fake Screenpipe binary "installed by the client", which fails as on a distribution that is too old.
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
        PATH: join(home, "empty"),
      },
    )
    assert.equal(code, 6, out)
    assert.match(out, /Screenpipe does not start on this computer \("screenpipe: error while loading shared libraries: libpipewire/)
    assert.match(out, /glibc ≥ 2\.39/)
    for (const step of ["[4/6]", "[5/6]", "[6/6]"]) assert.ok(out.includes(step), `step skipped: ${step}\n${out}`)
    assert.match(out, /CONNECTED WITHOUT SCREENPIPE: .* Details and fix: .* doctor/)
    assert.match(readFileSync(join(home, "claude", "settings.json"), "utf8"), /brain\.mjs\\" hook/)
    assert.ok(brain.requests.some((r) => r.method === "POST" && r.url === "/api/events"), "neon sent")
  } finally {
    await brain.close()
  }
})
