// Local install: Claude Code hooks (settings.json), scheduled sync (launchd / crontab / schtasks),
// "brain-sync" Screenpipe pipe (~/.screenpipe/pipes), uninstall.

import { spawnSync } from "node:child_process"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { DISTILL_MARKER } from "@brain/core"
import { brainHome, claudeDir, codexDir, customHome, loadPartialConfig, loadState, paths, quoteArg, saveConfig, saveState, selfScript, type FileCheckpoint, type State } from "./config"
import { findOnPath, spawnTarget } from "./distill"
import { isBrainSetupText, ownSecrets } from "./secrets"
import { completeLinesEnd, listJsonlFiles } from "./sources/jsonl"
import { uninstallScreenpipeService } from "./screenpipe-cli"
import { removeInstalledSkills } from "./skills"

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const
export const HOOK_TIMEOUT_S = 5
const OUR_HOOK_RE = /brain\.mjs"?\s+hook\b/
export const OUR_SYNC_RE = /brain\.mjs"?\s+sync\b/

export type HookCommand = { type?: string; command?: string; args?: unknown; timeout?: number; [k: string]: unknown }
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
export type Settings = { hooks?: Record<string, HookGroup[] | unknown>; [k: string]: unknown }

/** Client arguments after Node.js: the client folder follows when it is customized (hooks and MCP do not inherit the environment). */
function clientArgs(script: string, cmd: string): string[] {
  return [script, cmd, ...(customHome() ? ["--home", brainHome()] : [])]
}

export function hookArgs(script = selfScript()): string[] {
  return clientArgs(script, "hook")
}

/** "Shell" form: a line passed to sh (macOS, Linux) or to Git Bash (Windows). */
export function hookCommand(execPath = process.execPath, script = selfScript()): string {
  return [execPath, ...hookArgs(script)].map((a) => (a === "hook" || a === "--home" ? a : `"${a}"`)).join(" ")
}

/** Claude Code version from which a hook can be started without a shell (`command` + `args`). */
export const EXEC_HOOKS_SINCE = "2.1.139"

/** Git Bash (Windows): without it, Claude Code passes the hooks' command line to PowerShell. */
export function gitBashInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ]
  const git = findOnPath("git", env.PATH ?? "")
  if (git) candidates.push(join(dirname(dirname(git)), "bin", "bash.exe"))
  return candidates.some((c) => Boolean(c) && existsSync(c!))
}

/**
 * Our hook. Windows: "exec" form (node.exe started directly with its arguments), because without Git Bash Claude Code
 * passes the line to PowerShell, which does not accept `"node.exe" "brain.mjs" hook`. Unknown Claude Code version: the
 * "exec" form only if there is no Git Bash (otherwise the command line, which has always worked there).
 * Elsewhere, or with a Claude Code too old for the "exec" form, the usual command line.
 */
export function hookEntry(
  opts: { platform?: NodeJS.Platform; claudeVersion?: string | null; gitBash?: boolean; execPath?: string; script?: string } = {},
): HookCommand {
  const { platform = process.platform, claudeVersion = null, execPath = process.execPath, script = selfScript() } = opts
  const exec =
    platform === "win32" && (claudeVersion ? !versionLt(claudeVersion, EXEC_HOOKS_SINCE) : !(opts.gitBash ?? gitBashInstalled()))
  return exec
    ? { type: "command", command: execPath, args: hookArgs(script), timeout: HOOK_TIMEOUT_S }
    : { type: "command", command: hookCommand(execPath, script), timeout: HOOK_TIMEOUT_S }
}

/** "2.1.38" < "2.1.139" (numeric comparison, component by component). */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}

