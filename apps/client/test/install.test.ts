import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { applyScheduleEnv, quoteArg, selfCommand, type State } from "../src/config"
import { spawnTarget } from "../src/distill"
import {
  baselineSources,
  cronLine,
  hookCommand,
  hookEntry,
  hooksInstalled,
  installHooks,
  isOurHook,
  launchdPlist,
  mcpArgs,
  mcpUpToDate,
  mergeCrontab,
  mergeHooks,
  parseCronTarget,
  parsePlistTarget,
  parseTaskXmlTarget,
  prepareSchedule,
  readMcpEntry,
  removeFromCrontab,
  removeHooks,
  scheduleEnv,
  uninstallHooks,
  versionLt,
  windowsTaskArgs,
} from "../src/install"
import { tempDir } from "./helpers"

const CMD = hookCommand("/usr/bin/node", "/home/u/.company-brain/brain.mjs")

const foreign = {
  model: "opus",
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
}

test("mergeHooks: adds our 3 hooks, keeps foreign hooks and the order, idempotent", () => {
  const { settings, changes } = mergeHooks(foreign, CMD)
  assert.equal(changes.length, 3)
  assert.deepEqual(Object.keys(settings), ["model", "permissions", "hooks"])
  const hooks = settings.hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>
  assert.equal(hooks.PreToolUse[0].hooks[0].command, "./guard.sh")
  assert.equal(hooks.Stop[0].hooks[0].command, "say done")
  assert.equal(hooks.Stop[1].hooks[0].command, CMD)
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].command, CMD)
  assert.equal(hooks.SessionStart[0].hooks[0].timeout, 5)
  assert.equal(CMD, '"/usr/bin/node" "/home/u/.company-brain/brain.mjs" hook')

  const again = mergeHooks(settings, CMD)
  assert.deepEqual(again.changes, [])
  assert.deepEqual(again.settings, settings)

  // The script path changes: the command is updated, not duplicated.
  const moved = mergeHooks(settings, hookCommand("/opt/node", "/new/brain.mjs"))
  assert.equal(moved.changes.length, 3)
  const mh = moved.settings.hooks as Record<string, { hooks: { command: string }[] }[]>
  assert.equal(mh.Stop.length, 2)
  assert.equal(mh.Stop[1].hooks[0].command, '"/opt/node" "/new/brain.mjs" hook')
})

test("removeHooks: removes only our hooks", () => {
  const { settings } = mergeHooks(foreign, CMD)
  const { settings: cleaned, removed } = removeHooks(settings)
  assert.equal(removed, 3)
  assert.deepEqual(cleaned, foreign)
  assert.deepEqual(removeHooks({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: CMD }] }] } }).settings, {})
})

test("installHooks / uninstallHooks on a real file: backup, idempotence, uninstall", () => {
  const dir = tempDir()
  process.env.COMPANY_BRAIN_SCRIPT = join(dir, "brain.mjs")
  const file = join(dir, "settings.json")
  writeFileSync(file, JSON.stringify(foreign, null, 2))
  const logs: string[] = []
  const r1 = installHooks((s) => logs.push(s), file)
  assert.equal(r1.changes.length, 3)
  assert.ok(r1.backup && readdirSync(dir).some((f) => f.startsWith("settings.json.bak-")))
  assert.ok(hooksInstalled(file))
  const r2 = installHooks((s) => logs.push(s), file)
  assert.equal(r2.changes.length, 0)
  assert.equal(uninstallHooks(() => {}, file), 3)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), foreign)
  assert.ok(!hooksInstalled(file))
})

test("installHooks: refuses an invalid settings.json without overwriting it", () => {
  const dir = tempDir()
  const file = join(dir, "settings.json")
  writeFileSync(file, "{ not json")
  assert.throws(() => installHooks(() => {}, file), /is not valid JSON/)
  assert.equal(readFileSync(file, "utf8"), "{ not json")
})

