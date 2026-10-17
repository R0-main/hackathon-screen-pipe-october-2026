// Screenpipe as a CLI, managed by the client: installed in ~/.company-brain/screenpipe (stable path, no admin rights),
// run as a service (launchd on macOS, systemd --user on Linux) or, failing that, in the background.
// Why a stable path: the service runs this precise binary, and macOS ties the permissions (Screen Recording,
// Accessibility) to that path. A binary in npx's cache would change path on every update.

import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { brainHome, UserError } from "./config"
import { findOnPath, spawnTarget } from "./distill"

type Log = (s: string) => void

/** CLI version installed by `setup` (options checked against it: service install --record-args, --app-context). */
export const SCREENPIPE_VERSION = "0.4.52"
/** Label of the LaunchAgent written by `screenpipe service install` on macOS. */
export const SCREENPIPE_LAUNCHD_LABEL = "com.screenpipe.agent"

/**
 * npm packages of the binaries (optional dependencies of the `screenpipe` package). Windows ARM64: Screenpipe only publishes
 * the x64 binary, which Windows 11 runs under emulation (installed with `--cpu=x64`).
 */
const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@screenpipe/cli-darwin-arm64",
  "darwin-x64": "@screenpipe/cli-darwin-x64",
  "linux-x64": "@screenpipe/cli-linux-x64",
  "win32-x64": "@screenpipe/cli-win32-x64",
  "win32-arm64": "@screenpipe/cli-win32-x64",
}

/** Computers without a published Screenpipe binary: setup still connects the rest (Claude Code and Codex sessions). */
export function screenpipeSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return Boolean(PLATFORM_PACKAGES[`${platform}-${arch}`])
}

/** No Screenpipe telemetry at install time (computer name sent to PostHog), nor during our CLI calls. */
export const NO_TELEMETRY_ENV = { DO_NOT_TRACK: "1", SCREENPIPE_DISABLE_TELEMETRY: "1" }

export function screenpipePrefix(home = brainHome()): string {
  return join(home, "screenpipe")
}

/** Path of the native binary once installed; null if Screenpipe does not publish a binary for this computer. */
export function screenpipeBinPath(prefix = screenpipePrefix(), platform: string = process.platform, arch: string = process.arch): string | null {
  const pkg = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!pkg) return null
  return join(prefix, "node_modules", ...pkg.split("/"), "bin", platform === "win32" ? "screenpipe.exe" : "screenpipe")
}

/**
 * Does the binary start? On Linux it needs glibc ≥ 2.39 and system libraries (pipewire, pulse…); on a
 * Mac that is too old, dyld refuses. Only these loading errors are read: an unknown option says nothing about the binary.
 */
export function screenpipeLoadError(bin: string): string | null {
  const r = runCommand(bin, ["--version"], 15_000, NO_TELEMETRY_ENV)
  if (r.ok) return null
  const text = `${r.stderr}\n${r.stdout}`
  const line = text.split(/\r?\n/).find((l) => LOAD_ERROR_RE.test(l))
  // The binary's path (very long, under ~/.company-brain/screenpipe/node_modules/…) teaches nothing: only the error matters.
  return line ? line.split(bin).join("screenpipe").trim().slice(0, 300) : null
}

const LOAD_ERROR_RE = /error while loading shared libraries|cannot open shared object|GLIBC_\d|GLIBCXX_\d|dyld\b|Library not loaded|Symbol not found|Exec format error|bad CPU type|ENOEXEC|EACCES/i

/** The binary installed by the client, if it exists. */
export function installedScreenpipeBin(): string | null {
  const bin = screenpipeBinPath()
  return bin && existsSync(bin) ? bin : null
}

/**
 * Recording options: no microphone by default (one less macOS permission, no audio to explain), "memory" app
 * context (the `parsed` data brain-sync reads), and videos / screenshots deleted after 14 days (the text stays
 * searchable; ~19 GB in two weeks otherwise). Redaction of personal data and private browsing ignored: on by default.
 */
export function recordArgs(opts: { audio?: boolean } = {}): string[] {
  return [...(opts.audio ? [] : ["--disable-audio"]), "--app-context", "memory", "--retention-days", "14"]
}

/** `screenpipe auth token` (a token like "sp-1a2b3c4d") can write logs first: we keep the last line without spaces. */
export function parseAuthToken(out: string): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const l of lines.reverse()) if (/^[A-Za-z0-9._~+/=-]{8,}$/.test(l)) return l
  return null
}

export function runCommand(cmd: string, args: string[], timeoutMs = 30_000, extraEnv: Record<string, string> = {}) {
  // Windows: npm.cmd / npx.cmd only start through the shell, which quotes nothing itself (paths with spaces).
  const t = spawnTarget(cmd, args)
  // npm and npx are "#!/usr/bin/env node" scripts: the node running this client goes first in the PATH.
  const env = { ...process.env, ...extraEnv, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) }
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: timeoutMs, shell: t.shell, env, windowsHide: true })
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error?.message ?? "") }
}

/** Last useful lines of an output, for a readable error message. */
export function tail(text: string, lines = 3): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(" / ").slice(0, 400) || "no details"
}

function npmPath(): string | null {
  const local = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm")
  return existsSync(local) ? local : findOnPath("npm")
}

