// Chemins, configuration et état local du client (~/.company-brain).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Zone } from "@brain/core"

export const SOURCE_NAMES = ["claude", "codex", "screenpipe"] as const
export type SourceName = (typeof SOURCE_NAMES)[number]

export const DEFAULT_SCREENPIPE_URL = "http://localhost:3030"
export const DEFAULT_SCREENPIPE_CONTENT_TYPES = ["parsed", "accessibility", "ocr"]

export type Config = {
  url: string
  token: string
  screenpipe_url: string
  screenpipe_token?: string
  anthropic_api_key?: string
  /** Jeton Claude Code longue durée (`claude setup-token`) : passé à chaque `claude -p` (CLAUDE_CODE_OAUTH_TOKEN). */
  claude_oauth_token?: string
  use_claude_cli: boolean
  sources: SourceName[]
  app_whitelist?: string[]
  screenpipe_content_types?: string[]
  /** Hook UserPromptSubmit : envoyer un court résumé masqué des prompts classés dans une zone (défaut : oui). */
  share_prompt_summaries?: boolean
  /** Environnement relevé par install-schedule, réappliqué par `sync --scheduled` (utile sous Windows). */
  schedule_env?: Partial<Record<(typeof SCHEDULE_ENV_KEYS)[number], string>>
}

/** Variables utiles à la synchro planifiée (PATH pour trouver `claude`, dossiers personnalisés). */
export const SCHEDULE_ENV_KEYS = ["PATH", "COMPANY_BRAIN_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const

export type FileCheckpoint = { offset: number; size: number; mtime: number; internal?: boolean }

export type SeenLines = { at: string; h: string[] }

export type State = {
  claude?: { files: Record<string, FileCheckpoint> }
  codex?: { files: Record<string, FileCheckpoint> }
  screenpipe?: {
    last_timestamp?: string
    /** Lignes déjà envoyées, par fenêtre (empreintes) : une fenêtre restée ouverte n'est pas renvoyée à chaque passage. */
    seen?: Record<string, SeenLines>
    /** Taille de fenêtre de lecture apprise quand Screenpipe ne donne pas le total (ms). */
    span_ms?: number
  }
  /** Posé par install-schedule : la synchro automatique ne remonte rien d'antérieur qui n'ait déjà été relu. */
  baseline_at?: string
  /**
   * Conversations que Claude n'a pas su distiller (elles passent après les autres). n : essais probants (le modèle a
   * répondu, ou Claude a répondu à un autre appel de la synchro), abandon à MAX_DISTILL_ATTEMPTS ; tries : tous les essais
   * décomptés, probants ou non, depuis first_at (garde-fou : abandon après 24 h et 5 essais) ; at : dernier échec.
   */
  distill_failures?: Record<string, { n: number; at: string; error?: string; tries?: number; first_at?: string }>
  last_sync?: {
    at: string
    distiller: string
    items_sent: number
    conversations: Partial<Record<SourceName, number>>
    zones: Record<string, number>
  }
}

export type CachedZone = Pick<Zone, "id" | "name" | "description" | "keywords"> & { readable: boolean }

export type Cache = {
  updated_at: string
  whoami?: { name: string; org: string; title?: string; role: string; readable: string[]; writable: string[] }
  zones?: CachedZone[]
}

export function brainHome(): string {
  return resolve(process.env.COMPANY_BRAIN_HOME ?? join(homedir(), ".company-brain"))
}

export function claudeDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
}

export function codexDir(): string {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))
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

/** Chemin absolu du script en cours (brain.mjs une fois empaqueté). */
export function selfScript(): string {
  if (process.env.COMPANY_BRAIN_SCRIPT) return resolve(process.env.COMPANY_BRAIN_SCRIPT)
  return fileURLToPath(import.meta.url)
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

/** Écriture atomique (fichier temporaire puis renommage), avec mode optionnel. */
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
    sources: [...SOURCE_NAMES],
    ...raw,
    url: raw.url?.replace(/\/+$/, ""),
  }
}

/** `sync --scheduled` : complète l'environnement avec celui relevé par install-schedule (sans écraser l'existant). */
export function applyScheduleEnv(cfg: Partial<Config>, env: NodeJS.ProcessEnv = process.env) {
  const saved = cfg.schedule_env ?? {}
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) if (saved[k] && !env[k]) env[k] = saved[k]
  if (saved.PATH) env.PATH = [...new Set([...(env.PATH ?? "").split(delimiter), ...saved.PATH.split(delimiter)].filter(Boolean))].join(delimiter)
}

export function saveConfig(cfg: Partial<Config>) {
  ensureHome()
  writeJson(paths.config(), cfg, 0o600)
}

export function requireConfig(): Config {
  const cfg = loadConfig()
  if (!cfg) {
    throw new UserError(
      `Client non configuré (${paths.config()} absent ou incomplet). Lancez d'abord : node ${selfScript()} init --url <url du cerveau> --token <jeton>`,
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

/** Erreur « attendue » : message français affiché sans pile d'appels. */
export class UserError extends Error {}

export function maskSecret(s: string | undefined): string {
  if (!s) return "(aucun)"
  if (s.length <= 10) return "•".repeat(s.length)
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}