test("crontab: idempotent line, other lines kept, removal", () => {
  const line = cronLine("/usr/bin/node", "/home/u/.company-brain/brain.mjs", "/home/u/.company-brain")
  assert.equal(line, '*/15 * * * * "/usr/bin/node" "/home/u/.company-brain/brain.mjs" sync --scheduled >> "/home/u/.company-brain/sync.log" 2>&1')
  const existing = "MAILTO=\"\"\n0 3 * * * /usr/local/bin/backup\n"
  const a = mergeCrontab(existing, line)
  assert.equal(a.changed, true)
  assert.equal(a.text, `${existing}${line}\n`)
  assert.equal(mergeCrontab(a.text, line).changed, false)
  const moved = mergeCrontab(a.text, cronLine("/opt/node", "/x/brain.mjs", "/x", { PATH: "/opt/node:/usr/bin" }))
  assert.equal(moved.text.split("\n").filter((l) => l.includes("brain.mjs")).length, 1)
  const r = removeFromCrontab(a.text)
  assert.equal(r.removed, 1)
  assert.equal(r.text, existing)
  assert.equal(mergeCrontab("", line).text, `${line}\n`)
  // The old line (without --scheduled or environment) is replaced, not duplicated.
  const old = '*/15 * * * * "/usr/bin/node" "/home/u/.company-brain/brain.mjs" sync >> "/home/u/.company-brain/sync.log" 2>&1\n'
  assert.equal(mergeCrontab(old, line).text, `${line}\n`)
})

test("crontab: the environment noted at install time is passed on (PATH, folders), quotes and % escaped", () => {
  const line = cronLine("/usr/bin/node", "/h/brain.mjs", "/h", { PATH: "/opt/node/bin:/home/u/.local/bin", CLAUDE_CONFIG_DIR: "/home/u/my folder", CODEX_HOME: "/x'y%z" })
  assert.equal(
    line,
    `*/15 * * * * PATH='/opt/node/bin:/home/u/.local/bin' CLAUDE_CONFIG_DIR='/home/u/my folder' CODEX_HOME='/x'\\''y\\%z' "/usr/bin/node" "/h/brain.mjs" sync --scheduled >> "/h/sync.log" 2>&1`,
  )
})