/** Installed Claude Code version (`claude --version` → "2.1.302 (Claude Code)"), or null. */
export function claudeCodeVersion(claude = findOnPath("claude")): string | null {
  if (!claude) return null
  const t = spawnTarget(claude, ["--version"])
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: 15_000, shell: t.shell, windowsHide: true, env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout ?? ""}`)?.[1] ?? null
}

/** The full command line of a hook, whatever its form (string alone, or command and arguments). */
export function hookText(h: unknown): string {
  if (typeof h === "string") return h
  if (!h || typeof h !== "object") return ""
  const { command, args } = h as HookCommand
  return [typeof command === "string" ? command : "", ...(Array.isArray(args) ? args.map(String) : [])].join(" ")
}

/** One of our hooks (accepts the hook object or only its command). */
export function isOurHook(h: unknown): boolean {
  return OUR_HOOK_RE.test(hookText(h))
}

function sameHook(h: HookCommand, want: HookCommand): boolean {
  return h.type === want.type && h.command === want.command && JSON.stringify(h.args ?? null) === JSON.stringify(want.args ?? null) && h.timeout === want.timeout
}

/** Group without a filter (`matcher`): the hook fires there every time. */
function unfiltered(g: HookGroup): boolean {
  return g.matcher === undefined || g.matcher === "" || g.matcher === "*"
}

/**
 * Adds our hooks without touching the rest: idempotent, updates our hook if the path (or its form) changed and
 * removes our duplicates (a copy left on an old path would fail on every prompt).
 * Returns the new settings and the list of changes.
 */
export function mergeHooks(settings: Settings, entry: HookCommand | string): { settings: Settings; changes: string[] } {
  const want: HookCommand = typeof entry === "string" ? { type: "command", command: entry, timeout: HOOK_TIMEOUT_S } : entry
  const next: Settings = structuredClone(settings ?? {})
  const hooks = (next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {}) as Record<string, unknown>
  next.hooks = hooks
  const changes: string[] = []
  for (const event of HOOK_EVENTS) {
    let groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookGroup[]
    // The hook to keep if there are several: already up to date and without a filter, otherwise without a filter, otherwise the first.
    const ours = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter((h) => isOurHook(h)).map((h) => ({ g, h })) : []))
    const keep = (ours.find((o) => unfiltered(o.g) && sameHook(o.h, want)) ?? ours.find((o) => unfiltered(o.g)) ?? ours[0])?.h
    let found = false
    let duplicates = 0
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue
      g.hooks = g.hooks.filter((h) => {
        if (!isOurHook(h)) return true
        if (h !== keep) {
          duplicates++
          return false
        }
        found = true
        if (!sameHook(h, want)) {
          for (const k of ["type", "command", "args", "timeout", "shell"]) delete h[k]
          Object.assign(h, structuredClone(want))
          changes.push(`${event}: command updated`)
        }
        return true
      })
    }
    if (duplicates) {
      groups = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
      changes.push(`${event}: ${duplicates} duplicate(s) removed`)
    }
    if (!found) {
      groups.push({ hooks: [structuredClone(want)] })
      changes.push(`${event}: hook added`)
    }
    hooks[event] = groups
  }
  return { settings: next, changes }
}

/** Removes only our hooks (and the groups / keys left empty because of us). */
export function removeHooks(settings: Settings): { settings: Settings; removed: number } {
  const next: Settings = structuredClone(settings ?? {})
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) return { settings: next, removed: 0 }
  const hooks = next.hooks as Record<string, unknown>
  let removed = 0
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    const groups: HookGroup[] = []
    for (const g of value as HookGroup[]) {
      if (!g || !Array.isArray(g.hooks)) {
        groups.push(g)
        continue
      }
      const kept = g.hooks.filter((h) => !isOurHook(h))
      removed += g.hooks.length - kept.length
      if (kept.length === g.hooks.length) groups.push(g)
      else if (kept.length > 0) groups.push({ ...g, hooks: kept })
    }
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete next.hooks
  return { settings: next, removed }
}

export function readSettings(file: string): Settings {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, "utf8")
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Settings
  } catch {
    throw new Error(`${file} is not valid JSON: fix it before running again (nothing was changed).`)
  }
}

function backup(file: string): string | null {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = `${file}.bak-${stamp}`
  copyFileSync(file, dest)
  return dest
}

export function hooksInstalled(file = paths.claudeSettings()): boolean {
  try {
    const s = readSettings(file)
    return HOOK_EVENTS.every((e) => {
      const groups = (s.hooks as Record<string, unknown> | undefined)?.[e]
      return Array.isArray(groups) && (groups as HookGroup[]).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurHook(h)))
    })
  } catch {
    return false
  }
}

/** Our hooks, event by event (diagnosis); throws if settings.json is not valid JSON. */
export function ourHooks(file = paths.claudeSettings()): Record<(typeof HOOK_EVENTS)[number], HookCommand[]> {
  const s = readSettings(file)
  const out = {} as Record<(typeof HOOK_EVENTS)[number], HookCommand[]>
  for (const e of HOOK_EVENTS) {
    const groups = (s.hooks as Record<string, unknown> | undefined)?.[e]
    out[e] = (Array.isArray(groups) ? (groups as HookGroup[]) : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter((h) => isOurHook(h)) : []))
  }
  return out
}

export function installHooks(log: (s: string) => void = console.log, file = paths.claudeSettings()): { changes: string[]; backup: string | null } {
  const before = readSettings(file)
  const entry = hookEntry({ claudeVersion: process.platform === "win32" ? claudeCodeVersion() : null })
  const { settings, changes } = mergeHooks(before, entry)
  if (changes.length === 0) {
    log(`Hooks already installed in ${file}: nothing to change.`)
    return { changes, backup: null }
  }
  const bak = backup(file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
  log(`Claude Code hooks installed in ${file}:`)
  for (const c of changes) log(`  - ${c}`)
  log(`  command: ${hookText(entry)}`)
  if (bak) log(`  backup of the old file: ${bak}`)
  log("The other settings and hooks were not touched. Takes effect in the next Claude Code session.")
  return { changes, backup: bak }
}

export function uninstallHooks(log: (s: string) => void = console.log, file = paths.claudeSettings()): number {
  if (!existsSync(file)) {
    log(`No ${file}: no hook to remove.`)
    return 0
  }
  const { settings, removed } = removeHooks(readSettings(file))
  if (removed === 0) {
    log("No company-brain hook in the Claude Code settings.")
    return 0
  }
  const bak = backup(file)
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
  log(`${removed} company-brain hook(s) removed from ${file}${bak ? ` (backup: ${bak})` : ""}.`)
  return removed
}

// ——— Scheduled sync ———

export const LAUNCHD_LABEL = "com.company-brain.sync"
export const WINDOWS_TASK = "CompanyBrainSync"

/**
 * Environment of the scheduled sync, recorded at install time: cron and launchd start from a minimal PATH
 * (without `claude`, so without LLM distillation) and ignore custom folders.
 */
export function scheduleEnv(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, home = brainHome()): Record<string, string> {
  const dirs = [dirname(execPath)]
  const claude = findOnPath("claude", env.PATH ?? "")
  if (claude) dirs.push(dirname(claude))
  dirs.push(...(env.PATH ?? "").split(delimiter))
  if (process.platform !== "win32") dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
  const out: Record<string, string> = { PATH: [...new Set(dirs.filter((d) => d && isAbsolute(d)))].join(delimiter), COMPANY_BRAIN_HOME: home }
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) if (env[k]) out[k] = resolve(env[k]!)
  return out
}

function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

export function cronLine(execPath = process.execPath, script = selfScript(), home = brainHome(), env: Record<string, string> = {}): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)} `).join("")
  // In a crontab, "%" means a line break: we escape it.
  const cmd = `${vars}"${execPath}" "${script}" sync --scheduled >> "${join(home, "sync.log")}" 2>&1`.replace(/%/g, "\\%")
  return `*/15 * * * * ${cmd}`
}

