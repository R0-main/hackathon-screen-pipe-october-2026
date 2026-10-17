// `brain doctor`: diagnosis of the computer, read-only. Each item says what works, what is wrong and the command that
// fixes it. For the employee, and above all for Claude Code when the install or the sync gets stuck (`--json`).
// Nothing is modified: not the config, the cache, the state, or Claude Code's settings (no `claude mcp get`, which writes
// files and contacts the network). No token is shown, not even in part: only its presence (the output ends up in
// the Claude Code session, which brain-sync reads).

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { redactText, truncate } from "@brain/core"
import { reinstallCommands } from "../../web/lib/install-prompt"
import { ApiError, BrainApi } from "./api"
import { zoneName } from "./cache"
import {
  brainHome,
  customHome,
  loadCache,
  loadState,
  paths,
  readJson,
  selfCommand,
  selfScript,
  shortcutPath,
  companiesOf,
  withDefaults,
  type Config,
} from "./config"
import { DISTILLER_LABELS, apiKey, findOnPath, pickDistiller, spawnTarget } from "./distill"
import { codexConfigPath, codexPresent, mcpSpecs, probeMcp, readClaudeMcp, readCodexMcp, type McpCompany, type McpServerSpec } from "./mcp-config"
import {
  HOOK_EVENTS,
  claudeCodeVersion,
  claudeJsonPath,
  gitBashInstalled,
  hookText,
  mcpUpToDate,
  ourHooks,
  pipeInstalled,
  readMcpEntry,
  samePath,
  scheduleTarget,
  type HookCommand,
} from "./install"
import { joinStatePath } from "./join"
import { installedScreenpipeBin, screenpipeLoadError, screenpipeSupported, SCREENPIPE_LAUNCHD_LABEL } from "./screenpipe-cli"
import { maskOwnSecrets, ownSecrets } from "./secrets"
import { desktopApp, readHealth } from "./setup"
import { screenpipeProbe } from "./sources/screenpipe"
import { LOCK_STALE_MS, PREVIEW_TTL_MS, pidAlive } from "./sync"

type Log = (s: string) => void

export type Status = "ok" | "warn" | "fail" | "skip" | "info"
export const GROUPS = ["Computer", "Brain", "Screenpipe", "Claude Code", "Codex", "Sync", "Distillation"] as const
export type Group = (typeof GROUPS)[number]

/**
 * A diagnosis item. `fix`: what to do, in one sentence; `command`: the exact command, when there is one;
 * `safe`: this command only (re)connects the computer (nothing is sent, nothing is deleted, no choice to make):
 * Claude Code can run it without asking again.
 */
export type Check = { id: string; group: Group; status: Status; detail: string; fix?: string; command?: string; safe?: boolean }

export type DoctorReport = {
  schema: 1
  version: string
  platform: string
  arch: string
  node: string
  home: string
  summary: Record<Status, number>
  exit_code: number
  /** The first problem to solve (the first KO, otherwise the first item to watch), in the diagnosis order. */
  next: Check | null
  checks: Check[]
}

/** Node.js paths managed by a version manager: the next update deletes them. */
const VERSIONED_NODE_RE = /[\\/](Cellar|\.nvm|nvm|fnm|\.fnm|\.volta|Volta|\.asdf|mise|\.nodenv|n[\\/]versions|pnpm)[\\/]/i

type Probe = { ok: true; node: string; script: string; version: string } | { ok: false; error: string }

/** Runs a registered client (shortcut, hook, MCP, scheduled sync) with `_probe`: does it start, and which one? */
function probe(cmd: string, args: string[]): Probe {
  if (!existsSync(cmd)) return { ok: false, error: `not found: ${cmd}` }
  // Only our client (never `npx … _probe` or another MCP server that would carry our name).
  if (args.length && !/brain\.mjs$/i.test(args[0]) && !samePath(args[0], selfScript())) return { ok: false, error: `it is not the brain client (${args[0]})` }
  if (args.length && !existsSync(args[0])) return { ok: false, error: `not found: ${args[0]}` }
  const t = spawnTarget(cmd, [...args, "_probe"])
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: 15_000, shell: t.shell, windowsHide: true, env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  if (r.error) return { ok: false, error: r.error.message }
  const line = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? ""
  try {
    const p = JSON.parse(line) as { node?: string; script?: string; version?: string }
    if (r.status === 0 && p.node && p.script) return { ok: true, node: p.node, script: p.script, version: p.version ?? "?" }
  } catch {
    // not our client, or it crashed
  }
  const err = `${r.stderr ?? ""}`.trim().split(/\r?\n/).find(Boolean) ?? `code ${r.status}`
  return { ok: false, error: truncate(err, 200) }
}

const probes = new Map<string, Probe>()
function probeOnce(cmd: string, args: string[]): Probe {
  const key = [cmd, ...args].join("\0")
  if (!probes.has(key)) probes.set(key, probe(cmd, args))
  return probes.get(key)!
}

/**
 * The reference client: the one the computer's shortcut starts if it works (doctor can run on another Node.js,
 * e.g. `node ~/.company-brain/brain.mjs doctor`), otherwise this process. It is also the one `setup` registers when it is
 * run again through the shortcut, as the fixes suggest.
 */
let reference: { execPath: string; script: string } = { execPath: process.execPath, script: selfScript() }

/** What to say about a connection that does not start the reference client (null: it is the right one). */
function mismatch(execPath: string, script: string): string | null {
  if (!samePath(script, reference.script)) return `starts another client (${script})`
  if (!samePath(execPath, reference.execPath)) return `starts another Node.js (${execPath}, instead of ${reference.execPath})`
  return null
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** End of a file (log), without reading all of it. */
function readTail(file: string, bytes = 256 * 1024): string {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    return buf.toString("utf8")
  } catch {
    return ""
  }
}