test("crontab: run as cron does (minimal env), the command sees PATH and the custom folders", { skip: process.platform === "win32" }, () => {
  const dir = tempDir()
  const script = join(dir, "brain.mjs")
  // Fake brain.mjs: writes the environment it received to the log.
  writeFileSync(
    script,
    "console.log(JSON.stringify({ path: process.env.PATH, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, home: process.env.COMPANY_BRAIN_HOME, argv: process.argv.slice(2) }))\n",
  )
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho claude\n")
  chmodSync(join(bin, "claude"), 0o755)
  const env = scheduleEnv({ PATH: `${bin}${delimiter}/usr/bin${delimiter}relative`, CLAUDE_CONFIG_DIR: join(dir, "claude cfg"), CODEX_HOME: join(dir, "codex") }, process.execPath, dir)
  const line = cronLine(process.execPath, script, dir, env)
  const cmd = line.replace(/^(\S+\s+){5}/, "").replace(/\\%/g, "%")
  const r = spawnSync("/bin/sh", ["-c", cmd], { env: { HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  const got = JSON.parse(readFileSync(join(dir, "sync.log"), "utf8").trim())
  assert.deepEqual(got.argv, ["sync", "--scheduled"])
  assert.equal(got.claude, join(dir, "claude cfg"))
  assert.equal(got.codex, join(dir, "codex"))
  assert.equal(got.home, dir)
  const pathDirs = String(got.path).split(delimiter)
  assert.ok(pathDirs.includes(bin), "the folder of `claude` must be in the task's PATH")
  assert.ok(!pathDirs.includes("relative"))
})

test("scheduleEnv: absolute PATH (node, claude, current PATH), folders only if they are set", () => {
  const env = scheduleEnv({ PATH: `/usr/local/bin${delimiter}.${delimiter}/usr/bin` }, "/opt/node22/bin/node", "/h")
  assert.equal(env.PATH.split(delimiter)[0], "/opt/node22/bin")
  assert.ok(!env.PATH.split(delimiter).includes("."))
  assert.equal(env.COMPANY_BRAIN_HOME, "/h")
  assert.ok(!("CLAUDE_CONFIG_DIR" in env) && !("CODEX_HOME" in env))
})

test("applyScheduleEnv: completes the environment without overwriting, merges the PATH", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", CODEX_HOME: "/already" }
  applyScheduleEnv({ schedule_env: { PATH: "/opt/node/bin:/usr/bin", CLAUDE_CONFIG_DIR: "/cfg", CODEX_HOME: "/other" } }, env)
  assert.equal(env.PATH, ["/usr/bin", "/bin", "/opt/node/bin"].join(delimiter))
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg")
  assert.equal(env.CODEX_HOME, "/already")
})

test("prepareSchedule: the scheduled sync starts from now (baseline) and the environment is noted in the config", () => {
  const home = tempDir()
  const prev = process.env.COMPANY_BRAIN_HOME
  const prevDirs = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tempDir()
  process.env.CODEX_HOME = tempDir()
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://x", token: "cb_test_token_123456" }))
    writeFileSync(join(home, "state.json"), JSON.stringify({ claude: { files: { "/a.jsonl": { offset: 10, size: 10, mtime: 1 } } } }))
    const before = Date.now()
    const logs: string[] = []
    prepareSchedule({ PATH: "/usr/bin", COMPANY_BRAIN_HOME: home }, (s) => logs.push(s))
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"))
    assert.ok(Date.parse(state.baseline_at) >= before)
    assert.deepEqual(state.claude.files["/a.jsonl"], { offset: 10, size: 10, mtime: 1 })
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    assert.deepEqual(cfg.schedule_env, { PATH: "/usr/bin", COMPANY_BRAIN_HOME: home })
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600)
    assert.match(logs.join("\n"), /starts from now/)
  } finally {
    if (prev === undefined) delete process.env.COMPANY_BRAIN_HOME
    else process.env.COMPANY_BRAIN_HOME = prev
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", prevDirs[0]], ["CODEX_HOME", prevDirs[1]]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("PRIVACY-8b baselineSources: Screenpipe at now, every Claude / Codex file at its end, internal sessions spotted", () => {
  const claude = tempDir()
  const codex = tempDir()
  const proj = join(claude, "projects", "p")
  const day = join(codex, "sessions", "2026", "10", "16")
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(proj, "subagents"), { recursive: true })
  mkdirSync(day, { recursive: true })
  const l = (o: unknown) => JSON.stringify(o) + "\n"
  const known = join(proj, "known.jsonl")
  const fresh = join(proj, "fresh.jsonl")
  const install = join(proj, "install.jsonl")
  const partial = join(day, "rollout-a.jsonl")
  writeFileSync(known, l({ type: "user", message: { role: "user", content: "a" } }) + l({ type: "user", message: { role: "user", content: "b" } }))
  writeFileSync(fresh, l({ type: "user", message: { role: "user", content: "c" } }))
  writeFileSync(install, l({ type: "user", message: { role: "user", content: "You are going to connect this computer to NOS Brainer, Fournil's company brain." } }) + l({ type: "assistant", message: { role: "assistant", content: "OK" } }))
  const done = l({ type: "response_item", payload: { type: "message", role: "user", content: "q" } })
  writeFileSync(partial, done + '{"type":"response_item","payload":{"type":"mess')
  writeFileSync(join(proj, "subagents", "s.jsonl"), l({ type: "user" }))
  const state: State = { claude: { files: { [known]: { offset: 3, size: 3, mtime: 1 } } }, screenpipe: { last_timestamp: "2026-10-10T00:00:00.000Z", span_ms: 60000 } }
  const at = new Date()
  const r = baselineSources(state, at, { claudeDir: claude, codexDir: codex, secrets: [], brainHome: "/nowhere" })
  assert.equal(state.baseline_at, at.toISOString())
  assert.equal(state.screenpipe?.last_timestamp, at.toISOString())
  assert.equal(state.screenpipe?.span_ms, 60000)
  assert.equal(state.claude?.files[known].offset, statSync(known).size)
  assert.equal(state.claude?.files[fresh].offset, statSync(fresh).size)
  assert.equal(state.claude?.files[install].internal, true)
  assert.equal(state.claude?.files[fresh].internal, undefined)
  // Last line still being written: the offset stops before it.
  assert.equal(state.codex?.files[partial].offset, Buffer.byteLength(done))
  assert.equal(Object.keys(state.claude?.files ?? {}).some((f) => f.includes("subagents")), false)
  assert.deepEqual(r, { files: 4, internal: 1 })
  // A Screenpipe checkpoint that is already more recent is not moved back.
  const later: State = { screenpipe: { last_timestamp: "2999-01-01T00:00:00.000Z" } }
  baselineSources(later, at, { claudeDir: tempDir(), codexDir: tempDir() })
  assert.equal(later.screenpipe?.last_timestamp, "2999-01-01T00:00:00.000Z")
})

