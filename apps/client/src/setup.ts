// `brain.mjs setup`: the whole connection of the computer in one command, so that the install prompt only asks for one
// permission in Claude Code. Brain (config) → Screenpipe (installed and started if it is not running) → macOS
// permissions (settings opened in the right place, resumes automatically as soon as they are granted) → MCP + hooks →
// scheduled sync (upcoming activity only) → neon (hello) → the brain opens in the browser, already signed in.
// Idempotent: `setup` without parameters resumes where it stopped.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BrainApi } from "./api"
import { cmdHello, initBrain } from "./commands"
import { fingerprintOfFile, trustInBrowsers } from "./ca"
import { cmdConnectClaude, hasScheduledClaude } from "./connect"
import { brainHome, loadPartialConfig, loadState, maskSecret, requireConfig, saveConfig, saveState, selfCommand, UserError, type Company, type Config } from "./config"
import { findOnPath } from "./distill"
import { MCP_NAME, installHooks, installSchedule, mcpAddCommand, mcpArgs, mcpUpToDate, readMcpEntry, refreshSchedule, scheduleInstalled } from "./install"
import { companiesWithIds, mcpSpecs, probeMcp, registerMcpServers } from "./mcp-config"
import { refreshSkills } from "./skills"
import {
  installedScreenpipeBin,
  installScreenpipeCli,
  readScreenpipeToken,
  restartScreenpipeService,
  runCommand,
  screenpipeLoadError,
  screenpipeSupported,
  startScreenpipe,
} from "./screenpipe-cli"
import { CLIENT_HEADERS, TOKEN_COMMAND, screenpipeProbe } from "./sources/screenpipe"

type Log = (s: string) => void

/** Exit code when everything is connected except the screen recording permission: run `setup` again once granted. */
export const EXIT_PERMISSIONS_PENDING = 3
/** Exit code when everything is connected except Screenpipe (no binary for this computer, or it does not start): `doctor` says why. */
export const EXIT_NO_SCREENPIPE = 6
export const DEFAULT_WAIT_S = 300

export const MACOS_PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

export type CaptureState = {
  /** Screenpipe's local API answers. */
  up: boolean
  /** At least one frame captured: the "Screen Recording" permission is granted. */
  screen: boolean
  /** Accessibility reading on (clean text of the windows); null if Screenpipe does not say. */
  accessibility: boolean | null
  detail?: string
}

/** Reads the capture state in the GET /health response (which answers 200 even when capture has not started). */
export function captureState(health: unknown): CaptureState {
  if (health === null || health === undefined) return { up: false, screen: false, accessibility: null }
  const h = health as { last_frame_timestamp?: unknown; frame_status?: unknown; ui_recorder?: unknown; message?: unknown }
  const frame = typeof h.frame_status === "string" ? h.frame_status.toLowerCase() : ""
  const ui = h.ui_recorder && typeof h.ui_recorder === "object" ? (h.ui_recorder as { running?: unknown }) : null
  return {
    up: true,
    screen: Boolean(h.last_frame_timestamp) || ["ok", "healthy", "active", "running", "recording"].includes(frame),
    accessibility: ui && "running" in ui ? ui.running === true : null,
    detail: typeof h.message === "string" ? h.message : undefined,
  }
}

export async function readHealth(url: string, token?: string, timeoutMs = 3000): Promise<unknown | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      headers: { accept: "application/json", ...CLIENT_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      return {}
    }
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(url: string, token: string | undefined, ok: (s: CaptureState) => boolean, deadline: number, pollMs: number, onTick?: (left: number) => void) {
  let st = captureState(await readHealth(url, token))
  let lastTick = Date.now()
  while (!ok(st) && Date.now() < deadline) {
    await sleep(pollMs)
    st = captureState(await readHealth(url, token))
    if (onTick && Date.now() - lastTick >= 30_000) {
      lastTick = Date.now()
      onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)))
    }
  }
  return st
}

function openUrl(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  const r = spawnSync(cmd, args as string[], { stdio: "ignore", timeout: 10_000, windowsHide: true })
  return !r.error && r.status === 0
}

function copyToClipboard(text: string): boolean {
  if (process.platform !== "darwin") return false
  const r = spawnSync("pbcopy", [], { input: text, timeout: 5000 })
  return !r.error && r.status === 0
}