/** Date of a "brain-sync — 17/10/2026, 12:18:32" header (en-GB, or fr-FR in older logs; local time). */
function headerDate(line: string): number | null {
  const m = /brain-sync — (\d{1,2})\/(\d{1,2})\/(\d{4})[ ,à]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(line)
  if (!m) return null
  const t = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0)).getTime()
  return Number.isFinite(t) ? t : null
}

export type LastRun = { at: number | null; sent: boolean; auth: boolean; error: string | null }

/** The log's last sync (scheduled: launchd and cron write to sync.log): sending, lost sign-in, error. */
export function lastLoggedRun(text: string): LastRun | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^brain-sync — /.test(lines[i]) && !/dry run|simulation/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const block = lines.slice(start + 1).filter((l) => !/^\[\d{4}-\d\d-\d\dT[^\]]*\] hook ?: /.test(l))
  const error = block.find((l) => /^(Error:|Client not configured|Cannot reach|Token refused|The brain answered|Erreur :|Client non configuré|Impossible de joindre|Jeton refusé|Le cerveau a répondu)/.test(l.trim())) ?? null
  return {
    at: headerDate(lines[start]),
    sent: block.some((l) => /^(Sent: |Envoyé : )/.test(l)),
    auth: block.some((l) => /is no longer signed in|Anthropic API key refused|n'est plus connecté|Clé API Anthropic refusée/.test(l)),
    error: error ? error.trim() : null,
  }
}

/** Hook errors (`[ISO] hook: message`) of the last 24 h. */
export function recentHookErrors(text: string, now = Date.now()): { count: number; last: string | null } {
  let count = 0
  let last: string | null = null
  for (const l of text.split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] hook ?: (.*)$/.exec(l)
    if (!m || !(now - Date.parse(m[1]) < 24 * 3_600_000)) continue
    count++
    last = m[2]
  }
  return { count, last }
}

/** Reading the capture state in GET /health (Screenpipe 0.4.x): `vision_reason` first, then the age of the last frame. */
export function captureDiagnosis(
  health: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): { status: Status; detail: string; reason: string } {
  const vision = typeof health.vision_reason === "string" ? health.vision_reason : ""
  const frame = typeof health.frame_status === "string" ? health.frame_status : ""
  const last = typeof health.last_frame_timestamp === "string" ? Date.parse(health.last_frame_timestamp) : NaN
  const age = Number.isFinite(last) ? ` (last frame ${ago(now - last)})` : ""
  if (vision === "permission_denied") return { status: "fail", reason: "permission", detail: platform === "darwin" ? "macOS does not allow screenpipe to record the screen" : "the system refuses screen capture to screenpipe" }
  if (vision === "disabled_by_setting" || vision === "screenshots_disabled_by_config") return { status: "warn", reason: "disabled", detail: "screen capture disabled in Screenpipe's settings" }
  if (vision === "screenshots_disabled_by_power_profile") return { status: "info", reason: "power", detail: `capture paused (power saving)${age}` }
  if (vision === "no_displays_expected") return { status: "info", reason: "no-display", detail: "no screen to capture (screen locked or off?)" }
  if (vision === "capture_stalled") return { status: "warn", reason: "stalled", detail: `capture stalled${age}` }
  if (vision === "ocr_unavailable") return { status: "warn", reason: "ocr", detail: `reading text from the image unavailable${age}` }
  if (vision === "not_started" || frame === "not_started" || (!vision && !frame && !Number.isFinite(last))) {
    return { status: "warn", reason: "not-started", detail: platform === "darwin" ? "no frame captured yet (\"Screen Recording\" permission not granted yet?)" : "no frame captured yet" }
  }
  if (frame === "stale") return { status: "warn", reason: "stale", detail: `no recent frame${age} (screen locked, or capture stopped)` }
  return { status: "ok", reason: "ok", detail: `screen capture active${age}` }
}

/** Install command to run again (the config keeps the token: the brain's address is enough, plus the certificate if there is one). */
export function reinstallCommand(url: string, platform: NodeJS.Platform = process.platform, caFile?: string): string {
  // The install prompt's commands, without the token.
  const c = reinstallCommands(url, caFile)
  return platform === "win32" ? c.windows : c.posix
}

type Ctx = {
  checks: Check[]
  me: string
  platform: NodeJS.Platform
  now: number
  cfg: Config | null
  /** To redact what would come from a log. */
  secrets: string[]
}

function add(ctx: Ctx, c: Check) {
  ctx.checks.push(c)
}

/** What can be shown of a log line: our own messages, redacted and truncated. */
function clean(ctx: Ctx, s: string): string {
  return truncate(redactText(maskOwnSecrets(s, ctx.secrets).text), 160)
}

// ——— Computer ———

function checkNode(ctx: Ctx) {
  const v = process.versions.node
  const major = Number.parseInt(v, 10)
  const exec = process.execPath
  const reinstall = ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform, ctx.cfg.ca_file), safe: true } : {}
  if (major < 20) {
    return add(ctx, { id: "node", group: "Computer", status: "fail", detail: `Node.js ${v} (${exec}): version 20 or later is required`, fix: "Run the install command again: it installs its own copy of Node.js.", ...reinstall })
  }
  let translated = false
  if (ctx.platform === "darwin" && process.arch === "x64") {
    const r = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", timeout: 5000 })
    translated = (r.stdout ?? "").trim() === "1"
  }
  if (translated) {
    return add(ctx, {
      id: "node",
      group: "Computer",
      status: "warn",
      detail: `Node.js ${v} x64 under Rosetta on an Apple Silicon Mac (${exec}): Screenpipe would run under emulation`,
      fix: "Run the install command again: it picks Node.js for Apple Silicon.",
      ...reinstall,
    })
  }
  if (VERSIONED_NODE_RE.test(exec)) {
    return add(ctx, {
      id: "node",
      group: "Computer",
      status: "warn",
      detail: `Node.js ${v} comes from a version manager (${exec}): its next update will break hooks, MCP and sync`,
      fix: "Run the install command again: it installs a copy of Node.js of the client's own.",
      ...reinstall,
    })
  }
  add(ctx, { id: "node", group: "Computer", status: "ok", detail: `Node.js ${v} (${exec})` })
}