/** Replaces our line (if there is one) and keeps the rest of the crontab. */
export function mergeCrontab(existing: string, line: string): { text: string; changed: boolean } {
  const lines = existing.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""))
  const others = lines.filter((l) => !OUR_SYNC_RE.test(l))
  const already = lines.filter((l) => OUR_SYNC_RE.test(l))
  if (already.length === 1 && already[0] === line) return { text: existing.endsWith("\n") || !existing ? existing : existing + "\n", changed: false }
  return { text: [...others, line].join("\n") + "\n", changed: true }
}

export function removeFromCrontab(existing: string): { text: string; removed: number } {
  const lines = existing.split("\n")
  const kept = lines.filter((l) => !OUR_SYNC_RE.test(l))
  const text = kept.join("\n").replace(/\n+$/, "")
  return { text: text ? text + "\n" : "", removed: lines.length - kept.length }
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function launchdPlist(execPath = process.execPath, script = selfScript(), home = brainHome(), env: Record<string, string> = {}): string {
  const log = join(home, "sync.log")
  const vars: Record<string, string> = {
    ...env,
    COMPANY_BRAIN_HOME: home,
    PATH: env.PATH ?? `${dirname(execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  const envXml = Object.entries(vars)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n")
  // RunAtLoad false: nothing starts on load; the first scheduled sync happens 15 min later.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(execPath)}</string>
    <string>${xml(script)}</string>
    <string>sync</string>
    <string>--scheduled</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
}

/** Windows: the command stays short (/TR ≤ 261 characters); PATH and folders come from config.json (`sync --scheduled`). */
export function windowsTaskArgs(execPath = process.execPath, script = selfScript(), home?: string): string[] {
  const tr = `"${execPath}" "${script}" sync --scheduled${home ? ` --home "${home}"` : ""}`
  return ["/Create", "/SC", "MINUTE", "/MO", "15", "/TN", WINDOWS_TASK, "/TR", tr, "/F"]
}

const RECENT_MS = 24 * 3_600_000
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** Internal session (our `claude -p`, the install session, a pasted secret of the computer): never sent up, nor what follows it. */
function looksInternalFile(file: string, secrets: string[], home: string): boolean {
  try {
    const st = statSync(file)
    if (Date.now() - st.mtimeMs > RECENT_MS || st.size > MAX_SCAN_BYTES) return false
    const buf = Buffer.alloc(st.size)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buf, 0, st.size, 0)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString("utf8")
    return text.includes(DISTILL_MARKER) || isBrainSetupText(text, secrets) || text.includes(`"cwd":${JSON.stringify(home)}`)
  } catch {
    return false
  }
}

/**
 * Starting point of the scheduled sync, for ALL sources: Screenpipe checkpoint at `at` (even if it was older,
 * or missing) and offsets of all the Claude Code / Codex files at their current end. What came before was not
 * read in the dry run (or was postponed there, or truncated): it will never be sent on its own.
 */
export function baselineSources(
  state: State,
  at = new Date(),
  opts: { claudeDir?: string; codexDir?: string; secrets?: string[]; brainHome?: string } = {},
): { files: number; internal: number } {
  const iso = at.toISOString()
  state.baseline_at = iso
  state.screenpipe ??= {}
  if (!state.screenpipe.last_timestamp || state.screenpipe.last_timestamp < iso) state.screenpipe.last_timestamp = iso
  const home = opts.brainHome ?? brainHome()
  let files = 0
  let internal = 0
  const roots: ["claude" | "codex", string[]][] = [
    ["claude", listJsonlFiles(join(opts.claudeDir ?? claudeDir(), "projects"), (name) => name === "subagents")],
    ["codex", listJsonlFiles(join(opts.codexDir ?? codexDir(), "sessions"))],
  ]
  for (const [source, list] of roots) {
    for (const file of list) {
      const end = completeLinesEnd(file)
      if (!end) continue
      state[source] ??= { files: {} }
      const prev = state[source]!.files[file]
      const isInternal = Boolean(prev?.internal) || looksInternalFile(file, opts.secrets ?? [], home)
      const cp: FileCheckpoint = { offset: prev && prev.offset > end.offset && prev.offset <= end.size ? prev.offset : end.offset, size: end.size, mtime: end.mtime }
      if (isInternal) {
        cp.internal = true
        internal++
      }
      state[source]!.files[file] = cp
      files++
    }
  }
  return { files, internal }
}

/**
 * Before scheduling: the automatic sync starts from now for every source (nothing earlier that was not
 * read will be sent on its own) and the current environment is noted in config.json for `sync --scheduled`.
 */
export function prepareSchedule(env: Record<string, string>, log: (s: string) => void = console.log) {
  const cfg = loadPartialConfig()
  const state = loadState()
  const b = baselineSources(state, new Date(), { secrets: ownSecrets(cfg) })
  saveState(state)
  if (cfg.url && cfg.token) saveConfig({ ...cfg, schedule_env: env })
  log(
    `The scheduled sync starts from now: it only sends upcoming activity, never history that was not read` +
      ` (Screenpipe from now on, ${b.files} Claude Code / Codex file(s) resumed at their current end).`,
  )
  const claude = findOnPath("claude", env.PATH ?? "")
  if (cfg.anthropic_api_key) log("Scheduled distillation: Claude (Anthropic API), key saved in the config.")
  else if (cfg.use_claude_cli !== false && claude) {
    log(`Scheduled distillation: local Claude Code (\`claude -p\`, ${claude})${cfg.claude_oauth_token ? ", with the Claude Code token from the config" : ""}.`)
    if (!cfg.claude_oauth_token)
      log("If the scheduled sync cannot use your Claude Code session: `claude setup-token`, then `init --claude-token <token>` (the token stays in config.json).")
  } else log(`Scheduled distillation: local heuristic (${cfg.use_claude_cli === false ? "Claude CLI disabled" : "`claude` CLI not found in the PATH passed on"}).`)
  if (!cfg.anthropic_api_key && process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY is not passed to the scheduled sync (it is never written into the scheduler): `init --anthropic-key <key>` to use it.")
  }
}

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout: 15000 })
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error?.message ?? "") }
}