export type PermissionOptions = {
  url: string
  token?: string
  waitMs: number
  pollMs?: number
  platform?: NodeJS.Platform
  /** Binary to add by hand in the settings if it does not show in the list. */
  bin?: string | null
  open?: (url: string) => void
  restart?: () => boolean
  log?: Log
}

/**
 * Waits for Screenpipe to really capture. On macOS, opens the right Settings pane and resumes on its own as soon as
 * the permission is granted: nobody has to come back to the terminal to say "done".
 * Screen: required. Accessibility: recommended (clean terminal text instead of OCR), without blocking.
 */
export async function waitForCapture(o: PermissionOptions): Promise<CaptureState> {
  const log = o.log ?? console.log
  const open = o.open ?? ((u: string) => void openUrl(u))
  const poll = o.pollMs ?? 2000
  const platform = o.platform ?? process.platform
  const deadline = Date.now() + o.waitMs
  let st = captureState(await readHealth(o.url, o.token))
  if (!st.up) return st

  if (platform !== "darwin") {
    // No permission to ask for: we leave a little time for the first capture.
    st = await waitUntil(o.url, o.token, (s) => s.screen, Math.min(deadline, Date.now() + 20_000), poll)
    if (!st.screen) log(`Screenpipe is running but has not captured anything yet${st.detail ? ` (${st.detail})` : ""}${platform === "linux" ? "; on Wayland, accept the screen sharing if it is offered" : ""}.`)
    return st
  }

  if (!st.screen) {
    log("→ Permission 1/2: System Settings → Privacy & Security → Screen & System Audio Recording → turn on \"screenpipe\".")
    log("  If macOS offers \"Quit & Reopen\", choose \"Later\": Screenpipe resumes on its own.")
    if (o.bin) {
      const copied = copyToClipboard(o.bin)
      log(`  If "screenpipe" is not in the list: "+" button, then ⌘⇧G and paste this path${copied ? " (already copied to the clipboard)" : ""}: ${o.bin}`)
    }
    open(MACOS_PANES.screen)
    log(`  Waiting for the permission (up to ${Math.round(o.waitMs / 1000)} s)…`)
    st = await waitUntil(o.url, o.token, (s) => s.screen, deadline, poll, (left) => log(`  … still waiting for Screen Recording (${left} s left).`))
    if (!st.screen) return st
    log("✓ Screen Recording allowed: capture has started.")
  }

  if (st.accessibility === false) {
    log("→ Permission 2/2 (recommended): System Settings → Privacy & Security → Accessibility → turn on \"screenpipe\" (same method with \"+\" if it is missing).")
    log("  It lets Screenpipe read the text of the windows (terminal, Claude) cleanly instead of deciphering it from the image.")
    open(MACOS_PANES.accessibility)
    const axDeadline = Date.now() + Math.min(o.waitMs, 120_000)
    let restarted = false
    st = await waitUntil(o.url, o.token, (s) => s.accessibility !== false && s.up, axDeadline, poll, () => {
      // A permission granted to a service already running is sometimes only taken into account on restart.
      if (!restarted && o.restart) restarted = o.restart()
    })
    if (st.accessibility === false) {
      log("  Accessibility not granted yet: capture works anyway. Check \"screenpipe\" in Accessibility whenever you like, nothing else to run.")
    } else if (st.accessibility) {
      log("✓ Accessibility allowed.")
    }
  }
  return st
}

/**
 * company-brain MCP in Claude Code (user scope). Already registered but on another Node.js or another script
 * (reinstall, Node updated): replaced, otherwise Claude Code would start a server that no longer exists.
 */
export function ensureMcp(log: Log = console.log): boolean {
  const manual = mcpAddCommand()
  const claude = findOnPath("claude")
  if (!claude) {
    log(`MCP: \`claude\` CLI not found in the PATH. To run by hand: ${manual}`)
    return false
  }
  const current = readMcpEntry()
  if (current && mcpUpToDate(current)) {
    log(`MCP ${MCP_NAME}: already connected in Claude Code.`)
    return true
  }
  // Unreadable Claude Code file: we rely on the CLI to know whether it is there.
  if (current === undefined && runCommand(claude, ["mcp", "get", MCP_NAME], 30_000).ok) {
    log(`MCP ${MCP_NAME}: already connected in Claude Code.`)
    return true
  }
  if (current) runCommand(claude, ["mcp", "remove", MCP_NAME, "--scope", "user"], 30_000)
  const r = runCommand(claude, ["mcp", "add", MCP_NAME, "--scope", "user", "--", process.execPath, ...mcpArgs()], 30_000)
  log(
    r.ok
      ? `MCP ${MCP_NAME} ${current ? "updated (it pointed to an old path)" : "connected in Claude Code"}: active from the next session.`
      : `MCP: failed (${r.stderr.trim().slice(0, 200)}). To run by hand: ${manual}`,
  )
  return r.ok
}