test("F-claude-token: the Claude Code token is never written in the crontab, the plist or schedule_env", () => {
  const token = ["sk-ant-", "oat01-", "Zq9", "y".repeat(40)].join("")
  const env = scheduleEnv({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: token }, "/usr/local/bin/node", "/h/.company-brain")
  assert.deepEqual(Object.keys(env).sort(), ["COMPANY_BRAIN_HOME", "PATH"])
  const cron = cronLine("/usr/local/bin/node", "/h/brain.mjs", "/h/.company-brain", env)
  const plist = launchdPlist("/usr/local/bin/node", "/h/brain.mjs", "/h/.company-brain", env)
  for (const text of [cron, plist, JSON.stringify(env)]) {
    assert.ok(!text.includes(token))
    assert.ok(!text.includes("CLAUDE_CODE_OAUTH_TOKEN"))
  }
})

test("launchd and schtasks: generated content (no run on load, environment passed on)", () => {
  const plist = launchdPlist("/usr/local/bin/node", "/Users/u/.company-brain/brain.mjs", "/Users/u/.company-brain", {
    PATH: "/usr/local/bin:/Users/u/.local/bin:/usr/bin",
    CLAUDE_CONFIG_DIR: "/Users/u/claude & co",
  })
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.ok(!plist.includes("<true/>"))
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/u\/.company-brain\/brain.mjs<\/string>\s*<string>sync<\/string>\s*<string>--scheduled<\/string>/)
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/u\/.company-brain\/sync.log<\/string>/)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/Users\/u\/.local\/bin:\/usr\/bin<\/string>/)
  assert.match(plist, /<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/Users\/u\/claude &amp; co<\/string>/)
  assert.match(plist, /<key>COMPANY_BRAIN_HOME<\/key>\s*<string>\/Users\/u\/.company-brain<\/string>/)
  assert.match(plist, /com\.company-brain\.sync/)
  const args = windowsTaskArgs("C:\\node\\node.exe", "C:\\Users\\u\\.company-brain\\brain.mjs")
  assert.deepEqual(args.slice(0, 7), ["/Create", "/SC", "MINUTE", "/MO", "15", "/TN", "CompanyBrainSync"])
  assert.equal(args[8], '"C:\\node\\node.exe" "C:\\Users\\u\\.company-brain\\brain.mjs" sync --scheduled')
  const custom = windowsTaskArgs("C:\\node\\node.exe", "C:\\b\\brain.mjs", "D:\\brain")
  assert.equal(custom[8], '"C:\\node\\node.exe" "C:\\b\\brain.mjs" sync --scheduled --home "D:\\brain"')
  assert.ok(custom[8].length <= 261)
})