/** Installs the CLI (official npm package) if it is not already there; returns the binary's path. */
export function installScreenpipeCli(log: Log = console.log): string {
  const bin = screenpipeBinPath()
  if (!bin) {
    throw new UserError(
      `Screenpipe does not publish a CLI for ${process.platform}-${process.arch}: install the Screenpipe app (https://screenpi.pe), start it, then run setup again.`,
    )
  }
  if (existsSync(bin)) return bin
  const npm = npmPath()
  if (!npm) throw new UserError("npm not found (it ships with Node.js): reinstall Node.js ≥ 20, then run setup again.")
  const prefix = screenpipePrefix()
  mkdirSync(prefix, { recursive: true })
  log(`Installing Screenpipe ${SCREENPIPE_VERSION} (official npm package "screenpipe") in ${prefix}… one to two minutes.`)
  // --ignore-scripts: the package's post-install script downloads an unpinned ffmpeg from a third-party site (macOS),
  // runs `sudo apt-get` (Linux) and sends telemetry. Screenpipe installs ffmpeg itself on first start.
  const cpu = process.platform === "win32" && process.arch === "arm64" ? ["--cpu=x64", "--os=win32"] : []
  const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...cpu, `screenpipe@${SCREENPIPE_VERSION}`]
  const r = runCommand(npm, args, 10 * 60_000, NO_TELEMETRY_ENV)
  if (!r.ok || !existsSync(bin)) {
    throw new UserError(`Screenpipe install failed (${tail(r.stderr || r.stdout)}). Other way: the Screenpipe app (https://screenpi.pe), then run setup again.`)
  }
  if (process.platform !== "win32") chmodSync(bin, 0o755)
  // What the post-install script did that matters: macOS must not block the downloaded binary.
  if (process.platform === "darwin") runCommand("xattr", ["-d", "com.apple.quarantine", bin], 10_000)
  return bin
}

/**
 * Starts recording: as a service if possible (starts with the session, restarted after a crash), otherwise in the
 * background. Running `service install` again applies new options and restarts the service.
 */
export function startScreenpipe(bin: string, opts: { audio?: boolean }, log: Log = console.log): "service" | "background" {
  const args = recordArgs(opts)
  if (process.platform !== "win32") {
    const r = runCommand(bin, ["service", "install", `--record-args=${args.join(" ")}`], 60_000)
    if (r.ok) {
      log(`Screenpipe runs as a service (${process.platform === "darwin" ? "launchd" : "systemd"}): it starts with your session and restarts on its own.`)
      return "service"
    }
    log(`Screenpipe service impossible (${tail(r.stderr || r.stdout, 1)}): starting in the background instead.`)
  }
  const logFile = join(brainHome(), "screenpipe.log")
  mkdirSync(brainHome(), { recursive: true })
  const fd = openSync(logFile, "a")
  const child = spawn(bin, ["record", ...args], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true })
  child.on("error", () => {})
  child.unref()
  if (child.pid) writeFileSync(pidFile(), String(child.pid))
  log(`Screenpipe runs in the background (log: ${logFile}). After restarting the computer, run \`setup\` again.`)
  return "background"
}

/** PID of the recording started in the background (no service), to be able to stop it on uninstall. */
function pidFile(): string {
  return join(brainHome(), "screenpipe.pid")
}

/** macOS: restarts the service (a freshly granted permission is sometimes only taken into account on restart). */
export function restartScreenpipeService(): boolean {
  if (process.platform !== "darwin") return false
  if (!existsSync(join(homedir(), "Library", "LaunchAgents", `${SCREENPIPE_LAUNCHD_LABEL}.plist`))) return false
  return runCommand("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${SCREENPIPE_LAUNCHD_LABEL}`], 15_000).ok
}

/** Local API token (required for /search); through our binary, otherwise through npx (Screenpipe app). */
export function readScreenpipeToken(bin: string | null): string | null {
  if (bin) {
    const r = runCommand(bin, ["auth", "token"], 20_000, NO_TELEMETRY_ENV)
    return r.ok ? parseAuthToken(r.stdout) : null
  }
  const local = join(dirname(process.execPath), process.platform === "win32" ? "npx.cmd" : "npx")
  const npx = existsSync(local) ? local : findOnPath("npx")
  if (!npx) return null
  const r = runCommand(npx, ["-y", `screenpipe@${SCREENPIPE_VERSION}`, "auth", "token"], 5 * 60_000, NO_TELEMETRY_ENV)
  return r.ok ? parseAuthToken(r.stdout) : null
}

/** Stops Screenpipe if it was started by `setup` (service or background); the data in ~/.screenpipe stays. */
export function uninstallScreenpipeService(log: Log = console.log) {
  const bin = installedScreenpipeBin()
  if (!bin) return log("Screenpipe: not installed by the client, nothing to stop (a Screenpipe app is to be handled separately).")
  const pid = Number.parseInt(existsSync(pidFile()) ? readFileSync(pidFile(), "utf8") : "", 10)
  if (pid > 0) {
    try {
      process.kill(pid)
      log(`Screenpipe stopped (process ${pid}).`)
    } catch {
      // already stopped
    }
    rmSync(pidFile(), { force: true })
  }
  if (process.platform !== "win32") {
    const r = runCommand(bin, ["service", "uninstall"], 30_000)
    if (r.ok && !/none installed/i.test(r.stdout)) log("Screenpipe service stopped and removed.")
  }
  log("Screenpipe's recordings stay in ~/.screenpipe (delete them by hand if you want to erase everything).")
}