/**
 * MCP: the server of each company of the computer (the brain's endpoint, HTTP), connected in Claude Code and Codex as
 * "nos-brainer-<company>"; the computer's server (stdio) would then duplicate the first company's one, so it is
 * removed. Brain with a private certificate (unknown to Claude Code and Codex), or endpoint unreachable: the computer's
 * server, as before.
 */
export async function ensureMcpServers(log: Log = console.log): Promise<void> {
  const cfg = requireConfig()
  const list = cfg.ca_file ? null : await companiesWithIds(cfg)
  const specs = list ? mcpSpecs(list) : null
  const down = specs ? (await Promise.all(specs.map(async (s) => ({ s, err: await probeMcp(s.url) })))).find((p) => p.err) : undefined
  if (!specs || down) {
    log(
      cfg.ca_file
        ? "MCP: brain with a private certificate, which Claude Code and Codex do not know: the computer's MCP server (company-brain)."
        : `MCP: ${down ? `${down.s.label}'s MCP server does not answer (${down.err})` : "this brain does not give the company's id"}: the computer's MCP server (company-brain) instead.`,
    )
    ensureMcp(log)
    return
  }
  if (!registerMcpServers(specs, log)) return
  const legacy = readMcpEntry()
  const claude = findOnPath("claude")
  if (legacy && claude && runCommand(claude, ["mcp", "remove", MCP_NAME, "--scope", "user"], 30_000).ok) {
    log(`MCP ${MCP_NAME} (the computer's server) removed: each company now has its own MCP server.`)
  }
  log("The MCP servers are active from the next session (Claude Code: /mcp; Codex: codex mcp list).")
}

/** Opens the brain, already signed in thanks to a short-lived sign-in link; failing that, the sign-in page. */
async function openBrain(cfg: Pick<Config, "url" | "token">, noOpen: boolean, log: Log) {
  if (noOpen) return log(`The brain: ${cfg.url}`)
  let target = `${cfg.url}/login`
  try {
    const { path } = await new BrainApi(cfg.url, cfg.token, 8000).loginLink()
    if (path.startsWith("/")) target = `${cfg.url}${path}`
  } catch {
    // older brain, without a sign-in link: sign-in page with the token
  }
  log(openUrl(target) ? `The brain opens in your browser: ${cfg.url}` : `Open the brain in your browser: ${cfg.url}`)
}

export function desktopApp(): string | null {
  if (process.platform !== "darwin") return null
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    for (const name of ["screenpipe.app", "Screenpipe.app"]) if (existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

async function waitUp(url: string, token: string | undefined, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await readHealth(url, token)) !== null) return true
    await sleep(1500)
  }
  return false
}

function yesNo(v: string | boolean | undefined, flag: string): boolean | undefined {
  if (v === undefined) return undefined
  if (v === true) return true
  const s = String(v).toLowerCase()
  if (["yes", "on", "true", "1", "oui"].includes(s)) return true
  if (["no", "off", "false", "0", "non"].includes(s)) return false
  throw new UserError(`--${flag}: "yes" or "no" (got "${v}").`)
}

type ScreenpipeResult = { how: "existing" | "app" | "service" | "background"; bin: string | null }