test("hookEntry: \"exec\" form on Windows (PowerShell does not read the line), command line elsewhere or if Claude Code is too old", () => {
  const win = hookEntry({ platform: "win32", claudeVersion: "2.1.302", execPath: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\Jean Dupont\\.company-brain\\brain.mjs" })
  assert.equal(win.command, "C:\\Program Files\\nodejs\\node.exe")
  assert.deepEqual((win.args as string[]).slice(0, 2), ["C:\\Users\\Jean Dupont\\.company-brain\\brain.mjs", "hook"])
  assert.ok(isOurHook(win))
  assert.notEqual(hookEntry({ platform: "win32", claudeVersion: null, gitBash: false }).args, undefined, "unknown version, without Git Bash: exec form")
  assert.equal(hookEntry({ platform: "win32", claudeVersion: null, gitBash: true }).args, undefined, "unknown version, with Git Bash: command line")
  const old = hookEntry({ platform: "win32", claudeVersion: "2.1.100", execPath: "C:\\n\\node.exe", script: "C:\\b\\brain.mjs" })
  assert.equal(old.args, undefined)
  assert.match(String(old.command), /"C:\\n\\node\.exe" "C:\\b\\brain\.mjs" hook/)
  assert.equal(hookEntry({ platform: "darwin", claudeVersion: "2.1.302" }).args, undefined)
  assert.ok(versionLt("2.1.38", "2.1.139"))
  assert.ok(!versionLt("2.1.139", "2.1.139"))
  assert.ok(!versionLt("2.10.0", "2.1.139"))
})

test("mergeHooks: turns a command line into the \"exec\" form and removes our duplicates, without touching the other hooks", () => {
  const exec = { type: "command", command: "C:\\node.exe", args: ["C:\\b\\brain.mjs", "hook"], timeout: 5 }
  const dup = mergeHooks(foreign, CMD).settings as { hooks: Record<string, { hooks: unknown[] }[]> }
  dup.hooks.Stop.push({ hooks: [{ type: "command", command: '"/old/node" "/old/brain.mjs" hook' }] })
  const { settings, changes } = mergeHooks(dup, exec)
  assert.ok(changes.includes("Stop: 1 duplicate(s) removed"), changes.join(" | "))
  const hooks = settings.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>
  assert.equal(hooks.Stop.length, 2, "the emptied group goes away, the foreign hook stays")
  assert.equal(hooks.Stop[0].hooks[0].command, "say done")
  assert.deepEqual(hooks.Stop[1].hooks[0], exec)
  assert.deepEqual(mergeHooks(settings, exec).changes, [])
  // Back to the command line: "args" goes away.
  const back = mergeHooks(settings, CMD).settings.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>
  assert.equal(back.Stop[1].hooks[0].args, undefined)
  assert.equal(back.Stop[1].hooks[0].command, CMD)
  assert.equal(removeHooks(settings).removed, 3)

  // Several copies: we keep the one that always fires (no filter), not an old one limited to "startup".
  const filtered = {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: '"/old/node" "/old/brain.mjs" hook' }] },
        { hooks: [{ type: "command", command: CMD, timeout: 5 }] },
      ],
    },
  }
  const kept = mergeHooks(filtered, CMD).settings.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>
  assert.equal(kept.SessionStart.length, 1)
  assert.equal(kept.SessionStart[0].matcher, undefined)
  assert.equal(kept.SessionStart[0].hooks[0].command, CMD)
})

