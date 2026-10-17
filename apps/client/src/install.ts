// Installation locale : hooks Claude Code (settings.json), synchro planifiée (launchd / crontab / schtasks),
// pipe Screenpipe « brain-sync » (~/.screenpipe/pipes), désinstallation.

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

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const
export const HOOK_TIMEOUT_S = 5
const OUR_HOOK_RE = /brain\.mjs"?\s+hook\b/
export const OUR_SYNC_RE = /brain\.mjs"?\s+sync\b/

export type HookCommand = { type?: string; command?: string; args?: unknown; timeout?: number; [k: string]: unknown }
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
export type Settings = { hooks?: Record<string, HookGroup[] | unknown>; [k: string]: unknown }

/** Arguments du client après Node.js : le dossier du client suit quand il est personnalisé (hooks et MCP n'héritent pas de l'environnement). */
function clientArgs(script: string, cmd: string): string[] {
  return [script, cmd, ...(customHome() ? ["--home", brainHome()] : [])]
}

export function hookArgs(script = selfScript()): string[] {
  return clientArgs(script, "hook")
}

/** Forme « shell » : une ligne passée à sh (macOS, Linux) ou à Git Bash (Windows). */
export function hookCommand(execPath = process.execPath, script = selfScript()): string {
  return [execPath, ...hookArgs(script)].map((a) => (a === "hook" || a === "--home" ? a : `"${a}"`)).join(" ")
}

/** Version de Claude Code à partir de laquelle un hook peut être lancé sans shell (`command` + `args`). */
export const EXEC_HOOKS_SINCE = "2.1.139"

/**
 * Notre hook. Windows : forme « exec » (node.exe lancé directement avec ses arguments), car sans Git Bash Claude Code
 * passe la ligne à PowerShell, qui n'accepte pas `"node.exe" "brain.mjs" hook`. Ailleurs, ou avec un Claude Code trop
 * ancien pour la forme « exec », la ligne de commande habituelle.
 */
export function hookEntry(opts: { platform?: NodeJS.Platform; claudeVersion?: string | null; execPath?: string; script?: string } = {}): HookCommand {
  const { platform = process.platform, claudeVersion = null, execPath = process.execPath, script = selfScript() } = opts
  const exec = platform === "win32" && !(claudeVersion && versionLt(claudeVersion, EXEC_HOOKS_SINCE))
  return exec
    ? { type: "command", command: execPath, args: hookArgs(script), timeout: HOOK_TIMEOUT_S }
    : { type: "command", command: hookCommand(execPath, script), timeout: HOOK_TIMEOUT_S }
}

/** « 2.1.38 » < « 2.1.139 » (comparaison numérique, composante par composante). */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}