function checkClientFiles(ctx: Ctx) {
  const script = selfScript()
  const installed = join(brainHome(), "brain.mjs")
  if (script.endsWith(".mjs") && !samePath(script, installed)) {
    add(ctx, {
      id: "client",
      group: "Computer",
      status: "warn",
      detail: `this client (${script}) is not the computer's (${installed}): hooks, MCP and sync may start another file`,
      fix: "Use the computer's shortcut, or run the install command again.",
      ...(ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform, ctx.cfg.ca_file), safe: true } : {}),
    })
  }

  const shortcut = shortcutPath(ctx.platform)
  const reinstall = ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform, ctx.cfg.ca_file), safe: true } : {}
  if (!existsSync(shortcut)) {
    add(ctx, {
      id: "shortcut",
      group: "Computer",
      status: "warn",
      detail: `shortcut ${shortcut} missing: the \`~/.company-brain/${basename(shortcut)} …\` commands will not work`,
      fix: `Run the install command again (it writes the shortcut). Meanwhile: ${ctx.me} <command>.`,
      ...reinstall,
    })
  } else {
    const p = probeOnce(shortcut, [])
    if (!p.ok) add(ctx, { id: "shortcut", group: "Computer", status: "fail", detail: `the shortcut ${shortcut} does not start (${p.error})`, fix: "Run the install command again.", ...reinstall })
    else {
      if (selfScript().endsWith(".mjs") && !samePath(p.script, selfScript()))
        add(ctx, { id: "shortcut", group: "Computer", status: "warn", detail: `the shortcut starts another client (${p.script})`, fix: "Run the install command again.", ...reinstall })
      else add(ctx, { id: "shortcut", group: "Computer", status: "ok", detail: `${shortcut} → Node.js ${p.node}` })
      // The fixes go through the shortcut: it is the one hooks, MCP and sync must start.
      reference = { execPath: p.node, script: p.script }
    }
  }

  const home = brainHome()
  const details: string[] = []
  let status: Status = "ok"
  let fix: string | undefined
  let command: string | undefined
  if (ctx.platform !== "win32") {
    try {
      const mode = statSync(home).mode & 0o777
      if (mode & 0o077) {
        status = "warn"
        details.push(`folder readable by other accounts on the computer (permissions ${mode.toString(8)})`)
        fix = "Restrict it to your account."
        command = `chmod 700 ${home.includes(" ") ? `"${home}"` : home}`
      }
    } catch {
      // missing: the config will say so
    }
    if (process.getuid?.() === 0) {
      status = "warn"
      details.push(`client run as root${process.env.SUDO_USER ? ` with sudo (for ${process.env.SUDO_USER})` : ""}: config, hooks and sync would go to the root account`)
      fix ??= "Run the command again without sudo, from your session."
    }
  }
  if (ctx.platform === "linux") {
    try {
      if (/microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"))) {
        status = status === "ok" ? "info" : status
        details.push("WSL: Screenpipe cannot see the Windows screen from here, and the sync only runs while WSL is running; better install the client on Windows")
      }
    } catch {
      // not a Microsoft Linux kernel
    }
  }
  if (customHome()) details.push(`custom folder (COMPANY_BRAIN_HOME): ${home}`)
  add(ctx, { id: "folder", group: "Computer", status, detail: details.length ? details.join("; ") : home, ...(fix ? { fix } : {}), ...(command ? { command, safe: true } : {}) })
}

// ——— Brain ———

function checkConfig(ctx: Ctx): boolean {
  const file = paths.config()
  if (!existsSync(file)) {
    // Team message: the request waits for an admin; the computer will connect as soon as it is accepted.
    const pending = readJson<{ org?: string }>(joinStatePath())
    if (pending)
      add(ctx, {
        id: "config",
        group: "Brain",
        status: "fail",
        detail: `request to join ${pending.org ?? "the company"} not accepted yet: the computer is not connected yet`,
        fix: "An admin must accept it (Team and access, then Requests); join resumes the same request and installs everything once accepted.",
        command: `${ctx.me} join`,
        safe: true,
      })
    else
      add(ctx, { id: "config", group: "Brain", status: "fail", detail: `${file} missing: the computer is not connected to the brain`, fix: "Paste your install prompt into Claude Code (or ask an admin for a new one, Team and access page)." })
    return false
  }
  let raw: Partial<Config>
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // Not JSON.parse's message: it copies a piece of the file, token included.
    add(ctx, { id: "config", group: "Brain", status: "fail", detail: `${file} unreadable (invalid JSON)`, fix: "Paste your install prompt into Claude Code again: it rewrites the config." })
    return false
  }
  if (!raw.url || !raw.token) {
    add(ctx, { id: "config", group: "Brain", status: "fail", detail: `${file} incomplete (${raw.url ? "token" : "brain address"} missing)`, fix: "Paste your install prompt into Claude Code again." })
    return false
  }
  ctx.cfg = withDefaults(raw) as Config
  ctx.secrets = ownSecrets(ctx.cfg)
  let mode = ""
  if (ctx.platform !== "win32") {
    const m = statSync(file).mode & 0o777
    if (m & 0o077) {
      add(ctx, {
        id: "config",
        group: "Brain",
        status: "warn",
        detail: `${file} readable by other accounts (permissions ${m.toString(8)}): it contains your token`,
        fix: "Restrict it to your account.",
        command: `chmod 600 ${file.includes(" ") ? `"${file}"` : file}`,
        safe: true,
      })
      return true
    }
    mode = ", permissions 600"
  }
  add(ctx, { id: "config", group: "Brain", status: "ok", detail: `${file} (brain ${ctx.cfg.url}, token saved${mode})` })
  return true
}