export function scheduleInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(launchdPlistPath())
  if (process.platform === "win32") return run("schtasks", ["/Query", "/TN", WINDOWS_TASK]).ok
  const r = run("crontab", ["-l"])
  return r.ok && OUR_SYNC_RE.test(r.stdout)
}

export type ScheduleTarget = { execPath: string; script: string; home?: string }

/** Node.js and script of the installed scheduled sync (diagnosis); null if none, undefined if unreadable. */
export function scheduleTarget(platform: NodeJS.Platform = process.platform): ScheduleTarget | null | undefined {
  if (platform === "darwin") {
    if (!existsSync(launchdPlistPath())) return null
    return parsePlistTarget(readFileSync(launchdPlistPath(), "utf8"))
  }
  if (platform === "win32") {
    const r = run("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/XML"])
    if (!r.ok) return null
    return parseTaskXmlTarget(r.stdout)
  }
  const r = run("crontab", ["-l"])
  if (!r.ok) return null
  const line = r.stdout.split("\n").find((l) => OUR_SYNC_RE.test(l))
  return line ? parseCronTarget(line) : null
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&")

export function parsePlistTarget(plist: string): ScheduleTarget | undefined {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1]
  const args = [...(block ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]))
  const home = /<key>COMPANY_BRAIN_HOME<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(plist)?.[1]
  return args.length >= 2 ? { execPath: args[0], script: args[1], ...(home ? { home: unxml(home) } : {}) } : undefined
}

