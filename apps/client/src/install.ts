// Installation locale : hooks Claude Code (settings.json), synchro planifiée (launchd / crontab / schtasks),
// pipe Screenpipe « brain-sync » (~/.screenpipe/pipes), désinstallation.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { brainHome, loadPartialConfig, loadState, paths, saveConfig, saveState, selfScript } from "./config"
import { findOnPath } from "./distill"

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const
export const HOOK_TIMEOUT_S = 5
const OUR_HOOK_RE = /brain\.mjs"?\s+hook\b/
const OUR_SYNC_RE = /brain\.mjs"?\s+sync\b/

type HookCommand = { type?: string; command?: string; timeout?: number; [k: string]: unknown }
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
type Settings = { hooks?: Record<string, HookGroup[] | unknown>; [k: string]: unknown }

export function hookCommand(execPath = process.execPath, script = selfScript()): string {
  return `"${execPath}" "${script}" hook`
}

export function isOurHook(cmd: unknown): boolean {
  return typeof cmd === "string" && OUR_HOOK_RE.test(cmd)
}

/**
 * Ajoute nos hooks sans toucher au reste : idempotent, met à jour notre commande si le chemin a changé.
 * Renvoie les nouveaux réglages et la liste des changements.
 */
export function mergeHooks(settings: Settings, command: string): { settings: Settings; changes: string[] } {
  const next: Settings = structuredClone(settings ?? {})
  const hooks = (next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {}) as Record<string, unknown>
  next.hooks = hooks
  const changes: string[] = []
  for (const event of HOOK_EVENTS) {
    const groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookGroup[]
    let found = false
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (!isOurHook(h?.command)) continue
        if (found) continue
        found = true
        if (h.command !== command || h.type !== "command") {
          h.type = "command"
          h.command = command
          h.timeout = HOOK_TIMEOUT_S
          changes.push(`${event} : commande mise à jour`)
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] })
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
      const kept = g.hooks.filter((h) => !isOurHook(h?.command))
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

function readSettings(file: string): Settings {
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
      return Array.isArray(groups) && (groups as HookGroup[]).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurHook(h?.command)))
    })
  } catch {
    return false
  }
}

export function installHooks(log: (s: string) => void = console.log, file = paths.claudeSettings()): { changes: string[]; backup: string | null } {
  const before = readSettings(file)
  const { settings, changes } = mergeHooks(before, hookCommand())
  if (changes.length === 0) {
    log(`Hooks déjà installés dans ${file} : rien à changer.`)
    return { changes, backup: null }
  }
  const bak = backup(file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n")
  log(`Hooks Claude Code installés dans ${file} :`)
  for (const c of changes) log(`  - ${c}`)
  log(`  commande : ${hookCommand()}`)
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

/**
 * Avant de planifier : la synchro automatique part de maintenant (rien d'antérieur qui n'ait été relu ne partira tout
 * seul) et l'environnement courant est noté dans config.json pour `sync --scheduled`.
 */
export function prepareSchedule(env: Record<string, string>, log: (s: string) => void = console.log) {
  const state = loadState()
  state.baseline_at = new Date().toISOString()
  saveState(state)
  const cfg = loadPartialConfig()
  if (cfg.url && cfg.token) saveConfig({ ...cfg, schedule_env: env })
  log("La synchro planifiée part de maintenant : elle n'envoie que l'activité à venir, jamais l'historique non relu.")
  const claude = findOnPath("claude", env.PATH ?? "")
  if (cfg.anthropic_api_key) log("Distillation planifiée : Claude (API Anthropic), clé enregistrée dans la config.")
  else if (cfg.use_claude_cli !== false && claude) log(`Distillation planifiée : Claude Code en local (\`claude -p\`, ${claude}).`)
  else log(`Distillation planifiée : heuristique locale (${cfg.use_claude_cli === false ? "CLI Claude désactivée" : "CLI `claude` introuvable dans le PATH transmis"}).`)
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

export function installSchedule(log: (s: string) => void = console.log): boolean {
  const execPath = process.execPath
  const script = selfScript()
  const env = scheduleEnv(process.env, execPath)
  prepareSchedule(env, log)
  if (process.platform === "darwin") {
    const file = launchdPlistPath()
    const plist = launchdPlist(execPath, script, brainHome(), env)
    mkdirSync(dirname(file), { recursive: true })
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== plist
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
    const args = windowsTaskArgs(execPath, script, process.env.COMPANY_BRAIN_HOME ? brainHome() : undefined)
    const r = run("schtasks", args)
    if (r.ok) {
      log(`Synchro planifiée toutes les 15 min (tâche Windows « ${WINDOWS_TASK} »).`)
      return true
    }
    log(`Échec de schtasks (${r.stderr.trim()}). À lancer à la main dans un terminal :\n  schtasks ${args.map((a) => (a.includes(" ") ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`)
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
  const r = spawnSync("claude", ["mcp", "remove", "company-brain", "--scope", "user"], {
    encoding: "utf8",
    timeout: 15000,
    shell: process.platform === "win32",
    env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
  })
  if (!r.error && r.status === 0) log("Serveur MCP company-brain retiré de Claude Code.")
  else log("MCP : rien retiré (absent, ou CLI `claude` introuvable). À la main : claude mcp remove company-brain --scope user")
  if (opts.purge) {
    rmSync(brainHome(), { recursive: true, force: true })
    log(`Dossier ${brainHome()} supprimé (config, jeton, état, journaux).`)
  } else {
    log(`Config et jeton conservés dans ${brainHome()} (ajoutez --purge pour tout supprimer).`)
  }
}