async function checkBrain(ctx: Ctx) {
  const cfg = ctx.cfg!
  const api = new BrainApi(cfg.url, cfg.token, 8000)
  const [who, sha] = await Promise.allSettled([api.whoami(), fetchText(`${cfg.url}/brain.mjs.sha256`, 8000)])
  if (who.status === "fulfilled") {
    const w = who.value
    const cache = loadCache()
    const zones = w.access.readable.map((z) => zoneName(cache, z)).join(", ") || "none"
    add(ctx, { id: "connection", group: "Brain", status: "ok", detail: `${w.profile.name} at ${w.org.name}, readable zones: ${zones}${w.access.isAdmin ? " (admin)" : ""}` })
  } else {
    const err = who.reason as Error
    const status = err instanceof ApiError ? err.status : 0
    if (status === 401 || status === 403)
      add(ctx, {
        id: "connection",
        group: "Brain",
        status: "fail",
        detail: `the brain refuses this computer's token (${status}): revoked, or account disabled`,
        fix: "Ask an admin for a new install prompt (Team and access page → New prompt) and paste it into Claude Code.",
      })
    else
      add(ctx, {
        id: "connection",
        group: "Brain",
        status: "fail",
        detail: clean(ctx, err.message),
        fix:
          status === 0
            ? `Check the network connection (VPN, corporate proxy: Node.js ignores the system proxy) and that ${cfg.url} opens in the browser, then run doctor again.`
            : "The brain answers but with an error: try again in a few minutes, or tell the admin.",
      })
  }

  // Is the computer's client the one the brain serves? (fingerprint published next to /brain.mjs)
  const script = selfScript()
  if (!script.endsWith(".mjs")) return
  const want = sha.status === "fulfilled" ? /^([0-9a-f]{64})\b/.exec(sha.value.trim())?.[1] : undefined
  if (!want) return add(ctx, { id: "version", group: "Brain", status: "skip", detail: "the brain does not publish the client's fingerprint (brain.mjs.sha256)" })
  let have = ""
  try {
    have = createHash("sha256").update(readFileSync(script)).digest("hex")
  } catch {
    // unreadable: different
  }
  if (have === want) add(ctx, { id: "version", group: "Brain", status: "ok", detail: "client up to date (identical to the brain's)" })
  else
    add(ctx, {
      id: "version",
      group: "Brain",
      status: "warn",
      detail: "the brain serves a more recent version of the client",
      fix: "Run the install command again to update it (configuration and history kept).",
      command: reinstallCommand(cfg.url, ctx.platform, cfg.ca_file),
      safe: true,
    })
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "accept-encoding": "identity" } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// ——— Screenpipe ———