export function parseCronTarget(line: string): ScheduleTarget | undefined {
  const m = /"([^"]+)" "([^"]+)" sync\b/.exec(line)
  const home = /COMPANY_BRAIN_HOME='((?:[^']|'\\'')*)'/.exec(line)?.[1]
  return m ? { execPath: m[1], script: m[2], ...(home ? { home: home.replace(/'\\''/g, "'") } : {}) } : undefined
}

export function parseTaskXmlTarget(xmlText: string): ScheduleTarget | undefined {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xmlText)?.[1]
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xmlText)?.[1]
  if (!command || !args) return undefined
  // schtasks writes in the console's code page: a path with accents (C:\Users\Jérôme) arrives damaged, unreadable.
  if (/[\uFFFD?]/.test(command + args)) return undefined
  const script = /^\s*"([^"]+)"/.exec(unxml(args))?.[1]
  const home = /--home "([^"]+)"/.exec(unxml(args))?.[1]
  return script ? { execPath: unxml(command).replace(/^"|"$/g, ""), script, ...(home ? { home } : {}) } : undefined
}

export function installSchedule(log: (s: string) => void = console.log): boolean {
  const env = scheduleEnv(process.env, process.execPath)
  prepareSchedule(env, log)
  return writeSchedule(env, log)
}