/** Screenpipe already running (CLI or app): we keep it. Otherwise the app if it is there, otherwise the CLI as a service. */
async function ensureScreenpipe(cfg: Config, audio: boolean | undefined, log: Log): Promise<ScreenpipeResult> {
  let bin = installedScreenpipeBin()
  const running = (await readHealth(cfg.screenpipe_url, cfg.screenpipe_token)) !== null
  if (running && !(audio !== undefined && bin)) {
    log(`Screenpipe is already running (${cfg.screenpipe_url}): we keep it as is.`)
    return { how: "existing", bin }
  }
  if (!running && !bin) {
    const app = desktopApp()
    if (app) {
      log(`Screenpipe app found (${app}): starting it.`)
      runCommand("open", ["-a", app], 15_000)
      if (await waitUp(cfg.screenpipe_url, cfg.screenpipe_token, 60_000)) return { how: "app", bin: null }
      log("The app does not answer: installing the CLI instead.")
    }
  }
  if (!bin && !screenpipeSupported()) {
    throw new UserError(`Screenpipe does not publish a version for ${process.platform}-${process.arch} (macOS, Linux x64 and Windows x64 only).`)
  }
  bin = bin ?? installScreenpipeCli(log)
  const loadError = screenpipeLoadError(bin)
  if (loadError) {
    const why = /GLIBC|shared object|shared librar/i.test(loadError)
      ? ": it needs glibc ≥ 2.39 (Ubuntu 24.04 or later) and the system's pipewire / pulseaudio libraries"
      : /dyld|Library not loaded|Symbol not found/i.test(loadError)
        ? ": it needs macOS 11 or later"
        : ""
    throw new UserError(`Screenpipe does not start on this computer ("${loadError}")${why}.`)
  }
  const how = startScreenpipe(bin, { audio }, log)
  if (!(await waitUp(cfg.screenpipe_url, cfg.screenpipe_token, process.platform === "win32" ? 180_000 : 60_000))) {
    throw new UserError(`Screenpipe does not answer on ${cfg.screenpipe_url} (log: ${join(brainHome(), "screenpipe.log")}, or \`"${bin}" service status\`).`)
  }
  if (audio) log("Microphone on: meetings will be transcribed (macOS will also ask for the Microphone permission).")
  else log("Microphone off: only the screen is captured (run `setup --audio yes` to also transcribe meetings).")
  return { how, bin }
}

/** Screenpipe's local API token: read and saved if it is missing or no longer works. */
async function ensureScreenpipeToken(cfg: Config, bin: string | null, log: Log): Promise<Config> {
  let probe = await screenpipeProbe(cfg.screenpipe_url, cfg.screenpipe_token)
  if (probe.auth === "token_required") {
    const token = readScreenpipeToken(bin)
    if (token) {
      saveConfig({ ...loadPartialConfig(), screenpipe_token: token })
      cfg = { ...cfg, screenpipe_token: token }
      log(`Screenpipe local API token saved (${maskSecret(token)}).`)
      probe = await screenpipeProbe(cfg.screenpipe_url, token)
    } else {
      log(`Screenpipe token not found: show it with \`${bin ? `"${bin}" auth token` : TOKEN_COMMAND}\`, then \`${selfCommand()} init --screenpipe-token <token>\`.`)
    }
  }
  log(`Reading Screenpipe data: ${probe.detail}.`)
  return cfg
}

/** Self-hosted brain: its certificate is installed for the computer's browsers, only once per certificate. */
export function trustCaForBrowsers(file: string, log: Log) {
  const state = loadState()
  const fp = fingerprintOfFile(file)
  if (fp && state.ca_trusted === fp) return log(`Brain certificate already installed for the browsers (${file}).`)
  const t = trustInBrowsers(file)
  log(t.message)
  if (t.ok && fp) saveState({ ...state, ca_trusted: fp })
}

/**
 * The computer's Claude Code token, asked for at install: in a terminal, `connect-claude` right away; run by
 * Claude Code (no terminal of its own), a "TO DO" line that the install prompt has repeated. Nothing to ask
 * with a token already saved, an API key, or without Claude Code. Returns the "TO DO" line, or null.
 */
async function askClaudeToken(log: Log): Promise<string | null> {
  if (hasScheduledClaude() || !findOnPath("claude")) {
    if (hasScheduledClaude()) log("Claude Code token: already saved for the scheduled sync.")
    return null
  }
  const todo = `TO DO (once, 1 min): in a terminal, run \`${selfCommand()} connect-claude\` (sign in to Claude in the browser, then paste the token shown). Without it, the 15-min sync cannot run Claude when no session is open.`
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return todo
  try {
    await cmdConnectClaude(log)
    return null
  } catch (err) {
    log(`Claude Code token: ${(err as Error).message}`)
    return todo
  }
}