test("scheduled sync targets: read back from the plist, the crontab line and the XML of the Windows task", () => {
  const plist = launchdPlist("/Users/u/.company-brain/node/bin/node", "/Users/u/.company-brain/brain.mjs", "/Users/u/.company-brain", {})
  assert.deepEqual(parsePlistTarget(plist), { execPath: "/Users/u/.company-brain/node/bin/node", script: "/Users/u/.company-brain/brain.mjs", home: "/Users/u/.company-brain" })
  const line = cronLine("/usr/bin/node", "/h/my folder/brain.mjs", "/h/the team's", { COMPANY_BRAIN_HOME: "/h/the team's" })
  assert.deepEqual(parseCronTarget(line), { execPath: "/usr/bin/node", script: "/h/my folder/brain.mjs", home: "/h/the team's" })
  const xmlText = `<Task><Actions><Exec><Command>"C:\\Program Files\\nodejs\\node.exe"</Command><Arguments>"C:\\Users\\u\\.company-brain\\brain.mjs" sync --scheduled --home "D:\\brain"</Arguments></Exec></Actions></Task>`
  assert.deepEqual(parseTaskXmlTarget(xmlText), { execPath: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\u\\.company-brain\\brain.mjs", home: "D:\\brain" })
  assert.equal(parseTaskXmlTarget("<Task/>"), undefined)
})

test("MCP: entry read back from .claude.json, up to date only if it runs this Node.js and this script", () => {
  const dir = tempDir("brain-mcp-")
  const file = join(dir, ".claude.json")
  assert.equal(readMcpEntry(file), null, "no file: no MCP")
  writeFileSync(file, "{ not json")
  assert.equal(readMcpEntry(file), undefined)
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }))
  assert.equal(readMcpEntry(file), null)
  const script = join(dir, "brain.mjs")
  writeFileSync(script, "")
  writeFileSync(file, JSON.stringify({ mcpServers: { "company-brain": { type: "stdio", command: process.execPath, args: mcpArgs(script), env: {} } } }))
  const e = readMcpEntry(file)!
  assert.ok(mcpUpToDate(e, process.execPath, script))
  assert.ok(!mcpUpToDate(e, process.execPath, join(dir, "other.mjs")))
  assert.ok(!mcpUpToDate({ command: process.execPath, args: [script, "hook"] }, process.execPath, script))
})

test("spawnTarget: on Windows, a .cmd goes through the shell with quoted paths; an .exe runs directly", () => {
  const cmd = spawnTarget("C:\\Users\\Jean Dupont\\AppData\\Roaming\\npm\\claude.cmd", ["-p", "--tools", ""], "win32")
  assert.equal(cmd.shell, true)
  assert.equal(cmd.cmd, '"C:\\Users\\Jean Dupont\\AppData\\Roaming\\npm\\claude.cmd"')
  assert.deepEqual(cmd.args, ["-p", "--tools", '""'])
  const exe = spawnTarget("C:\\Users\\Jean Dupont\\.local\\bin\\claude.exe", ["-p", ""], "win32")
  assert.deepEqual(exe, { cmd: "C:\\Users\\Jean Dupont\\.local\\bin\\claude.exe", args: ["-p", ""], shell: false })
  assert.equal(spawnTarget("/usr/bin/claude", ["-p"], "linux").shell, false)
})

test("selfCommand: the shortcut if it exists (quoted if the folder is custom), otherwise Node.js and the script", () => {
  const home = tempDir("brain-self-")
  const saved = process.env.COMPANY_BRAIN_HOME
  process.env.COMPANY_BRAIN_HOME = join(home, "my brain")
  try {
    assert.match(selfCommand("linux"), /^\S+ \S+$|^'.*' '.*'$|^\S+ '.*'$/)
    mkdirSync(join(home, "my brain"))
    writeFileSync(join(home, "my brain", "brain"), "")
    assert.equal(selfCommand("linux"), `'${join(home, "my brain", "brain")}'`)
    writeFileSync(join(home, "my brain", "brain.cmd"), "")
    assert.equal(selfCommand("win32"), `"${join(home, "my brain", "brain.cmd")}"`)
  } finally {
    if (saved === undefined) delete process.env.COMPANY_BRAIN_HOME
    else process.env.COMPANY_BRAIN_HOME = saved
  }
  assert.equal(quoteArg("/a b/c'd", "linux"), `'/a b/c'\\''d'`)
  // Windows: forward slashes (Git Bash drops "\\" outside quotes), double quotes if there is a space.
  assert.equal(quoteArg("C:\\Program Files\\nodejs\\node.exe", "win32"), '"C:/Program Files/nodejs/node.exe"')
  assert.equal(quoteArg("C:\\Users\\jean\\.company-brain\\brain.mjs", "win32"), "C:/Users/jean/.company-brain/brain.mjs")
  assert.equal(quoteArg("/usr/bin/node", "linux"), "/usr/bin/node")
})