/**
 * Sync already scheduled (setup run again): the definition is rewritten with the current Node.js and script (after a
 * reinstall or a Node update, the old one would point to nothing), WITHOUT a new starting point: nothing
 * waiting to be sent is skipped.
 */
export function refreshSchedule(log: (s: string) => void = console.log): boolean {
  const env = scheduleEnv(process.env, process.execPath)
  const cfg = loadPartialConfig()
  if (cfg.url && cfg.token && JSON.stringify(cfg.schedule_env ?? null) !== JSON.stringify(env)) saveConfig({ ...cfg, schedule_env: env })
  return writeSchedule(env, log)
}

/** Writes the schedule (launchd, crontab or Windows task) with the current Node.js and script. */
export function writeSchedule(env: Record<string, string>, log: (s: string) => void = console.log): boolean {
  const execPath = process.execPath
  const script = selfScript()
  if (process.platform === "darwin") {
    const file = launchdPlistPath()
    const plist = launchdPlist(execPath, script, brainHome(), env)
    mkdirSync(dirname(file), { recursive: true })
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== plist
    if (!changed && run("launchctl", ["list", LAUNCHD_LABEL]).ok) {
      log(`Sync already scheduled every 15 min through launchd (${file}): up to date.`)
      return true
    }
    if (changed) {
      run("launchctl", ["unload", file])
      writeFileSync(file, plist)
    }
    let r = run("launchctl", ["load", "-w", file])
    if (!r.ok) {
      const uid = process.getuid?.() ?? 501
      r = run("launchctl", ["bootstrap", `gui/${uid}`, file])
    }
    if (r.ok || /already loaded|service already/i.test(r.stderr)) {
      log(`Sync scheduled every 15 min through launchd (${file}). Log: ${paths.log()}`)
      return true
    }
    log(`Cannot load the LaunchAgent (${r.stderr.trim()}). To run by hand:\n  launchctl load -w "${file}"`)
    return false
  }
  if (process.platform === "win32") {
    const args = windowsTaskArgs(execPath, script, customHome() ? brainHome() : undefined)
    const r = run("schtasks", args)
    if (r.ok) {
      log(`Sync scheduled every 15 min (Windows task "${WINDOWS_TASK}").`)
      return true
    }
    log(`schtasks failed (${r.stderr.trim()}). Run \`install-schedule\` again in PowerShell or cmd (not in Git Bash, which turns "/Create" into a path).`)
    return false
  }
  const line = cronLine(execPath, script, brainHome(), env)
  const current = run("crontab", ["-l"])
  const existing = current.ok ? current.stdout : ""
  if (!current.ok && /not found|ENOENT/i.test(current.stderr)) {
    log(`crontab not found on this computer. Add this line to your scheduler:\n  ${line}`)
    return false
  }
  const { text, changed } = mergeCrontab(existing, line)
  if (!changed) {
    log("Sync already scheduled in the crontab: nothing to change.")
    return true
  }
  const w = run("crontab", ["-"], text)
  if (w.ok) {
    log(`Sync scheduled every 15 min in the crontab:\n  ${line}`)
    return true
  }
  log(`Cannot write the crontab (${w.stderr.trim()}). Add this line with \`crontab -e\`:\n  ${line}`)
  return false
}

