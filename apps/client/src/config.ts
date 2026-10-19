// Paths, configuration and local state of the client (~/.company-brain).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Zone } from "@brain/core"

export const SOURCE_NAMES = ["claude", "codex", "screenpipe"] as const
export type SourceName = (typeof SOURCE_NAMES)[number]

export const DEFAULT_SCREENPIPE_URL = "http://localhost:3030"
export const DEFAULT_SCREENPIPE_CONTENT_TYPES = ["parsed", "accessibility", "ocr"]

/**
 * A company connected on this computer: its brain and the personal token we have there. Name and description (noted by
 * `init`) tell the agents which one to query.
 */
export type Company = { url: string; token: string; id?: string; name?: string; description?: string }

export type Config = {
  /** Brain and token of the first company: the default one (MCP tools), and the one of the sync, the hooks and the skills. */
  url: string
  token: string
  /** Who the first company is (noted by `init`). */
  org?: { id?: string; name: string; description?: string }
  /** The computer's other companies, in order: the MCP tools query them when asked to. */
  companies?: Company[]
  screenpipe_url: string
  screenpipe_token?: string
  anthropic_api_key?: string
  /** Long-lived Claude Code token (`claude setup-token`): passed to every `claude -p` (CLAUDE_CODE_OAUTH_TOKEN). */
  claude_oauth_token?: string
  use_claude_cli: boolean
  sources: SourceName[]
  app_whitelist?: string[]
  screenpipe_content_types?: string[]
  /** Screenpipe meetings (transcriptions) distilled like the AI sessions (default: yes). */
  screenpipe_meetings?: boolean
  /**
   * Screenpipe agent: on every sync, Claude Code or Codex looks at the recent activity through the Screenpipe MCP.
   * true (default): Claude Code if it is there, otherwise Codex; "claude" / "codex": that engine only; false: off.
   */
  screenpipe_agent?: boolean | "claude" | "codex"
  /** Model of the Screenpipe agent (default: sonnet for Claude Code, Codex's own otherwise). */
  agent_model?: string
  /** UserPromptSubmit hook: send a short redacted summary of the prompts classified in a zone (default: yes). */
  share_prompt_summaries?: boolean
  /**
   * The sync also sends the documents (PDF, Word, Excel…) an AI session worked on, with the knowledge distilled from
   * it (default: yes).
   */
  send_documents?: boolean
  /** Certificate (PEM) of the authority that signs a self-hosted brain: the client trusts it on top of the public certificates. */
  ca_file?: string
  /** Environment recorded by install-schedule, applied again by `sync --scheduled` (useful on Windows). */
  schedule_env?: Partial<Record<(typeof SCHEDULE_ENV_KEYS)[number], string>>
}

/** Variables useful to the scheduled sync (PATH to find `claude`, custom folders). */
export const SCHEDULE_ENV_KEYS = ["PATH", "COMPANY_BRAIN_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const

export type FileCheckpoint = { offset: number; size: number; mtime: number; internal?: boolean }

export type SeenLines = { at: string; h: string[] }

export type State = {
  claude?: { files: Record<string, FileCheckpoint> }
  codex?: { files: Record<string, FileCheckpoint> }
  screenpipe?: {
    last_timestamp?: string
    /** Lines already sent, per window (fingerprints): a window left open is not sent again on every pass. */
    seen?: Record<string, SeenLines>
    /** Read window size learned when Screenpipe does not give the total (ms). */
    span_ms?: number
    /** End of the last distilled meeting: the meetings finished before it are done. */
    meetings_last_end?: string
    /** End of the last window looked at by the Screenpipe agent. */
    agent_until?: string
  }
  /** Set by install-schedule: the automatic sync sends up nothing earlier that has not already been read. */
  baseline_at?: string
  /** Fingerprint of the brain certificate already installed for the computer's browsers (setup does not ask again). */
  ca_trusted?: string
  /**
   * Conversations Claude could not distill (they go after the others). n: conclusive attempts (the model
   * answered, or Claude answered another call of the sync), given up at MAX_DISTILL_ATTEMPTS; tries: every attempt
   * counted, conclusive or not, since first_at (safeguard: given up after 24 h and 5 attempts); at: last failure.
   */
  distill_failures?: Record<string, { n: number; at: string; error?: string; tries?: number; first_at?: string }>
  /** Documents already handled, by fingerprint: their id in the brain once sent, or why it refused them (not offered again). */
  documents?: Record<string, { id?: string; refused?: string; at: string }>
  last_sync?: {
    at: string
    distiller: string
    items_sent: number
    conversations: Partial<Record<SourceName, number>>
    zones: Record<string, number>
  }
}

export type CachedZone = Pick<Zone, "id" | "name" | "description" | "keywords" | "projects"> & { readable: boolean }

export type Cache = {
  updated_at: string
  whoami?: { name: string; org: string; title?: string; role: string; readable: string[]; writable: string[] }
  zones?: CachedZone[]
}

// An empty variable counts as "not set" (otherwise resolve("") would give the current folder, and the config would go into a project).
export function brainHome(): string {
  return resolve(process.env.COMPANY_BRAIN_HOME || join(homedir(), ".company-brain"))
}

export function claudeDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))
}

export function codexDir(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
}

/** Is the client folder customized (COMPANY_BRAIN_HOME)? Hooks, MCP and scheduling then pass it on. */
export function customHome(): boolean {
  return Boolean(process.env.COMPANY_BRAIN_HOME) && brainHome() !== resolve(homedir(), ".company-brain")
}