/** Version de Claude Code installée (`claude --version` → « 2.1.302 (Claude Code) »), ou null. */
export function claudeCodeVersion(claude = findOnPath("claude")): string | null {
  if (!claude) return null
  const t = spawnTarget(claude, ["--version"])
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: 15_000, shell: t.shell, windowsHide: true, env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout ?? ""}`)?.[1] ?? null
}

/** La ligne de commande complète d'un hook, quelle que soit sa forme (chaîne seule, ou commande et arguments). */
export function hookText(h: unknown): string {
  if (typeof h === "string") return h
  if (!h || typeof h !== "object") return ""
  const { command, args } = h as HookCommand
  return [typeof command === "string" ? command : "", ...(Array.isArray(args) ? args.map(String) : [])].join(" ")
}

/** Un hook à nous (accepte l'objet du hook ou sa seule commande). */
export function isOurHook(h: unknown): boolean {
  return OUR_HOOK_RE.test(hookText(h))
}

function sameHook(h: HookCommand, want: HookCommand): boolean {
  return h.type === want.type && h.command === want.command && JSON.stringify(h.args ?? null) === JSON.stringify(want.args ?? null) && h.timeout === want.timeout
}

/**
 * Ajoute nos hooks sans toucher au reste : idempotent, met à jour notre hook si le chemin (ou sa forme) a changé et
 * retire nos doublons (une copie restée sur un ancien chemin échouerait à chaque prompt).
 * Renvoie les nouveaux réglages et la liste des changements.
 */
export function mergeHooks(settings: Settings, entry: HookCommand | string): { settings: Settings; changes: string[] } {
  const want: HookCommand = typeof entry === "string" ? { type: "command", command: entry, timeout: HOOK_TIMEOUT_S } : entry
  const next: Settings = structuredClone(settings ?? {})
  const hooks = (next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {}) as Record<string, unknown>
  next.hooks = hooks
  const changes: string[] = []
  for (const event of HOOK_EVENTS) {
    let groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookGroup[]
    let found = false
    let duplicates = 0
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue
      g.hooks = g.hooks.filter((h) => {
        if (!isOurHook(h)) return true
        if (found) {
          duplicates++
          return false
        }
        found = true
        if (!sameHook(h, want)) {
          for (const k of ["type", "command", "args", "timeout", "shell"]) delete h[k]
          Object.assign(h, structuredClone(want))
          changes.push(`${event} : commande mise à jour`)
        }
        return true
      })
    }
    if (duplicates) {
      groups = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
      changes.push(`${event} : ${duplicates} doublon(s) retiré(s)`)
    }
    if (!found) {
      groups.push({ hooks: [structuredClone(want)] })
      changes.push(`${event} : hook ajouté`)
    }
    hooks[event] = groups
  }
  return { settings: next, changes }
}

/** Retire uniquement nos hooks (et les groupes / clés devenus vides à cause de nous). */
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
    throw new Error(`${file} n'est pas un JSON valide : corrigez-le avant de relancer (rien n'a été modifié).`)
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

/** Nos hooks, événement par événement (diagnostic) ; lève une erreur si settings.json n'est pas un JSON valide. */
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
    log(`Hooks déjà installés dans ${file} : rien à changer.`)
    return { changes, backup: null }
  }
  const bak = backup(file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
  log(`Hooks Claude Code installés dans ${file} :`)
  for (const c of changes) log(`  - ${c}`)
  log(`  commande : ${hookText(entry)}`)
  if (bak) log(`  sauvegarde de l'ancien fichier : ${bak}`)
  log("Les autres réglages et hooks n'ont pas été touchés. Effet à la prochaine session Claude Code.")
  return { changes, backup: bak }
}

export function uninstallHooks(log: (s: string) => void = console.log, file = paths.claudeSettings()): number {
  if (!existsSync(file)) {
    log(`Pas de ${file} : aucun hook à retirer.`)
    return 0
  }
  const { settings, removed } = removeHooks(readSettings(file))
  if (removed === 0) {
    log("Aucun hook company-brain dans les réglages Claude Code.")
    return 0
  }
  const bak = backup(file)
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
  log(`${removed} hook(s) company-brain retiré(s) de ${file}${bak ? ` (sauvegarde : ${bak})` : ""}.`)
  return removed
}

// ——— Synchro planifiée ———

export const LAUNCHD_LABEL = "com.company-brain.sync"
export const WINDOWS_TASK = "CompanyBrainSync"