export function uninstallSchedule(log: (s: string) => void = console.log) {
  if (process.platform === "darwin") {
    const file = launchdPlistPath()
    if (!existsSync(file)) return log("No launchd sync to remove.")
    run("launchctl", ["unload", "-w", file])
    unlinkSync(file)
    return log(`launchd sync removed (${file}).`)
  }
  if (process.platform === "win32") {
    const r = run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"])
    return log(r.ok ? `Scheduled task "${WINDOWS_TASK}" deleted.` : "No scheduled task to delete.")
  }
  const current = run("crontab", ["-l"])
  if (!current.ok) return log("No crontab: nothing to remove.")
  const { text, removed } = removeFromCrontab(current.stdout)
  if (!removed) return log("No company-brain line in the crontab.")
  const w = text ? run("crontab", ["-"], text) : run("crontab", ["-r"])
  log(w.ok ? "company-brain line removed from the crontab." : `Cannot modify the crontab (${w.stderr.trim()}): remove the "brain.mjs sync" line with \`crontab -e\`.`)
}

// --- Pipe Screenpipe ------------------------------------------------------------------------------------------------

export const PIPE_NAME = "brain-sync"
/** Recognizes our pipe by its title and its command, whatever the script's path (brain.mjs or source). */
export const PIPE_TITLE = "Company brain, sync"
/** Title of pipes written before the English version: still recognized (uninstall, status). */
const LEGACY_PIPE_TITLE = "Cerveau d'entreprise, synchro"

/** Screenpipe CLI command (the one from the official skill; `bun x` works too). */
export const SCREENPIPE_CLI = "npx -y screenpipe@latest"

/** Screenpipe's folder (~/.screenpipe), can be overridden for tests. */
export function screenpipeDir(): string {
  return resolve(process.env.COMPANY_BRAIN_SCREENPIPE_DIR ?? join(homedir(), ".screenpipe"))
}

export function pipePath(): string {
  return join(screenpipeDir(), "pipes", PIPE_NAME, "pipe.md")
}

/**
 * The pipe: Screenpipe runs this prompt every 15 minutes and at the end of each meeting, with a token limited
 * to the listed reads (permissions.allow) and the native redaction (privacy_filter). It only starts brain-sync.
 */
export function pipeMarkdown(execPath = process.execPath, script = selfScript(), home = brainHome()): string {
  return `---
schedule: every 15m
enabled: true
title: ${PIPE_TITLE}
description: Distills this computer's AI sessions and meetings into the shared brain (nothing raw leaves the computer)
trigger:
  events:
    - meeting_ended
permissions:
  allow:
    - Api(GET /search)
    - Api(GET /meetings)
    - Api(GET /meetings/*)
    - Api(GET /workflows)
    - Api(GET /workflows/*)
privacy_filter: true
---

Run exactly this command in a shell, then report its output in one or two sentences (knowledge sent,
warnings). Do not read any data yourself, do not send anything elsewhere, do not modify any file. If the command fails,
report the error as is.

\`"${execPath}" "${script}" sync --scheduled --home "${home}"\`
`
}

export function pipeInstalled(file = pipePath()): boolean {
  try {
    if (!existsSync(file)) return false
    const text = readFileSync(file, "utf8")
    return (text.includes(`title: ${PIPE_TITLE}`) || text.includes(`title: ${LEGACY_PIPE_TITLE}`)) && /\bsync --scheduled\b/.test(text)
  } catch {
    return false
  }
}

export function installPipe(log: (s: string) => void = console.log, file = pipePath()): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, pipeMarkdown())
  log(`Pipe "${PIPE_NAME}" written in ${file}.`)
  log(`Enable: ${SCREENPIPE_CLI} pipe enable ${PIPE_NAME} — test: ${SCREENPIPE_CLI} pipe run ${PIPE_NAME} — logs: ${SCREENPIPE_CLI} pipe logs ${PIPE_NAME}`)
  log("It needs the Screenpipe app (the pipe engine); with the CLI alone, the scheduled sync from install-schedule is enough.")
  return file
}