export const paths = {
  config: () => join(brainHome(), "config.json"),
  state: () => join(brainHome(), "state.json"),
  cache: () => join(brainHome(), "cache.json"),
  lock: () => join(brainHome(), "sync.lock"),
  log: () => join(brainHome(), "sync.log"),
  preview: () => join(brainHome(), "preview.json"),
  claudeSettings: () => join(claudeDir(), "settings.json"),
}

/** Absolute path of the running script (brain.mjs once bundled). */
export function selfScript(): string {
  if (process.env.COMPANY_BRAIN_SCRIPT) return resolve(process.env.COMPANY_BRAIN_SCRIPT)
  return fileURLToPath(import.meta.url)
}

/** The shortcut written by install.sh (`brain`) or install.ps1 (`brain.cmd`, usable from PowerShell and Git Bash). */
export function shortcutPath(platform: NodeJS.Platform = process.platform): string {
  return join(brainHome(), platform === "win32" ? "brain.cmd" : "brain")
}

/**
 * The command to quote in messages to run the client again: the shortcut if it exists (it works even when Node.js
 * is a private copy, outside the PATH: `node …` would fail there), otherwise Node.js and the script as absolute paths.
 */
export function selfCommand(platform: NodeJS.Platform = process.platform): string {
  const shortcut = shortcutPath(platform)
  if (existsSync(shortcut)) return customHome() ? quoteArg(shortcut, platform) : `~/.company-brain/${basename(shortcut)}`
  return `${quoteArg(process.execPath, platform)} ${quoteArg(selfScript(), platform)}`
}

/**
 * A path ready to paste into a terminal. Windows: forward slashes (Git Bash removes `\` outside quotes; Node.js,
 * cmd and PowerShell accept them), double quotes if needed (no `"` possible). Elsewhere: single quotes.
 */
export function quoteArg(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const p = s.replace(/\\/g, "/")
    return /[\s&()^%!;,'$`]/.test(p) ? `"${p}"` : p
  }
  return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

/** Atomic write (temporary file then rename), with an optional mode. */
export function writeJson(file: string, data: unknown, mode?: number) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined)
  if (mode) chmodSync(tmp, mode)
  renameSync(tmp, file)
  if (mode) chmodSync(file, mode)
}

export function ensureHome() {
  mkdirSync(brainHome(), { recursive: true, mode: 0o700 })
  // The folder often already exists (created by curl or install.sh with default permissions): it holds config and token.
  if (process.platform !== "win32") {
    try {
      chmodSync(brainHome(), 0o700)
    } catch {
      // not ours: we do not insist
    }
  }
}

export function loadConfig(): Config | null {
  const raw = readJson<Partial<Config>>(paths.config())
  if (!raw || !raw.url || !raw.token) return null
  return withDefaults(raw) as Config
}

export function loadPartialConfig(): Partial<Config> {
  return readJson<Partial<Config>>(paths.config()) ?? {}
}

export function withDefaults(raw: Partial<Config>): Partial<Config> {
  return {
    screenpipe_url: DEFAULT_SCREENPIPE_URL,
    use_claude_cli: true,
    share_prompt_summaries: true,
    send_documents: true,
    screenpipe_meetings: true,
    screenpipe_agent: true,
    sources: [...SOURCE_NAMES],
    ...raw,
    url: raw.url?.replace(/\/+$/, ""),
  }
}

/** `sync --scheduled`: completes the environment with the one recorded by install-schedule (without overwriting what exists). */
export function applyScheduleEnv(cfg: Partial<Config>, env: NodeJS.ProcessEnv = process.env) {
  const saved = cfg.schedule_env ?? {}
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) if (saved[k] && !env[k]) env[k] = saved[k]
  if (saved.PATH) env.PATH = [...new Set([...(env.PATH ?? "").split(delimiter), ...saved.PATH.split(delimiter)].filter(Boolean))].join(delimiter)
}

export function saveConfig(cfg: Partial<Config>) {
  ensureHome()
  writeJson(paths.config(), cfg, 0o600)
}

/** All the computer's companies, the first one (the default) first. */
export function companiesOf(cfg: Pick<Config, "url" | "token" | "org" | "companies">): Company[] {
  return [{ url: cfg.url, token: cfg.token, ...cfg.org }, ...(cfg.companies ?? [])]
}

/** Display name of a company: its name, otherwise the address of its brain. */
export function companyLabel(c: Company): string {
  if (c.name) return c.name
  try {
    return new URL(c.url).host
  } catch {
    return c.url
  }
}

/** The config with these companies, in this order (the first one becomes the default). */
export function withCompanies<T extends Partial<Config>>(cfg: T, list: Company[]): T {
  const [first, ...rest] = list
  const { url, token, ...org } = first
  const next: T = { ...cfg, url, token, org: org.name ? org : undefined, companies: rest.length ? rest : undefined }
  if (!next.org) delete next.org
  if (!next.companies) delete next.companies
  return next
}

export function requireConfig(): Config {
  const cfg = loadConfig()
  if (!cfg) {
    throw new UserError(
      `Client not configured (${paths.config()} missing or incomplete). First run: ${selfCommand()} init --url <brain url> --token <token>`,
    )
  }
  return cfg
}

export function loadState(): State {
  return readJson<State>(paths.state()) ?? {}
}

export function saveState(state: State) {
  ensureHome()
  writeJson(paths.state(), state)
}

export function loadCache(): Cache | null {
  return readJson<Cache>(paths.cache())
}

export function saveCache(cache: Cache) {
  ensureHome()
  writeJson(paths.cache(), cache)
}

export function fileExists(file: string): boolean {
  return existsSync(file)
}

/** "Expected" error: message shown without a stack trace. */
export class UserError extends Error {}

export function maskSecret(s: string | undefined): string {
  if (!s) return "(none)"
  if (s.length <= 10) return "•".repeat(s.length)
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}