/**
 * Environnement de la synchro planifiée, relevé au moment de l'installation : cron et launchd partent d'un PATH minimal
 * (sans `claude`, donc sans distillation LLM) et ignorent les dossiers personnalisés.
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
  // Dans un crontab, « % » veut dire saut de ligne : on l'échappe.
  const cmd = `${vars}"${execPath}" "${script}" sync --scheduled >> "${join(home, "sync.log")}" 2>&1`.replace(/%/g, "\\%")
  return `*/15 * * * * ${cmd}`
}

/** Remplace notre ligne (s'il y en a une) et garde tout le reste du crontab. */
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
  // RunAtLoad false : rien ne part au chargement ; la première synchro planifiée a lieu 15 min plus tard.
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

/** Windows : la commande reste courte (/TR ≤ 261 caractères) ; PATH et dossiers viennent de config.json (`sync --scheduled`). */
export function windowsTaskArgs(execPath = process.execPath, script = selfScript(), home?: string): string[] {
  const tr = `"${execPath}" "${script}" sync --scheduled${home ? ` --home "${home}"` : ""}`
  return ["/Create", "/SC", "MINUTE", "/MO", "15", "/TN", WINDOWS_TASK, "/TR", tr, "/F"]
}

const RECENT_MS = 24 * 3_600_000
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** Session interne (nos `claude -p`, la session d'installation, un secret du poste collé) : jamais remontée, même sa suite. */
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
 * Point de départ de la synchro planifiée, pour TOUTES les sources : checkpoint Screenpipe à `at` (même s'il était plus
 * ancien, ou absent) et offsets de tous les fichiers Claude Code / Codex à leur fin actuelle. Ce qui précède n'a pas été
 * relu dans la simulation (ou y était reporté, ou tronqué) : il ne partira jamais tout seul.
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
 * Avant de planifier : la synchro automatique part de maintenant pour toutes les sources (rien d'antérieur qui n'ait été
 * relu ne partira tout seul) et l'environnement courant est noté dans config.json pour `sync --scheduled`.
 */
export function prepareSchedule(env: Record<string, string>, log: (s: string) => void = console.log) {
  const cfg = loadPartialConfig()
  const state = loadState()
  const b = baselineSources(state, new Date(), { secrets: ownSecrets(cfg) })
  saveState(state)
  if (cfg.url && cfg.token) saveConfig({ ...cfg, schedule_env: env })
  log(
    `La synchro planifiée part de maintenant : elle n'envoie que l'activité à venir, jamais l'historique non relu` +
      ` (Screenpipe à partir de maintenant, ${b.files} fichier(s) Claude Code / Codex repris à leur fin actuelle).`,
  )
  const claude = findOnPath("claude", env.PATH ?? "")
  if (cfg.anthropic_api_key) log("Distillation planifiée : Claude (API Anthropic), clé enregistrée dans la config.")
  else if (cfg.use_claude_cli !== false && claude) {
    log(`Distillation planifiée : Claude Code en local (\`claude -p\`, ${claude})${cfg.claude_oauth_token ? ", avec le jeton Claude Code de la config" : ""}.`)
    if (!cfg.claude_oauth_token)
      log("Si la synchro planifiée n'arrive pas à utiliser votre session Claude Code : `claude setup-token`, puis `init --claude-token <jeton>` (le jeton reste dans config.json).")
  } else log(`Distillation planifiée : heuristique locale (${cfg.use_claude_cli === false ? "CLI Claude désactivée" : "CLI `claude` introuvable dans le PATH transmis"}).`)
  if (!cfg.anthropic_api_key && process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY n'est pas transmise à la synchro planifiée (elle n'est jamais écrite dans le planificateur) : `init --anthropic-key <clé>` pour l'utiliser.")
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