export function uninstallPipe(log: (s: string) => void = console.log, file = pipePath()) {
  if (!pipeInstalled(file)) return log("Screenpipe pipe: nothing to remove.")
  rmSync(dirname(file), { recursive: true, force: true })
  log(`Pipe "${PIPE_NAME}" removed from Screenpipe.`)
}

// --- MCP company-brain (Claude Code) ----------------------------------------------------------------------------------

export const MCP_NAME = "company-brain"

/** MCP server arguments after Node.js. */
export function mcpArgs(script = selfScript()): string[] {
  return clientArgs(script, "mcp")
}

/** Where Claude Code keeps user-scope MCP servers: ~/.claude.json, or in CLAUDE_CONFIG_DIR if it is set. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(claudeDir(), ".claude.json") : join(homedir(), ".claude.json")
}

export type McpEntry = { command: string; args: string[] }

/**
 * Our MCP server as Claude Code registered it (reading the file, without running `claude mcp get`, which writes
 * files and contacts the network). null: not registered; undefined: unreadable file.
 */
export function readMcpEntry(file = claudeJsonPath()): McpEntry | null | undefined {
  if (!existsSync(file)) return null
  let data: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> }
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  const e = data?.mcpServers?.[MCP_NAME]
  if (!e || typeof e.command !== "string") return null
  return { command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [] }
}

/** Do two paths point to the same file? (links resolved; case ignored on Windows and macOS.) */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    let r = resolve(p)
    try {
      r = realpathSync(r)
    } catch {
      // file missing: we compare the path as is
    }
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** Does the MCP entry really start this Node.js and this script, with the right arguments? */
export function mcpUpToDate(e: McpEntry, execPath = process.execPath, script = selfScript()): boolean {
  const want = mcpArgs(script)
  return samePath(e.command, execPath) && e.args.length === want.length && samePath(e.args[0] ?? "", want[0]) && e.args.slice(1).join(" ") === want.slice(1).join(" ")
}

/** The `claude mcp add` command to run by hand if the `claude` CLI could not do it. */
export function mcpAddCommand(): string {
  return `claude mcp add ${MCP_NAME} --scope user -- ${[process.execPath, ...mcpArgs()].map((a) => quoteArg(a)).join(" ")}`
}

export function uninstall(opts: { purge?: boolean }, log: (s: string) => void = console.log) {
  try {
    uninstallHooks(log)
  } catch (err) {
    log(`Hooks: ${(err as Error).message}`)
  }
  try {
    uninstallPipe(log)
  } catch (err) {
    log(`Screenpipe pipe: ${(err as Error).message}`)
  }
  try {
    uninstallSchedule(log)
  } catch (err) {
    log(`Scheduling: ${(err as Error).message}`)
  }
  try {
    removeInstalledSkills(log)
  } catch (err) {
    log(`Skills: ${(err as Error).message}`)
  }
  try {
    uninstallScreenpipeService(log)
  } catch (err) {
    log(`Screenpipe: ${(err as Error).message}`)
  }
  const r = spawnSync("claude", ["mcp", "remove", "company-brain", "--scope", "user"], {
    encoding: "utf8",
    timeout: 15000,
    shell: process.platform === "win32",
    env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
  })
  if (!r.error && r.status === 0) log("company-brain MCP server removed from Claude Code.")
  else log("MCP: nothing removed (missing, or `claude` CLI not found). By hand: claude mcp remove company-brain --scope user")
  if (opts.purge) {
    try {
      rmSync(brainHome(), { recursive: true, force: true })
      log(`Folder ${brainHome()} deleted (config, token, state, logs).`)
    } catch (err) {
      // Windows: the private copy's node.exe running this command cannot delete itself.
      log(`Folder ${brainHome()} partly emptied (${(err as Error).message}): delete it by hand once this terminal is closed.`)
    }
  } else {
    log(`Config and token kept in ${brainHome()} (add --purge to delete everything).`)
  }
}

