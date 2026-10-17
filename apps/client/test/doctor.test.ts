// brain doctor: read-only diagnosis, on a complete fake computer (fake brain, fake Screenpipe, fake `claude`,
// fake crontab) set up in a temporary folder. Nothing is read or written outside that folder.

import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
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

type Station = { root: string; home: string; script: string; claudeDir: string; bin: string; env: Record<string, string> }

/** A computer connected as setup would do it: config, shortcut, hooks, MCP and scheduled sync on the "current" client. */
function makeStation(brainUrl: string, spUrl: string, opts: { token?: string } = {}): Station {
  const root = tempDir("brain-doctor-")
  const home = join(root, "brain")
  const claudeDir = join(root, "claude")
  const bin = join(root, "bin")
  for (const d of [home, claudeDir, bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  // The "client": answers `_probe` like brain.mjs.
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
  // Fake `claude` (version) and fake crontab (our line), alone in the PATH.
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

async function doctorIn(station: Station): Promise<DoctorReport> {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(station.env)) {
    saved[k] = process.env[k]
    process.env[k] = station.env[k]
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

test("doctor: computer properly connected → no KO, code 0, every group checked", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  try {
    const r = await doctorIn(station)
    const fails = r.checks.filter((c) => c.status === "fail")
    assert.deepEqual(fails, [], formatDoctor(r))
    assert.equal(r.exit_code, 0)
    for (const id of ["shortcut", "config", "connection", "screenpipe", "capture", "screenpipe-token", "screenpipe-parsed", "claude", "mcp", "hooks", "schedule", "distillation"]) {
      assert.equal(byId(r, id)?.status, "ok", `${id}: ${JSON.stringify(byId(r, id))}`)
    }
    assert.match(byId(r, "connection")!.detail, /Hugo Bernard at Fournil/)
    assert.match(byId(r, "capture")!.detail, /screen capture active.*microphone: off/)
    // No token, not even in part, in text or JSON (the output ends up in the Claude Code session).
    // The start of the token, or its end behind "…" (maskSecret's form). Not the end alone: "3456" can be part
    // of the fake brain's random port or of a temporary folder.
    for (const out of [formatDoctor(r), JSON.stringify(r)]) {
      for (const secret of [TOKEN, SP_TOKEN]) assert.ok(!out.includes(secret.slice(0, 6)) && !out.includes(`…${secret.slice(-4)}`), `fragment of ${secret.slice(0, 3)}… shown`)
    }
    assert.match(formatDoctor(r), /^Summary: \d+ OK, \d+ to watch, 0 KO/m)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor: read-only (no file of the computer created or changed)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  const snapshot = () =>
    [station.home, station.claudeDir]
      .flatMap((d) => readdirSync(d).map((f) => join(d, f)))
      .map((f) => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`)
      .sort()
  try {
    const before = snapshot()
    await doctorIn(station)
    assert.deepEqual(snapshot(), before)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor: revoked token, connections to an old client, Screenpipe without permission → KO with the command that repairs", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe({ ...HEALTHY, status: "degraded", frame_status: "not_started", vision_reason: "permission_denied", last_frame_timestamp: null })
  const station = makeStation(brain.url, sp.url, { token: "cb_revoked_000000000000" })
  try {
    // Hooks, MCP and crontab left on a client that was moved.
    const old = join(station.root, "old", "brain.mjs")
    withEnv(station.env, () => {
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", script: old }))
      writeFileSync(join(station.claudeDir, "settings.json"), JSON.stringify(settings))
      writeFileSync(join(station.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: process.execPath, args: [old, "mcp"] } } }))
      writeFileSync(join(station.bin, "crontab"), `#!/bin/sh\necho ${JSON.stringify(cronLine(process.execPath, old, station.home, {}))}\n`, { mode: 0o755 })
    })
    const r = await doctorIn(station)
    assert.equal(r.exit_code, 1)
    const conn = byId(r, "connection")!
    assert.equal(conn.status, "fail")
    assert.match(conn.detail, /refuses this computer's token \(401\)/)
    assert.match(conn.fix!, /new install prompt/)
    assert.ok(!JSON.stringify(r).includes("cb_revoked_000000000000"))

    const hooks = byId(r, "hooks")!
    assert.equal(hooks.status, "fail")
    assert.match(hooks.detail, /does not start/)
    assert.match(hooks.command!, /install-hooks$/)
    assert.equal(hooks.safe, true)
    for (const id of ["mcp", "schedule"]) {
      assert.equal(byId(r, id)?.status, "fail", id)
      assert.match(byId(r, id)!.command!, /setup$/)
      assert.equal(byId(r, id)!.safe, true)
    }
    const cap = byId(r, "capture")!
    assert.equal(cap.status, "fail")
    assert.match(cap.detail, /refuses screen capture/)
    assert.match(cap.command!, /setup$/)
    // The first KO in the order of the diagnosis: the connection to the brain.
    assert.equal(r.next?.id, "connection")
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor: Screenpipe off, Screenpipe token refused, duplicated hooks", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  try {
    const cfgFile = join(station.home, "config.json")
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"))
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, screenpipe_token: "sp-wrong-token" }), { mode: 0o600 })
    const settingsFile = join(station.claudeDir, "settings.json")
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"))
    settings.hooks.Stop.push(structuredClone(settings.hooks.Stop[0]))
    writeFileSync(settingsFile, JSON.stringify(settings))
    let r = await doctorIn(station)
    assert.equal(byId(r, "screenpipe-token")?.status, "fail")
    assert.match(byId(r, "screenpipe-token")!.detail, /is refused/)
    assert.equal(byId(r, "hooks")?.status, "warn")
    assert.match(byId(r, "hooks")!.detail, /duplicated: Stop/)

    await sp.close()
    r = await doctorIn(station)
    const s = byId(r, "screenpipe")!
    assert.equal(s.status, "fail")
    assert.match(s.detail, /does not answer/)
    assert.match(s.command!, /setup$/)
    assert.equal(byId(r, "capture"), undefined, "nothing else to check without Screenpipe")

    // No crontab: running setup again would change nothing, cron must be installed.
    unlinkSync(join(station.bin, "crontab"))
    r = await doctorIn(station)
    assert.equal(byId(r, "schedule")?.status, "fail")
    assert.match(byId(r, "schedule")!.fix!, /Install cron/)
    assert.equal(byId(r, "schedule")!.command, undefined)
  } finally {
    await brain.close()
  }
})