/** Node.js et script de la synchro planifiée installée (diagnostic) ; null si aucune, undefined si illisible. */
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
 * Synchro déjà planifiée (setup relancé) : la définition est réécrite avec le Node.js et le script actuels (après une
 * réinstallation ou une mise à jour de Node, l'ancienne pointerait dans le vide), SANS nouveau point de départ : rien de
 * ce qui attend d'être envoyé n'est sauté.
 */
export function refreshSchedule(log: (s: string) => void = console.log): boolean {
  const env = scheduleEnv(process.env, process.execPath)
  const cfg = loadPartialConfig()
  if (cfg.url && cfg.token && JSON.stringify(cfg.schedule_env ?? null) !== JSON.stringify(env)) saveConfig({ ...cfg, schedule_env: env })
  return writeSchedule(env, log)
}

/** Écrit la planification (launchd, crontab ou tâche Windows) avec le Node.js et le script actuels. */
export function writeSchedule(env: Record<string, string>, log: (s: string) => void = console.log): boolean {
  const execPath = process.execPath
  const script = selfScript()
  if (process.platform === "darwin") {
    const file = launchdPlistPath()
    const plist = launchdPlist(execPath, script, brainHome(), env)
    mkdirSync(dirname(file), { recursive: true })
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== plist
    if (!changed && run("launchctl", ["list", LAUNCHD_LABEL]).ok) {
      log(`Synchro déjà planifiée toutes les 15 min via launchd (${file}) : à jour.`)
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
      log(`Synchro planifiée toutes les 15 min via launchd (${file}). Journal : ${paths.log()}`)
      return true
    }
    log(`Impossible de charger le LaunchAgent (${r.stderr.trim()}). À lancer à la main :\n  launchctl load -w "${file}"`)
    return false
  }
  if (process.platform === "win32") {
    const args = windowsTaskArgs(execPath, script, customHome() ? brainHome() : undefined)
    const r = run("schtasks", args)
    if (r.ok) {
      log(`Synchro planifiée toutes les 15 min (tâche Windows « ${WINDOWS_TASK} »).`)
      return true
    }
    log(`Échec de schtasks (${r.stderr.trim()}). Relance \`install-schedule\` dans PowerShell ou cmd (pas dans Git Bash, qui transforme « /Create » en chemin).`)
    return false
  }
  const line = cronLine(execPath, script, brainHome(), env)
  const current = run("crontab", ["-l"])
  const existing = current.ok ? current.stdout : ""
  if (!current.ok && /not found|ENOENT/i.test(current.stderr)) {
    log(`crontab est introuvable sur ce poste. Ajoutez cette ligne à votre planificateur :\n  ${line}`)
    return false
  }
  const { text, changed } = mergeCrontab(existing, line)
  if (!changed) {
    log("Synchro déjà planifiée dans le crontab : rien à changer.")
    return true
  }
  const w = run("crontab", ["-"], text)
  if (w.ok) {
    log(`Synchro planifiée toutes les 15 min dans le crontab :\n  ${line}`)
    return true
  }
  log(`Impossible d'écrire le crontab (${w.stderr.trim()}). Ajoutez cette ligne avec \`crontab -e\` :\n  ${line}`)
  return false
}

export function uninstallSchedule(log: (s: string) => void = console.log) {
  if (process.platform === "darwin") {
    const file = launchdPlistPath()
    if (!existsSync(file)) return log("Aucune synchro launchd à retirer.")
    run("launchctl", ["unload", "-w", file])
    unlinkSync(file)
    return log(`Synchro launchd retirée (${file}).`)
  }
  if (process.platform === "win32") {
    const r = run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"])
    return log(r.ok ? `Tâche planifiée « ${WINDOWS_TASK} » supprimée.` : "Aucune tâche planifiée à supprimer.")
  }
  const current = run("crontab", ["-l"])
  if (!current.ok) return log("Aucun crontab : rien à retirer.")
  const { text, removed } = removeFromCrontab(current.stdout)
  if (!removed) return log("Aucune ligne company-brain dans le crontab.")
  const w = text ? run("crontab", ["-"], text) : run("crontab", ["-r"])
  log(w.ok ? "Ligne company-brain retirée du crontab." : `Impossible de modifier le crontab (${w.stderr.trim()}) : retirez la ligne « brain.mjs sync » avec \`crontab -e\`.`)
}

// --- Pipe Screenpipe ------------------------------------------------------------------------------------------------

export const PIPE_NAME = "brain-sync"
/** Reconnaît notre pipe par son titre et sa commande, quel que soit le chemin du script (brain.mjs ou source). */
export const PIPE_TITLE = "Cerveau d'entreprise, synchro"

/** Commande CLI Screenpipe (celle du skill officiel ; `bun x` marche aussi). */
export const SCREENPIPE_CLI = "npx -y screenpipe@latest"

/** Dossier de Screenpipe (~/.screenpipe), surchargeable pour les tests. */
export function screenpipeDir(): string {
  return resolve(process.env.COMPANY_BRAIN_SCREENPIPE_DIR ?? join(homedir(), ".screenpipe"))
}

export function pipePath(): string {
  return join(screenpipeDir(), "pipes", PIPE_NAME, "pipe.md")
}

/**
 * Le pipe : Screenpipe exécute ce prompt toutes les 15 minutes et à la fin de chaque réunion, avec un jeton borné
 * aux lectures listées (permissions.allow) et le masquage natif (privacy_filter). Il ne fait que lancer brain-sync.
 */
export function pipeMarkdown(execPath = process.execPath, script = selfScript(), home = brainHome()): string {
  return `---
schedule: every 15m
enabled: true
title: ${PIPE_TITLE}
description: Distille les sessions IA et les réunions de ce poste vers le cerveau partagé (rien de brut ne quitte le poste)
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

Lance exactement cette commande dans un shell, puis rapporte sa sortie en une ou deux phrases (connaissances envoyées,
avertissements). Ne lis aucune donnée toi-même, n'envoie rien ailleurs, ne modifie aucun fichier. Si la commande échoue,
rapporte l'erreur telle quelle.

\`"${execPath}" "${script}" sync --scheduled --home "${home}"\`
`
}

export function pipeInstalled(file = pipePath()): boolean {
  try {
    if (!existsSync(file)) return false
    const text = readFileSync(file, "utf8")
    return text.includes(`title: ${PIPE_TITLE}`) && /\bsync --scheduled\b/.test(text)
  } catch {
    return false
  }
}

export function installPipe(log: (s: string) => void = console.log, file = pipePath()): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, pipeMarkdown())
  log(`Pipe « ${PIPE_NAME} » écrit dans ${file}.`)
  log(`Activer : ${SCREENPIPE_CLI} pipe enable ${PIPE_NAME} — tester : ${SCREENPIPE_CLI} pipe run ${PIPE_NAME} — journaux : ${SCREENPIPE_CLI} pipe logs ${PIPE_NAME}`)
  log("Il faut l'application Screenpipe (le moteur de pipes) ; avec le CLI seul, la synchro planifiée de install-schedule suffit.")
  return file
}