async function checkScreenpipe(ctx: Ctx) {
  const cfg = ctx.cfg
  if (cfg && !cfg.sources.includes("screenpipe")) {
    return add(ctx, { id: "screenpipe", group: "Screenpipe", status: "info", detail: "source disabled in the config: brain-sync only reads the Claude Code and Codex sessions" })
  }
  const url = cfg?.screenpipe_url ?? "http://localhost:3030"
  const token = cfg?.screenpipe_token
  const bin = installedScreenpipeBin()
  const app = desktopApp()
  const health = (await readHealth(url, token, 4000)) as Record<string, unknown> | null
  const setup = { command: `${ctx.me} setup`, safe: true }

  if (!health) {
    if (!bin && !app && !screenpipeSupported(ctx.platform)) {
      return add(ctx, {
        id: "screenpipe",
        group: "Screenpipe",
        status: "warn",
        detail: `Screenpipe does not exist for ${ctx.platform}-${process.arch}: brain-sync only reads the Claude Code and Codex sessions`,
      })
    }
    if (bin) {
      const loadError = screenpipeLoadError(bin)
      if (loadError) {
        return add(ctx, {
          id: "screenpipe",
          group: "Screenpipe",
          status: "fail",
          detail: `Screenpipe does not start on this computer ("${truncate(loadError, 200)}")`,
          fix: /GLIBC|shared object|shared librar/i.test(loadError)
            ? "It needs glibc ≥ 2.39 (Ubuntu 24.04 or later) and the system's pipewire / pulseaudio libraries: install them, then run setup again."
            : /dyld|Library not loaded|Symbol not found/i.test(loadError)
              ? "This macOS is too old for Screenpipe (macOS 11 minimum)."
              : `Check that ${bin} is executable (home folder mounted noexec?), then run setup again.`,
        })
      }
    }
    return add(ctx, {
      id: "screenpipe",
      group: "Screenpipe",
      status: "fail",
      detail: `Screenpipe does not answer on ${url}${bin ? " (installed by the client, stopped)" : app ? ` (app ${app} closed)` : " (not installed)"}`,
      fix: "setup (re)installs and restarts it, without touching the rest.",
      ...setup,
    })
  }
  const how = bin ? "CLI installed by the client" : app ? `app ${app}` : "started separately"
  const status = typeof health.status === "string" ? `, status "${health.status}"` : ""
  add(ctx, { id: "screenpipe", group: "Screenpipe", status: "ok", detail: `answers on ${url} (${how}${status})` })

  // Screen capture (and accessibility, on Mac).
  const cap = captureDiagnosis(health, ctx.platform, ctx.now)
  const restart =
    bin && ctx.platform === "darwin"
      ? `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${SCREENPIPE_LAUNCHD_LABEL}`
      : bin && ctx.platform === "linux"
        ? "systemctl --user restart screenpipe"
        : undefined
  const capFix: Partial<Check> =
    cap.reason === "permission" || (cap.reason === "not-started" && ctx.platform === "darwin")
      ? { fix: "System Settings → Privacy & Security → Screen Recording → turn on \"screenpipe\". setup opens the right pane and waits.", ...setup }
      : cap.reason === "stalled" && restart
        ? { fix: "Restart Screenpipe.", command: restart, safe: true }
        : cap.reason === "stalled"
          ? { fix: "Restart Screenpipe (quit then reopen the app)." }
          : cap.reason === "disabled"
            ? { fix: "Turn screen capture back on in Screenpipe's settings." }
            : {}
  const ui = health.ui_recorder && typeof health.ui_recorder === "object" ? (health.ui_recorder as { running?: unknown }) : null
  const audio = typeof health.audio_capture_mode === "string" ? health.audio_capture_mode : ""
  const extras = [audio ? `microphone: ${audio === "disabled" ? "off" : audio === "meetings-only" ? "meetings only" : "always"}` : ""].filter(Boolean)
  add(ctx, { id: "capture", group: "Screenpipe", status: cap.status, detail: [cap.detail, ...extras].join("; "), ...capFix })
  if (ctx.platform === "darwin" && ui && ui.running === false && cap.status === "ok") {
    add(ctx, {
      id: "accessibility",
      group: "Screenpipe",
      status: "warn",
      detail: "Accessibility not granted: terminal text is read from the image, less cleanly (optional)",
      fix: "System Settings → Privacy & Security → Accessibility → turn on \"screenpipe\". Nothing to run again.",
    })
  }

  // Local API token and "parsed" data.
  const p = await screenpipeProbe(url, token, 6000)
  if (p.auth === "token_required")
    add(ctx, {
      id: "screenpipe-token",
      group: "Screenpipe",
      status: "fail",
      detail: `Screenpipe asks for a local API token${token ? " (the one in the config is refused)" : " (none in the config)"}: brain-sync reads nothing`,
      fix: "setup reads Screenpipe's token and saves it.",
      ...setup,
    })
  else if (p.auth !== "ok") add(ctx, { id: "screenpipe-token", group: "Screenpipe", status: "warn", detail: `cannot read the data (${p.detail})` })
  else {
    add(ctx, { id: "screenpipe-token", group: "Screenpipe", status: "ok", detail: token ? "local API token accepted" : "reading data without a token (authentication disabled)" })
    if (p.parsed === false)
      add(ctx, {
        id: "screenpipe-parsed",
        group: "Screenpipe",
        status: "warn",
        detail: "no structured conversation (\"parsed\") over 24 h: semantic parser off, or no AI app used since",
        fix: bin
          ? "The CLI installed by setup already turns it on: use ChatGPT or Claude for a few minutes, then run doctor again."
          : "In the Screenpipe app: Settings → Recording → app context \"memory\". Then use ChatGPT or Claude for a few minutes.",
      })
    else if (p.parsed) add(ctx, { id: "screenpipe-parsed", group: "Screenpipe", status: "ok", detail: "structured AI conversations captured over 24 h" })
  }
  if (pipeInstalled()) add(ctx, { id: "pipe", group: "Screenpipe", status: "info", detail: "\"brain-sync\" Screenpipe pipe installed" })
}

// ——— Claude Code ———

/** The companies' MCP servers expected on this computer (setup connected them), or null: the computer's server (stdio). */
function companyMcpSpecs(ctx: Ctx): McpServerSpec[] | null {
  const cfg = ctx.cfg
  if (!cfg || cfg.ca_file) return null
  const list = companiesOf(cfg)
  if (!list.every((c) => c.id)) return null
  if (!Object.keys(readClaudeMcp() ?? {}).length && !Object.keys(readCodexMcp()).length) return null
  return mcpSpecs(list as McpCompany[])
}

/** Each company's MCP server: registered in Claude Code (and Codex if it is there), at the right address, and it answers. */
async function checkCompanyMcp(ctx: Ctx) {
  const specs = companyMcpSpecs(ctx)
  if (!specs) return
  const setup = { command: `${ctx.me} setup`, safe: true }
  const names = specs.map((s) => s.name).join(", ")
  const claude = readClaudeMcp() ?? {}
  const missing = specs.filter((s) => claude[s.name] !== s.url)
  if (missing.length) {
    add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: `MCP ${missing.map((s) => s.name).join(", ")} missing from Claude Code, or on an old address`, fix: "setup reconnects them.", ...setup })
  } else {
    const down = (await Promise.all(specs.map(async (s) => ({ s, err: await probeMcp(s.url, 5000) })))).filter((d) => d.err)
    if (down.length) add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: clean(ctx, `MCP ${down.map((d) => `${d.s.name} does not answer (${d.err})`).join("; ")}`), fix: "Check the connection to the brain, then run setup again.", ...setup })
    else add(ctx, { id: "mcp", group: "Claude Code", status: "ok", detail: `MCP ${names} connected (HTTP, user scope), answering` })
  }
  if (!codexPresent()) return
  const codex = readCodexMcp()
  const absent = specs.filter((s) => codex[s.name] !== s.url)
  add(
    ctx,
    absent.length
      ? { id: "codex-mcp", group: "Codex", status: "warn", detail: `MCP ${absent.map((s) => s.name).join(", ")} missing from ${codexConfigPath()}`, fix: "setup adds them there.", ...setup }
      : { id: "codex-mcp", group: "Codex", status: "ok", detail: `MCP ${names} declared in ${codexConfigPath()}` },
  )
}