export async function cmdSetup(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const audio = yesNo(flags.audio, "audio")
  const waitS = typeof flags.wait === "string" ? Number.parseInt(flags.wait, 10) : DEFAULT_WAIT_S
  if (!(waitS >= 0)) throw new UserError("--wait: a number of seconds.")
  const me = selfCommand()

  log("[1/6] Connecting to the brain")
  // Company added next to the first one (another company's token): it is the one that lights up and opens at the end.
  let added: Company | undefined
  if (flags.url || flags.token) {
    const init = await initBrain(flags, log)
    if (init.code !== 0) {
      log("The brain did not accept the connection: check the URL and the token, then run setup again.")
      return 1
    }
    if (init.added) added = init.company
  }
  let cfg = requireConfig()
  if (!(flags.url || flags.token)) {
    try {
      const who = await new BrainApi(cfg.url, cfg.token, 8000).whoami()
      log(`Connection to the brain OK: ${who.profile.name} at ${who.org.name}.`)
    } catch (err) {
      log(`The brain does not answer (${(err as Error).message}).`)
      return 1
    }
  }

  if (cfg.ca_file) trustCaForBrowsers(cfg.ca_file, log)

  let capture: CaptureState | null = null
  let noScreenpipe: string | null = null
  if (flags["skip-screenpipe"]) {
    log("[2/6] Screenpipe: skipped (--skip-screenpipe); brain-sync will only read the Claude Code and Codex sessions.")
    log("[3/6] Permissions: nothing to ask for.")
  } else {
    log("[2/6] Screenpipe (local screen capture; nothing raw leaves the computer)")
    // Without Screenpipe, the rest (MCP, hooks, sync of the Claude Code and Codex sessions) is still worth connecting.
    let sp: ScreenpipeResult | null = null
    try {
      sp = await ensureScreenpipe(cfg, audio, log)
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      noScreenpipe = err.message
      log(`${err.message} Connecting the rest: brain-sync will read the Claude Code and Codex sessions.`)
      log("[3/6] Permissions: nothing to ask for without Screenpipe.")
    }
    if (sp) {
      cfg = await ensureScreenpipeToken(cfg, sp.bin, log)
      log("[3/6] Permissions")
      capture = await waitForCapture({
        url: cfg.screenpipe_url,
        token: cfg.screenpipe_token,
        waitMs: waitS * 1000,
        // Also when setup is run again (Screenpipe "already started" by us): the typical case after a code 3.
        bin: sp.how === "app" ? null : sp.bin,
        restart: sp.bin ? restartScreenpipeService : undefined,
        log,
      })
      if (capture.screen) log("Screenpipe captures the screen.")
    }
  }

  log("[4/6] Claude Code and Codex: each company's MCP server, hooks and skills")
  await ensureMcpServers(log)
  installHooks(log)
  await refreshSkills(log)

  log("[5/6] Automatic sync")
  // Already scheduled: paths updated, without a new starting point (what is waiting to be sent is not skipped).
  if (scheduleInstalled()) refreshSchedule(log)
  else installSchedule(log)
  // Claude Code token: without it, the 15-min sync (without an open session) cannot run Claude.
  const claudeToDo = await askClaudeToken(log)

  log("[6/6] Your neon and the brain")
  try {
    await cmdHello(log, added)
  } catch (err) {
    log(`Neon: ${(err as Error).message}`)
  }
  await openBrain(added ?? cfg, Boolean(flags["no-open"]), log)

  log("")
  log("It is connected. Keep working with Claude Code: each session lights up your zone, and distilled knowledge reaches the brain every 15 minutes.")
  log(`See what would be sent: ${me} sync --dry-run --full — diagnosis: ${me} doctor — remove everything: ${me} uninstall`)
  if (claudeToDo) {
    log("")
    log(claudeToDo)
  }
  if (capture && !capture.up) {
    log("")
    log(`WAITING: Screenpipe no longer answers on ${cfg.screenpipe_url}. Run again: ${me} setup`)
    return EXIT_PERMISSIONS_PENDING
  }
  if (capture && !capture.screen && process.platform === "darwin") {
    log("")
    log(`WAITING: "Screen Recording" permission for screenpipe not granted yet. Once checked, run again: ${me} setup`)
    return EXIT_PERMISSIONS_PENDING
  }
  if (noScreenpipe) {
    log("")
    log(`CONNECTED WITHOUT SCREENPIPE: ${noScreenpipe} Details and fix: ${me} doctor`)
    return EXIT_NO_SCREENPIPE
  }
  return 0
}