test("doctor: scheduled sync failing and Claude signed out, read in sync.log (redacted)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  try {
    const now = new Date()
    const stamp = now.toLocaleString("en-GB")
    writeFileSync(
      join(station.home, "sync.log"),
      [
        `brain-sync — ${stamp}`,
        "Sources:",
        "  Claude Code is no longer signed in on this computer: the Claude token has expired or was revoked. Run `claude setup-token`…",
        "Sent: 0 knowledge items to the brain.",
        `[${now.toISOString()}] hook: Cannot reach the brain (${brain.url}): ECONNREFUSED ${TOKEN}`,
        "",
      ].join("\n"),
    )
    let r = await doctorIn(station)
    const auth = byId(r, "claude-signin")!
    assert.equal(auth.status, "fail")
    assert.match(auth.command!, /init --claude-token <token>$/)
    assert.equal(auth.safe, false, "never run without the employee")
    const hookErr = byId(r, "hook-errors")!
    assert.equal(hookErr.status, "warn")
    assert.ok(!hookErr.detail.includes(TOKEN), hookErr.detail)

    writeFileSync(join(station.home, "sync.log"), `brain-sync — ${stamp}\nCannot reach the brain (${brain.url}): fetch failed\n`)
    r = await doctorIn(station)
    assert.equal(byId(r, "log")?.status, "fail")
    assert.match(byId(r, "log")!.detail, /failed: "Cannot reach the brain/)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor run with another Node.js than the computer's: no false KO (reference: the shortcut)", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  // "Other" Node.js: the same binary under another path (hard link, otherwise a copy).
  const otherNode = join(station.root, "station-node")
  try {
    linkSync(process.execPath, otherNode)
  } catch {
    copyFileSync(process.execPath, otherNode)
    chmodSync(otherNode, 0o755)
  }
  try {
    withEnv(station.env, () => {
      writeFileSync(join(station.home, "brain"), `#!/bin/sh\nexec '${otherNode}' '${station.script}' "$@"\n`, { mode: 0o755 })
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", execPath: otherNode, script: station.script }))
      writeFileSync(join(station.claudeDir, "settings.json"), JSON.stringify(settings))
      writeFileSync(join(station.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: otherNode, args: mcpArgs(station.script) } } }))
      writeFileSync(join(station.bin, "crontab"), `#!/bin/sh\necho ${JSON.stringify(cronLine(otherNode, station.script, station.home, {}))}\n`, { mode: 0o755 })
    })
    const r = await doctorIn(station)
    for (const id of ["shortcut", "mcp", "hooks", "schedule"]) assert.equal(byId(r, id)?.status, "ok", `${id}: ${byId(r, id)?.detail}`)

    // A hook left on the process's Node.js (not the shortcut's): reported as such.
    withEnv(station.env, () => {
      const { settings } = mergeHooks({}, hookEntry({ platform: "linux", execPath: process.execPath, script: station.script }))
      writeFileSync(join(station.claudeDir, "settings.json"), JSON.stringify(settings))
    })
    const r2 = await doctorIn(station)
    assert.equal(byId(r2, "hooks")?.status, "fail")
    assert.match(byId(r2, "hooks")!.detail, /starts another Node\.js/)
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor: a \"company-brain\" MCP that is not our client is never started", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  const marker = join(station.root, "started")
  try {
    writeFileSync(join(station.bin, "npx"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    writeFileSync(join(station.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "company-brain": { command: join(station.bin, "npx"), args: ["-y", "another-server"] } } }))
    const r = await doctorIn(station)
    assert.equal(byId(r, "mcp")?.status, "fail")
    assert.match(byId(r, "mcp")!.detail, /not the brain client/)
    assert.ok(!existsSync(marker), "the saved command was started")
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor without a config: config KO first, the rest checked anyway", { skip: !POSIX }, async () => {
  const brain = await mockBrain()
  const sp = await fakeScreenpipe(HEALTHY)
  const station = makeStation(brain.url, sp.url)
  try {
    writeFileSync(join(station.home, "config.json"), "")
    const r = await doctorIn(station)
    assert.equal(byId(r, "config")?.status, "fail")
    assert.equal(r.next?.id, "config")
    assert.equal(byId(r, "connection")?.status, "skip")
    assert.equal(byId(r, "hooks")?.status, "ok")

    // Request to join waiting for an admin: doctor says so, and join is the command that resumes it.
    unlinkSync(join(station.home, "config.json"))
    writeFileSync(join(station.home, "join.json"), JSON.stringify({ url: brain.url, id: "req-1", token: "cb_secret_join_token_000", org: "Fournil" }))
    const p = await doctorIn(station)
    assert.match(byId(p, "config")!.detail, /join Fournil not accepted yet/)
    assert.match(byId(p, "config")!.command!, / join$/)
    assert.ok(!JSON.stringify(p).includes("cb_secret_join_token_000"))
  } finally {
    await Promise.all([brain.close(), sp.close()])
  }
})