function checkClaudeCode(ctx: Ctx) {
  const claude = findOnPath("claude")
  const setup = { command: `${ctx.me} setup`, safe: true }
  const version = claude ? claudeCodeVersion(claude) : null
  if (!claude)
    add(ctx, {
      id: "claude",
      group: "Claude Code",
      status: "warn",
      detail: "`claude` CLI not found in the PATH (Claude desktop app alone?): MCP written straight into its settings, distillation without Claude",
      fix: "Install Claude Code (https://claude.com/claude-code), then run setup again.",
      ...setup,
    })
  else add(ctx, { id: "claude", group: "Claude Code", status: "ok", detail: `Claude Code ${version ?? "(unknown version)"} (${claude})` })

  // company-brain MCP (the computer's server): read from ~/.claude.json, then started for real. When each company has
  // its MCP server (HTTP), checkCompanyMcp checks them instead.
  const perCompany = companyMcpSpecs(ctx) !== null
  const entry = perCompany ? null : readMcpEntry()
  if (perCompany) {
    // checked by checkCompanyMcp
  } else if (entry === undefined) add(ctx, { id: "mcp", group: "Claude Code", status: "warn", detail: `${claudeJsonPath()} unreadable: cannot check the MCP` })
  else if (entry === null) add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: "company-brain MCP missing from Claude Code: your agents cannot query the brain", fix: "setup connects it.", ...setup })
  else {
    const p = probeOnce(entry.command, entry.args.slice(0, 1))
    const other = p.ok ? mismatch(entry.command, entry.args[0] ?? "") : null
    if (!p.ok) add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: `the company-brain MCP does not start (${p.error})`, fix: "setup reconnects it to the current client.", ...setup })
    else if (other || !mcpUpToDate(entry, reference.execPath, reference.script))
      add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: `the company-brain MCP ${other ?? "does not have the right arguments"}`, fix: "setup reconnects it to the current client.", ...setup })
    else add(ctx, { id: "mcp", group: "Claude Code", status: "ok", detail: "company-brain MCP connected (user scope), it starts" })
  }

  // Hooks: all three, on the current client, without duplicates, and startable by Claude Code's shell.
  const installHooks = { command: `${ctx.me} install-hooks`, safe: true }
  let hooks: Record<string, HookCommand[]>
  try {
    hooks = ourHooks()
  } catch (err) {
    return add(ctx, { id: "hooks", group: "Claude Code", status: "fail", detail: clean(ctx, (err as Error).message), fix: `Fix ${paths.claudeSettings()} (invalid JSON), then run install-hooks again.` })
  }
  const missing = HOOK_EVENTS.filter((e) => !hooks[e]?.length)
  const all = HOOK_EVENTS.flatMap((e) => hooks[e] ?? [])
  const dup = HOOK_EVENTS.filter((e) => (hooks[e]?.length ?? 0) > 1)
  if (missing.length === HOOK_EVENTS.length) {
    return add(ctx, { id: "hooks", group: "Claude Code", status: "fail", detail: "Claude Code hooks missing: the brain does not light up during your sessions", fix: "install-hooks adds them (without touching your other settings).", ...installHooks })
  }
  const problems: string[] = []
  let status: Status = "ok"
  if (missing.length) {
    status = "fail"
    problems.push(`missing: ${missing.join(", ")}`)
  }
  const pairs = new Map<string, { exec: string; script: string } | null>()
  for (const h of all) pairs.set(hookText(h), hookTarget(h))
  for (const [text, t] of pairs) {
    if (!t) {
      status = "fail"
      problems.push(`unreadable command (${truncate(text, 80)})`)
      continue
    }
    const p = probeOnce(t.exec, [t.script])
    const other = p.ok ? mismatch(t.exec, t.script) : null
    if (!p.ok) {
      status = "fail"
      problems.push(`does not start (${p.error})`)
    } else if (other) {
      status = "fail"
      problems.push(other)
    }
  }
  if (dup.length) {
    if (status === "ok") status = "warn"
    problems.push(`duplicated: ${dup.join(", ")}`)
  }
  if (ctx.platform === "win32" && all.some((h) => !Array.isArray(h.args)) && !gitBashInstalled()) {
    status = "fail"
    problems.push("without Git Bash, Claude Code passes these hooks to PowerShell, which cannot start them")
  }
  if (status === "ok") add(ctx, { id: "hooks", group: "Claude Code", status, detail: `SessionStart, UserPromptSubmit and Stop connected (${paths.claudeSettings()})` })
  else add(ctx, { id: "hooks", group: "Claude Code", status, detail: `hooks: ${problems.join("; ")}`, fix: "install-hooks puts them right (without touching your other settings).", ...installHooks })

  const errors = recentHookErrors(readTail(paths.log()), ctx.now)
  if (errors.count)
    add(ctx, {
      id: "hook-errors",
      group: "Claude Code",
      status: "warn",
      detail: `${errors.count} hook error(s) over 24 h, the last one: "${clean(ctx, errors.last ?? "")}"`,
      fix: "Harmless for Claude Code (the hooks never block it); if it lasts, look at the connection to the brain above.",
    })
}