export function uninstallPipe(log: (s: string) => void = console.log, file = pipePath()) {
  if (!pipeInstalled(file)) return log("Pipe Screenpipe : rien à retirer.")
  rmSync(dirname(file), { recursive: true, force: true })
  log(`Pipe « ${PIPE_NAME} » retiré de Screenpipe.`)
}

// --- MCP company-brain (Claude Code) ----------------------------------------------------------------------------------

export const MCP_NAME = "company-brain"

/** Arguments du serveur MCP après Node.js. */
export function mcpArgs(script = selfScript()): string[] {
  return clientArgs(script, "mcp")
}

/** Où Claude Code range les serveurs MCP de portée utilisateur : ~/.claude.json, ou dans CLAUDE_CONFIG_DIR s'il est défini. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(claudeDir(), ".claude.json") : join(homedir(), ".claude.json")
}

export type McpEntry = { command: string; args: string[] }

/**
 * Notre serveur MCP tel que Claude Code l'a enregistré (lecture du fichier, sans lancer `claude mcp get`, qui écrit
 * des fichiers et contacte le réseau). null : pas enregistré ; undefined : fichier illisible.
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

/** Deux chemins désignent-ils le même fichier ? (liens résolus ; casse ignorée sous Windows et macOS.) */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    let r = resolve(p)
    try {
      r = realpathSync(r)
    } catch {
      // fichier absent : on compare le chemin tel quel
    }
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** L'entrée MCP lance-t-elle bien ce Node.js et ce script, avec les bons arguments ? */
export function mcpUpToDate(e: McpEntry, execPath = process.execPath, script = selfScript()): boolean {
  const want = mcpArgs(script)
  return samePath(e.command, execPath) && e.args.length === want.length && samePath(e.args[0] ?? "", want[0]) && e.args.slice(1).join(" ") === want.slice(1).join(" ")
}

/** La commande `claude mcp add` à lancer à la main si le CLI `claude` n'a pas pu le faire. */
export function mcpAddCommand(): string {
  return `claude mcp add ${MCP_NAME} --scope user -- ${[process.execPath, ...mcpArgs()].map((a) => quoteArg(a)).join(" ")}`
}

export function uninstall(opts: { purge?: boolean }, log: (s: string) => void = console.log) {
  try {
    uninstallHooks(log)
  } catch (err) {
    log(`Hooks : ${(err as Error).message}`)
  }
  try {
    uninstallPipe(log)
  } catch (err) {
    log(`Pipe Screenpipe : ${(err as Error).message}`)
  }
  try {
    uninstallSchedule(log)
  } catch (err) {
    log(`Planification : ${(err as Error).message}`)
  }
  try {
    uninstallScreenpipeService(log)
  } catch (err) {
    log(`Screenpipe : ${(err as Error).message}`)
  }
  const r = spawnSync("claude", ["mcp", "remove", "company-brain", "--scope", "user"], {
    encoding: "utf8",
    timeout: 15000,
    shell: process.platform === "win32",
    env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
  })
  if (!r.error && r.status === 0) log("Serveur MCP company-brain retiré de Claude Code.")
  else log("MCP : rien retiré (absent, ou CLI `claude` introuvable). À la main : claude mcp remove company-brain --scope user")
  if (opts.purge) {
    try {
      rmSync(brainHome(), { recursive: true, force: true })
      log(`Dossier ${brainHome()} supprimé (config, jeton, état, journaux).`)
    } catch (err) {
      // Windows : le node.exe de la copie privée qui exécute cette commande ne peut pas s'effacer lui-même.
      log(`Dossier ${brainHome()} vidé en partie (${(err as Error).message}) : supprime-le à la main une fois ce terminal fermé.`)
    }
  } else {
    log(`Config et jeton conservés dans ${brainHome()} (ajoutez --purge pour tout supprimer).`)
  }
}