test("doctor --json: a single JSON object on the output, code 1 if a KO is left", { skip: !POSIX }, async () => {
  const root = tempDir("brain-doctor-cli-")
  const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--json"], {
      cwd: clientDir,
      env: { HOME: root, COMPANY_BRAIN_HOME: join(root, "brain"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: join(root, "empty") },
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

test("captureDiagnosis: vision_reason first (permission, pause, stall), then the age of the last frame", () => {
  const now = Date.parse("2026-10-17T10:00:00Z")
  assert.equal(captureDiagnosis({ vision_reason: "permission_denied" }, "darwin", now).status, "fail")
  assert.match(captureDiagnosis({ vision_reason: "permission_denied" }, "darwin", now).detail, /macOS does not allow/)
  assert.equal(captureDiagnosis({ vision_reason: "screenshots_disabled_by_power_profile" }, "darwin", now).status, "info")
  assert.equal(captureDiagnosis({ vision_reason: "capture_stalled" }, "linux", now).reason, "stalled")
  assert.equal(captureDiagnosis({ frame_status: "not_started", last_frame_timestamp: null }, "darwin", now).reason, "not-started")
  assert.equal(captureDiagnosis({ frame_status: "stale", last_frame_timestamp: "2026-10-17T08:00:00Z" }, "linux", now).status, "warn")
  const ok = captureDiagnosis({ frame_status: "ok", vision_reason: "ok", last_frame_timestamp: "2026-10-17T09:58:00Z" }, "darwin", now)
  assert.equal(ok.status, "ok")
  assert.match(ok.detail, /2 min ago/)
})

test("lastLoggedRun / recentHookErrors: last sync of the log, hook errors over 24 h", () => {
  const log = [
    "brain-sync — 16/10/2026, 09:00:00",
    "Sent: 3 knowledge items to the brain.",
    "brain-sync — 17/10/2026, 09:15:00 (dry run: nothing will be sent)",
    "brain-sync — 17/10/2026, 09:30:00",
    "[2026-10-17T09:30:01.000Z] hook: timeout exceeded",
    "The brain answered 500",
  ].join("\n")
  const run = lastLoggedRun(log)!
  assert.equal(run.sent, false)
  assert.equal(run.auth, false)
  assert.equal(run.error, "The brain answered 500")
  assert.equal(new Date(run.at!).getHours(), 9)
  assert.equal(lastLoggedRun("nothing"), null)
  assert.deepEqual(recentHookErrors(log, Date.parse("2026-10-17T10:00:00Z")), { count: 1, last: "timeout exceeded" })
  assert.equal(recentHookErrors(log, Date.parse("2026-10-19T10:00:00Z")).count, 0)
  // Logs written in French by clients older than the English switch stay readable (intentional French).
  const legacy = ["brain-sync — 17/10/2026 09:30:00", "[2026-10-17T09:30:01.000Z] hook : délai dépassé", "Envoyé : 3 connaissances au cerveau.", "Jeton refusé par le cerveau (401)"].join("\n")
  assert.deepEqual(lastLoggedRun(legacy), { at: run.at, sent: true, auth: false, error: "Jeton refusé par le cerveau (401)" })
  assert.equal(recentHookErrors(legacy, Date.parse("2026-10-17T10:00:00Z")).count, 1)
})

test("reinstallCommand: the install command of the system, without the token (the config keeps it)", () => {
  assert.equal(
    reinstallCommand("https://c.example", "darwin"),
    "(curl -fsSL --create-dirs https://c.example/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://c.example",
  )
  assert.match(reinstallCommand("https://c.example", "win32"), /install\.ps1" --url https:\/\/c\.example; exit \$LASTEXITCODE$/)
  assert.ok(!/--token/.test(reinstallCommand("https://c.example", "win32")))
  // Self-hosted brain: the certificate already on the computer serves the download and goes back to setup (--ca).
  assert.equal(
    reinstallCommand("https://c.example", "linux", "/home/jm/.company-brain/ca.crt"),
    '(curl -fsSL --cacert "/home/jm/.company-brain/ca.crt" --create-dirs https://c.example/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://c.example --ca "/home/jm/.company-brain/ca.crt"',
  )
  const win = reinstallCommand("https://c.example", "win32", "C:\\Users\\jm\\.company-brain\\ca.crt")
  assert.ok(win.endsWith('install.ps1" --url https://c.example --ca "C:\\Users\\jm\\.company-brain\\ca.crt"; exit $LASTEXITCODE'), win)
})