/** Node.js and script started by a hook, whatever its form. */
function hookTarget(h: HookCommand): { exec: string; script: string } | null {
  if (Array.isArray(h.args) && typeof h.command === "string" && h.args.length) return { exec: h.command, script: String(h.args[0]) }
  const m = /^\s*"([^"]+)"\s+"([^"]+)"\s+hook\b/.exec(typeof h.command === "string" ? h.command : "")
  return m ? { exec: m[1], script: m[2] } : null
}

// ——— Sync ———

function checkSync(ctx: Ctx) {
  const setup = { command: `${ctx.me} setup`, safe: true }
  const target = scheduleTarget(ctx.platform)
  const how = ctx.platform === "darwin" ? "launchd" : ctx.platform === "win32" ? "Windows task CompanyBrainSync" : "crontab"
  if (target === null && ctx.platform === "linux" && !findOnPath("crontab"))
    add(ctx, {
      id: "schedule",
      group: "Sync",
      status: "fail",
      detail: "automatic sync cannot be scheduled: no crontab on this computer",
      fix: "Install cron (\"cron\" or \"cronie\" package) and start it, then run setup again.",
    })
  else if (target === null)
    add(ctx, {
      id: "schedule",
      group: "Sync",
      status: "fail",
      detail: "automatic sync not scheduled: nothing goes to the brain on its own",
      fix: "setup schedules it (every 15 min, from now on: no history is sent).",
      ...setup,
    })
  else if (target === undefined) add(ctx, { id: "schedule", group: "Sync", status: "warn", detail: `sync scheduled (${how}), but its command is unreadable` })
  else {
    const p = probeOnce(target.execPath, [target.script])
    const other = p.ok ? mismatch(target.execPath, target.script) : null
    if (!p.ok) add(ctx, { id: "schedule", group: "Sync", status: "fail", detail: `the scheduled sync (${how}) does not start (${p.error})`, fix: "setup reconnects it to the current client, without skipping anything that is waiting.", ...setup })
    else if (other)
      add(ctx, { id: "schedule", group: "Sync", status: "fail", detail: `the scheduled sync (${how}) ${other}`, fix: "setup reconnects it to the current client, without skipping anything that is waiting.", ...setup })
    else if (target.home && !samePath(target.home, brainHome()))
      add(ctx, { id: "schedule", group: "Sync", status: "fail", detail: `the scheduled sync uses another folder (${target.home})`, fix: "setup reconnects it to this folder.", ...setup })
    else add(ctx, { id: "schedule", group: "Sync", status: "ok", detail: `every 15 min (${how})` })
  }

  const state = loadState()
  const last = state.last_sync
  const lastAt = last ? Date.parse(last.at) : NaN
  const run = lastLoggedRun(readTail(paths.log()))
  if (Number.isFinite(lastAt)) {
    const zones = Object.entries(last!.zones ?? {})
      .map(([z, n]) => `${zoneName(loadCache(), z)} ${n}`)
      .join(", ")
    const detail = `last sync ${ago(ctx.now - lastAt)}: ${last!.items_sent} knowledge item(s) sent${zones ? ` (${zones})` : ""}, distillation ${DISTILLER_LABELS[last!.distiller as keyof typeof DISTILLER_LABELS] ?? last!.distiller}`
    const old = ctx.now - lastAt > 24 * 3_600_000
    add(ctx, { id: "last-sync", group: "Sync", status: old ? "warn" : "ok", detail: old ? `${detail} (computer off or asleep?)` : detail })
  } else {
    const since = state.baseline_at ? Date.parse(state.baseline_at) : NaN
    add(ctx, {
      id: "last-sync",
      group: "Sync",
      status: Number.isFinite(since) && ctx.now - since > 3_600_000 && target ? "warn" : "info",
      detail: Number.isFinite(since) ? `no sync finished since the setup (${ago(ctx.now - since)})` : "no sync yet",
    })
  }
  // The log's last sync failed before sending (brain unreachable, config…): last_sync does not say so.
  if (run?.error && !run.sent && (run.at === null || !Number.isFinite(lastAt) || run.at > lastAt)) {
    add(ctx, {
      id: "log",
      group: "Sync",
      status: "fail",
      detail: `the last scheduled sync${run.at ? ` (${ago(ctx.now - run.at)})` : ""} failed: "${clean(ctx, run.error)}"`,
      fix: `Fix the matching KO item above; full log: ${paths.log()}.`,
    })
  }

  const lock = paths.lock()
  if (existsSync(lock)) {
    const info = readJson<{ pid?: number }>(lock) ?? {}
    let age = 0
    try {
      age = ctx.now - statSync(lock).mtimeMs
    } catch {
      // removed in the meantime
    }
    const alive = typeof info.pid === "number" && pidAlive(info.pid) && age < LOCK_STALE_MS
    add(ctx, {
      id: "lock",
      group: "Sync",
      status: alive ? "info" : "warn",
      detail: alive ? `sync in progress (process ${info.pid}, ${ago(age)})` : `orphaned lock (${ago(age)}): the next sync will take it over on its own`,
    })
  }

  const failures = Object.keys(state.distill_failures ?? {}).length
  if (failures)
    add(ctx, {
      id: "pending",
      group: "Sync",
      status: "info",
      detail: `${failures} conversation(s) Claude has not managed to distill yet: retried on each sync (given up after 3 failures due to their content)`,
    })
  const preview = readJson<{ created_at?: string; items?: unknown[] }>(paths.preview())
  if (preview?.created_at && ctx.now - Date.parse(preview.created_at) < PREVIEW_TTL_MS)
    add(ctx, {
      id: "dry-run",
      group: "Sync",
      status: "info",
      detail: `dry run reviewed ${ago(ctx.now - Date.parse(preview.created_at))} (${preview.items?.length ?? 0} knowledge item(s)), not sent yet`,
      fix: "It only goes with your explicit approval.",
      command: `${ctx.me} sync --confirm`,
      safe: false,
    })
}

// ——— Distillation ———

function checkDistiller(ctx: Ctx) {
  const cfg = ctx.cfg!
  const d = pickDistiller(cfg)
  if (d.kind === "heuristic")
    add(ctx, {
      id: "distillation",
      group: "Distillation",
      status: "warn",
      detail: `${DISTILLER_LABELS[d.kind]} — ${d.reason}: less precise knowledge`,
      fix: "Install Claude Code and sign in (`claude`), or give an API key with init --anthropic-key.",
    })
  else add(ctx, { id: "distillation", group: "Distillation", status: "ok", detail: `${DISTILLER_LABELS[d.kind]} — ${d.reason}` })

  // Scheduled sync: the PATH recorded at install time must lead to `claude`, and Claude must be signed in.
  if (!apiKey(cfg) && cfg.use_claude_cli !== false && cfg.schedule_env?.PATH !== undefined && d.kind === "claude-cli" && !findOnPath("claude", cfg.schedule_env.PATH)) {
    add(ctx, {
      id: "scheduled-distillation",
      group: "Distillation",
      status: "warn",
      detail: "the scheduled sync cannot find `claude` in its PATH: it would distill without an LLM",
      fix: "setup records the current PATH for the scheduled sync.",
      command: `${ctx.me} setup`,
      safe: true,
    })
  }
  const run = lastLoggedRun(readTail(paths.log()))
  if (run?.auth)
    add(ctx, {
      id: "claude-signin",
      group: "Distillation",
      status: "fail",
      detail: `on the last sync${run.at ? ` (${ago(ctx.now - run.at)})` : ""}, Claude was no longer signed in: nothing was distilled (nothing is lost, everything goes again once signed in)`,
      fix: "In a terminal: sign in to Claude in the browser, then paste the token shown.",
      command: `${ctx.me} connect-claude`,
      safe: false,
    })
  else if (cfg.claude_oauth_token) add(ctx, { id: "claude-signin", group: "Distillation", status: "ok", detail: "long-lived Claude Code token saved for the scheduled sync" })
}

// ——— Everything together ———

export async function runDoctor(opts: { version: string; platform?: NodeJS.Platform; now?: number } = { version: "?" }): Promise<DoctorReport> {
  probes.clear()
  reference = { execPath: process.execPath, script: selfScript() }
  const ctx: Ctx = { checks: [], me: selfCommand(opts.platform), platform: opts.platform ?? process.platform, now: opts.now ?? Date.now(), cfg: null, secrets: [] }
  checkNode(ctx)
  const configured = checkConfig(ctx)
  checkClientFiles(ctx)
  // Network in parallel (brain and Screenpipe), then what starts processes.
  const network: Promise<void>[] = [checkScreenpipe(ctx)]
  if (configured) network.unshift(checkBrain(ctx))
  else {
    for (const id of ["connection", "version"]) add(ctx, { id, group: "Brain", status: "skip", detail: "without config" })
  }
  await Promise.all(network)
  checkClaudeCode(ctx)
  await checkCompanyMcp(ctx)
  checkSync(ctx)
  if (configured) checkDistiller(ctx)
  else add(ctx, { id: "distillation", group: "Distillation", status: "skip", detail: "sans config" })

  const checks = GROUPS.flatMap((g) => ctx.checks.filter((c) => c.group === g))
  const summary: Record<Status, number> = { ok: 0, warn: 0, fail: 0, skip: 0, info: 0 }
  for (const c of checks) summary[c.status]++
  return {
    schema: 1,
    version: opts.version,
    platform: ctx.platform,
    arch: process.arch,
    node: process.versions.node,
    home: brainHome(),
    summary,
    exit_code: summary.fail ? 1 : 0,
    next: checks.find((c) => c.status === "fail") ?? checks.find((c) => c.status === "warn") ?? null,
    checks,
  }
}

const TAGS: Record<Status, string> = { ok: "OK", warn: "!!", fail: "KO", skip: "--", info: " i" }

export function formatDoctor(r: DoctorReport): string {
  const out = [`NOS Brainer — computer diagnosis (client ${r.version}, ${r.platform}-${r.arch}, Node.js ${r.node})`]
  for (const g of GROUPS) {
    const list = r.checks.filter((c) => c.group === g)
    if (!list.length) continue
    out.push("", g)
    for (const c of list) {
      out.push(`  ${TAGS[c.status]}  ${c.id.padEnd(22)} ${c.detail}`)
      if ((c.status === "fail" || c.status === "warn" || c.command) && (c.fix || c.command)) {
        out.push(`      → ${[c.fix, c.command ? `\`${c.command}\`` : ""].filter(Boolean).join(" ")}`)
      }
    }
  }
  const s = r.summary
  out.push("", `Summary: ${s.ok} OK, ${s.warn} to watch, ${s.fail} KO${s.info ? `, ${s.info} for info` : ""}${s.skip ? `, ${s.skip} not checked` : ""}.`)
  if (r.next && r.next.status === "fail") out.push(`Fix first: ${r.next.id} — ${r.next.command ? `\`${r.next.command}\`` : r.next.fix}`)
  else if (!s.fail) out.push(s.warn ? "Nothing blocking." : "Everything is in order.")
  return out.join("\n")
}

export async function cmdDoctor(opts: { version: string; json?: boolean }, log: Log = console.log): Promise<number> {
  const report = await runDoctor({ version: opts.version })
  log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report))
  return report.exit_code
}
