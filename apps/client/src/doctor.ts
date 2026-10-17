// `brain doctor` : diagnostic du poste, en lecture seule. Chaque point dit ce qui va, ce qui cloche et la commande qui
// répare. Pour l'employé, et surtout pour Claude Code quand l'installation ou la synchro coince (`--json`).
// Rien n'est modifié : ni config, ni cache, ni état, ni réglages de Claude Code (pas de `claude mcp get`, qui écrit des
// fichiers et contacte le réseau). Aucun jeton n'est affiché, même en partie : seulement sa présence (la sortie finit dans
// la session de Claude Code, que brain-sync relit).

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { redactText, truncate } from "@brain/core"
import { installCommands } from "../../web/lib/install-prompt"
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
  withDefaults,
  type Config,
} from "./config"
import { DISTILLER_LABELS, apiKey, findOnPath, pickDistiller, spawnTarget } from "./distill"
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
import { installedScreenpipeBin, screenpipeLoadError, screenpipeSupported, SCREENPIPE_LAUNCHD_LABEL } from "./screenpipe-cli"
import { maskOwnSecrets, ownSecrets } from "./secrets"
import { desktopApp, readHealth } from "./setup"
import { screenpipeProbe } from "./sources/screenpipe"
import { LOCK_STALE_MS, PREVIEW_TTL_MS, pidAlive } from "./sync"

type Log = (s: string) => void

export type Status = "ok" | "warn" | "fail" | "skip" | "info"
export const GROUPS = ["Poste", "Cerveau", "Screenpipe", "Claude Code", "Synchro", "Distillation"] as const
export type Group = (typeof GROUPS)[number]

/**
 * Un point du diagnostic. `fix` : quoi faire, en une phrase ; `command` : la commande exacte, quand il y en a une ;
 * `safe` : cette commande ne fait que (re)brancher le poste (rien n'est envoyé, rien n'est effacé, aucun choix à faire) :
 * Claude Code peut la lancer sans redemander.
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
  /** Le premier problème à régler (le premier KO, sinon le premier point à surveiller), dans l'ordre du diagnostic. */
  next: Check | null
  checks: Check[]
}

/** Chemins de Node.js gérés par un gestionnaire de versions : la prochaine mise à jour les supprime. */
const VERSIONED_NODE_RE = /[\\/](Cellar|\.nvm|nvm|fnm|\.fnm|\.volta|Volta|\.asdf|mise|\.nodenv|n[\\/]versions|pnpm)[\\/]/i

type Probe = { ok: true; node: string; script: string; version: string } | { ok: false; error: string }

/** Lance un client enregistré (raccourci, hook, MCP, synchro planifiée) avec `_probe` : démarre-t-il, et lequel ? */
function probe(cmd: string, args: string[]): Probe {
  if (!existsSync(cmd)) return { ok: false, error: `introuvable : ${cmd}` }
  // Seulement notre client (jamais `npx … _probe` ou un autre serveur MCP qui porterait notre nom).
  if (args.length && !/brain\.mjs$/i.test(args[0]) && !samePath(args[0], selfScript())) return { ok: false, error: `ce n'est pas le client du cerveau (${args[0]})` }
  if (args.length && !existsSync(args[0])) return { ok: false, error: `introuvable : ${args[0]}` }
  const t = spawnTarget(cmd, [...args, "_probe"])
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: 15_000, shell: t.shell, windowsHide: true, env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  if (r.error) return { ok: false, error: r.error.message }
  const line = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? ""
  try {
    const p = JSON.parse(line) as { node?: string; script?: string; version?: string }
    if (r.status === 0 && p.node && p.script) return { ok: true, node: p.node, script: p.script, version: p.version ?? "?" }
  } catch {
    // pas notre client, ou il a planté
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
 * Le client de référence : celui que lance le raccourci du poste s'il marche (doctor peut tourner sur un autre Node.js,
 * ex. `node ~/.company-brain/brain.mjs doctor`), sinon ce processus. C'est aussi lui que `setup` enregistre quand on le
 * relance par le raccourci, comme le proposent les corrections.
 */
let reference: { execPath: string; script: string } = { execPath: process.execPath, script: selfScript() }

/** Que dire d'un branchement qui ne lance pas le client de référence (null : c'est bien lui). */
function mismatch(execPath: string, script: string): string | null {
  if (!samePath(script, reference.script)) return `lance un autre client (${script})`
  if (!samePath(execPath, reference.execPath)) return `lance un autre Node.js (${execPath}, au lieu de ${reference.execPath})`
  return null
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} jours`
}

/** Fin d'un fichier (journal), sans tout lire. */
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

/** Date d'un en-tête « brain-sync — 17/10/2026 12:18:32 » (fr-FR, heure locale). */
function headerDate(line: string): number | null {
  const m = /brain-sync — (\d{1,2})\/(\d{1,2})\/(\d{4})[ ,à]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(line)
  if (!m) return null
  const t = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0)).getTime()
  return Number.isFinite(t) ? t : null
}

export type LastRun = { at: number | null; sent: boolean; auth: boolean; error: string | null }

/** La dernière synchro du journal (planifiée : launchd et cron écrivent dans sync.log) : envoi, connexion perdue, erreur. */
export function lastLoggedRun(text: string): LastRun | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^brain-sync — /.test(lines[i]) && !/simulation/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const block = lines.slice(start + 1).filter((l) => !/^\[\d{4}-\d\d-\d\dT[^\]]*\] hook : /.test(l))
  const error = block.find((l) => /^(Erreur :|Client non configuré|Impossible de joindre|Jeton refusé|Le cerveau a répondu)/.test(l.trim())) ?? null
  return {
    at: headerDate(lines[start]),
    sent: block.some((l) => /^Envoyé : /.test(l)),
    auth: block.some((l) => /n'est plus connecté|Clé API Anthropic refusée/.test(l)),
    error: error ? error.trim() : null,
  }
}

/** Erreurs des hooks (`[ISO] hook : message`) des dernières 24 h. */
export function recentHookErrors(text: string, now = Date.now()): { count: number; last: string | null } {
  let count = 0
  let last: string | null = null
  for (const l of text.split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] hook : (.*)$/.exec(l)
    if (!m || !(now - Date.parse(m[1]) < 24 * 3_600_000)) continue
    count++
    last = m[2]
  }
  return { count, last }
}

/** Lecture de l'état de capture dans GET /health (Screenpipe 0.4.x) : `vision_reason` d'abord, puis l'âge de la dernière image. */
export function captureDiagnosis(
  health: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): { status: Status; detail: string; reason: string } {
  const vision = typeof health.vision_reason === "string" ? health.vision_reason : ""
  const frame = typeof health.frame_status === "string" ? health.frame_status : ""
  const last = typeof health.last_frame_timestamp === "string" ? Date.parse(health.last_frame_timestamp) : NaN
  const age = Number.isFinite(last) ? ` (dernière image ${ago(now - last)})` : ""
  if (vision === "permission_denied") return { status: "fail", reason: "permission", detail: platform === "darwin" ? "macOS n'autorise pas screenpipe à enregistrer l'écran" : "le système refuse la capture d'écran à screenpipe" }
  if (vision === "disabled_by_setting" || vision === "screenshots_disabled_by_config") return { status: "warn", reason: "disabled", detail: "capture de l'écran désactivée dans les réglages de Screenpipe" }
  if (vision === "screenshots_disabled_by_power_profile") return { status: "info", reason: "power", detail: `capture en pause (économie d'énergie)${age}` }
  if (vision === "no_displays_expected") return { status: "info", reason: "no-display", detail: "aucun écran à capturer (écran verrouillé ou éteint ?)" }
  if (vision === "capture_stalled") return { status: "warn", reason: "stalled", detail: `capture bloquée${age}` }
  if (vision === "ocr_unavailable") return { status: "warn", reason: "ocr", detail: `lecture du texte à l'image indisponible${age}` }
  if (vision === "not_started" || frame === "not_started" || (!vision && !frame && !Number.isFinite(last))) {
    return { status: "warn", reason: "not-started", detail: platform === "darwin" ? "aucune image capturée pour l'instant (autorisation « Enregistrement de l'écran » pas encore accordée ?)" : "aucune image capturée pour l'instant" }
  }
  if (frame === "stale") return { status: "warn", reason: "stale", detail: `plus d'image récente${age} (écran verrouillé, ou capture arrêtée)` }
  return { status: "ok", reason: "ok", detail: `capture de l'écran active${age}` }
}

/** Commande d'installation à relancer (la config garde le jeton : l'adresse du cerveau suffit). */
export function reinstallCommand(url: string, platform: NodeJS.Platform = process.platform): string {
  const c = installCommands(url, "")
  // Les commandes du prompt d'installation, sans le jeton.
  return (platform === "win32" ? c.windows : c.posix).replace(/ --token $/, "").replace(/ --token ; exit/, "; exit")
}

type Ctx = {
  checks: Check[]
  me: string
  platform: NodeJS.Platform
  now: number
  cfg: Config | null
  /** Pour masquer ce qui viendrait d'un journal. */
  secrets: string[]
}

function add(ctx: Ctx, c: Check) {
  ctx.checks.push(c)
}

/** Ce qu'on peut afficher d'une ligne de journal : nos propres messages, masqués et tronqués. */
function clean(ctx: Ctx, s: string): string {
  return truncate(redactText(maskOwnSecrets(s, ctx.secrets).text), 160)
}

// ——— Poste ———

function checkNode(ctx: Ctx) {
  const v = process.versions.node
  const major = Number.parseInt(v, 10)
  const exec = process.execPath
  const reinstall = ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform), safe: true } : {}
  if (major < 20) {
    return add(ctx, { id: "node", group: "Poste", status: "fail", detail: `Node.js ${v} (${exec}) : il faut la version 20 ou plus`, fix: "Relance la commande d'installation : elle installe sa propre copie de Node.js.", ...reinstall })
  }
  let translated = false
  if (ctx.platform === "darwin" && process.arch === "x64") {
    const r = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", timeout: 5000 })
    translated = (r.stdout ?? "").trim() === "1"
  }
  if (translated) {
    return add(ctx, {
      id: "node",
      group: "Poste",
      status: "warn",
      detail: `Node.js ${v} x64 sous Rosetta sur un Mac Apple Silicon (${exec}) : Screenpipe tournerait en émulation`,
      fix: "Relance la commande d'installation : elle choisit Node.js pour Apple Silicon.",
      ...reinstall,
    })
  }
  if (VERSIONED_NODE_RE.test(exec)) {
    return add(ctx, {
      id: "node",
      group: "Poste",
      status: "warn",
      detail: `Node.js ${v} vient d'un gestionnaire de versions (${exec}) : sa prochaine mise à jour cassera hooks, MCP et synchro`,
      fix: "Relance la commande d'installation : elle installe une copie de Node.js propre au client.",
      ...reinstall,
    })
  }
  add(ctx, { id: "node", group: "Poste", status: "ok", detail: `Node.js ${v} (${exec})` })
}

function checkClientFiles(ctx: Ctx) {
  const script = selfScript()
  const installed = join(brainHome(), "brain.mjs")
  if (script.endsWith(".mjs") && !samePath(script, installed)) {
    add(ctx, {
      id: "client",
      group: "Poste",
      status: "warn",
      detail: `ce client (${script}) n'est pas celui du poste (${installed}) : hooks, MCP et synchro lanceront peut-être un autre fichier`,
      fix: "Utilise le raccourci du poste, ou relance la commande d'installation.",
      ...(ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform), safe: true } : {}),
    })
  }

  const shortcut = shortcutPath(ctx.platform)
  const reinstall = ctx.cfg ? { command: reinstallCommand(ctx.cfg.url, ctx.platform), safe: true } : {}
  if (!existsSync(shortcut)) {
    add(ctx, {
      id: "raccourci",
      group: "Poste",
      status: "warn",
      detail: `raccourci ${shortcut} absent : les commandes \`~/.company-brain/${basename(shortcut)} …\` ne marcheront pas`,
      fix: `Relance la commande d'installation (elle écrit le raccourci). En attendant : ${ctx.me} <commande>.`,
      ...reinstall,
    })
  } else {
    const p = probeOnce(shortcut, [])
    if (!p.ok) add(ctx, { id: "raccourci", group: "Poste", status: "fail", detail: `le raccourci ${shortcut} ne démarre pas (${p.error})`, fix: "Relance la commande d'installation.", ...reinstall })
    else {
      if (selfScript().endsWith(".mjs") && !samePath(p.script, selfScript()))
        add(ctx, { id: "raccourci", group: "Poste", status: "warn", detail: `le raccourci lance un autre client (${p.script})`, fix: "Relance la commande d'installation.", ...reinstall })
      else add(ctx, { id: "raccourci", group: "Poste", status: "ok", detail: `${shortcut} → Node.js ${p.node}` })
      // Les corrections passent par le raccourci : c'est lui que hooks, MCP et synchro doivent lancer.
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
        details.push(`dossier lisible par d'autres comptes du poste (droits ${mode.toString(8)})`)
        fix = "Restreins-le à ton compte."
        command = `chmod 700 ${home.includes(" ") ? `"${home}"` : home}`
      }
    } catch {
      // absent : la config le dira
    }
    if (process.getuid?.() === 0) {
      status = "warn"
      details.push(`client lancé en root${process.env.SUDO_USER ? ` avec sudo (pour ${process.env.SUDO_USER})` : ""} : config, hooks et synchro iraient au compte root`)
      fix ??= "Relance la commande sans sudo, depuis ta session."
    }
  }
  if (ctx.platform === "linux") {
    try {
      if (/microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"))) {
        status = status === "ok" ? "info" : status
        details.push("WSL : Screenpipe ne voit pas l'écran de Windows d'ici, et la synchro ne tourne que quand WSL est lancé ; mieux vaut installer le client sous Windows")
      }
    } catch {
      // pas Linux noyau Microsoft
    }
  }
  if (customHome()) details.push(`dossier personnalisé (COMPANY_BRAIN_HOME) : ${home}`)
  add(ctx, { id: "dossier", group: "Poste", status, detail: details.length ? details.join(" ; ") : home, ...(fix ? { fix } : {}), ...(command ? { command, safe: true } : {}) })
}

// ——— Cerveau ———

function checkConfig(ctx: Ctx): boolean {
  const file = paths.config()
  if (!existsSync(file)) {
    add(ctx, { id: "config", group: "Cerveau", status: "fail", detail: `${file} absent : le poste n'est pas branché au cerveau`, fix: "Colle ton prompt d'installation dans Claude Code (ou demande-en un nouveau à un admin, page Équipe et accès)." })
    return false
  }
  let raw: Partial<Config>
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // Pas le message de JSON.parse : il recopie un bout du fichier, jeton compris.
    add(ctx, { id: "config", group: "Cerveau", status: "fail", detail: `${file} illisible (JSON invalide)`, fix: "Recolle ton prompt d'installation dans Claude Code : il réécrit la config." })
    return false
  }
  if (!raw.url || !raw.token) {
    add(ctx, { id: "config", group: "Cerveau", status: "fail", detail: `${file} incomplet (${raw.url ? "jeton" : "adresse du cerveau"} manquant)`, fix: "Recolle ton prompt d'installation dans Claude Code." })
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
        group: "Cerveau",
        status: "warn",
        detail: `${file} lisible par d'autres comptes (droits ${m.toString(8)}) : il contient ton jeton`,
        fix: "Restreins-le à ton compte.",
        command: `chmod 600 ${file.includes(" ") ? `"${file}"` : file}`,
        safe: true,
      })
      return true
    }
    mode = ", droits 600"
  }
  add(ctx, { id: "config", group: "Cerveau", status: "ok", detail: `${file} (cerveau ${ctx.cfg.url}, jeton enregistré${mode})` })
  return true
}

async function checkBrain(ctx: Ctx) {
  const cfg = ctx.cfg!
  const api = new BrainApi(cfg.url, cfg.token, 8000)
  const [who, sha] = await Promise.allSettled([api.whoami(), fetchText(`${cfg.url}/brain.mjs.sha256`, 8000)])
  if (who.status === "fulfilled") {
    const w = who.value
    const cache = loadCache()
    const zones = w.access.readable.map((z) => zoneName(cache, z)).join(", ") || "aucune"
    add(ctx, { id: "connexion", group: "Cerveau", status: "ok", detail: `${w.profile.name} chez ${w.org.name}, zones lisibles : ${zones}${w.access.isAdmin ? " (admin)" : ""}` })
  } else {
    const err = who.reason as Error
    const status = err instanceof ApiError ? err.status : 0
    if (status === 401 || status === 403)
      add(ctx, {
        id: "connexion",
        group: "Cerveau",
        status: "fail",
        detail: `le cerveau refuse le jeton de ce poste (${status}) : révoqué, ou compte désactivé`,
        fix: "Demande à un admin un nouveau prompt d'installation (page Équipe et accès → Nouveau prompt) et colle-le dans Claude Code.",
      })
    else
      add(ctx, {
        id: "connexion",
        group: "Cerveau",
        status: "fail",
        detail: clean(ctx, err.message),
        fix:
          status === 0
            ? `Vérifie la connexion réseau (VPN, proxy d'entreprise : Node.js ignore le proxy système) et que ${cfg.url} s'ouvre dans le navigateur, puis relance doctor.`
            : "Le cerveau répond mais en erreur : réessaie dans quelques minutes, ou préviens l'admin.",
      })
  }

  // Le client du poste est-il celui que sert le cerveau ? (empreinte publiée à côté de /brain.mjs)
  const script = selfScript()
  if (!script.endsWith(".mjs")) return
  const want = sha.status === "fulfilled" ? /^([0-9a-f]{64})\b/.exec(sha.value.trim())?.[1] : undefined
  if (!want) return add(ctx, { id: "version", group: "Cerveau", status: "skip", detail: "le cerveau ne publie pas l'empreinte du client (brain.mjs.sha256)" })
  let have = ""
  try {
    have = createHash("sha256").update(readFileSync(script)).digest("hex")
  } catch {
    // illisible : différent
  }
  if (have === want) add(ctx, { id: "version", group: "Cerveau", status: "ok", detail: "client à jour (identique à celui du cerveau)" })
  else
    add(ctx, {
      id: "version",
      group: "Cerveau",
      status: "warn",
      detail: "le cerveau sert une version plus récente du client",
      fix: "Relance la commande d'installation pour la mettre à jour (configuration et historique gardés).",
      command: reinstallCommand(cfg.url, ctx.platform),
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
    return add(ctx, { id: "screenpipe", group: "Screenpipe", status: "info", detail: "source désactivée dans la config : brain-sync lit seulement les sessions Claude Code et Codex" })
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
        detail: `Screenpipe n'existe pas pour ${ctx.platform}-${process.arch} : brain-sync lit seulement les sessions Claude Code et Codex`,
      })
    }
    if (bin) {
      const loadError = screenpipeLoadError(bin)
      if (loadError) {
        return add(ctx, {
          id: "screenpipe",
          group: "Screenpipe",
          status: "fail",
          detail: `Screenpipe ne démarre pas sur ce poste (« ${truncate(loadError, 200)} »)`,
          fix: /GLIBC|shared object|shared librar/i.test(loadError)
            ? "Il lui faut glibc ≥ 2.39 (Ubuntu 24.04 ou plus récent) et les bibliothèques pipewire / pulseaudio du système : installe-les, puis relance setup."
            : /dyld|Library not loaded|Symbol not found/i.test(loadError)
              ? "Ce macOS est trop ancien pour Screenpipe (macOS 11 minimum)."
              : `Vérifie que ${bin} est exécutable (dossier personnel monté en noexec ?), puis relance setup.`,
        })
      }
    }
    return add(ctx, {
      id: "screenpipe",
      group: "Screenpipe",
      status: "fail",
      detail: `Screenpipe ne répond pas sur ${url}${bin ? " (installé par le client, arrêté)" : app ? ` (application ${app} fermée)` : " (pas installé)"}`,
      fix: "setup le (ré)installe et le relance, sans toucher au reste.",
      ...setup,
    })
  }
  const how = bin ? "CLI installé par le client" : app ? `application ${app}` : "lancé à part"
  const status = typeof health.status === "string" ? `, état « ${health.status} »` : ""
  add(ctx, { id: "screenpipe", group: "Screenpipe", status: "ok", detail: `répond sur ${url} (${how}${status})` })

  // Capture de l'écran (et accessibilité, sur Mac).
  const cap = captureDiagnosis(health, ctx.platform, ctx.now)
  const restart =
    bin && ctx.platform === "darwin"
      ? `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${SCREENPIPE_LAUNCHD_LABEL}`
      : bin && ctx.platform === "linux"
        ? "systemctl --user restart screenpipe"
        : undefined
  const capFix: Partial<Check> =
    cap.reason === "permission" || (cap.reason === "not-started" && ctx.platform === "darwin")
      ? { fix: "Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran → active « screenpipe ». setup ouvre le bon panneau et attend.", ...setup }
      : cap.reason === "stalled" && restart
        ? { fix: "Redémarre Screenpipe.", command: restart, safe: true }
        : cap.reason === "stalled"
          ? { fix: "Redémarre Screenpipe (quitte puis rouvre l'application)." }
          : cap.reason === "disabled"
            ? { fix: "Réactive la capture de l'écran dans les réglages de Screenpipe." }
            : {}
  const ui = health.ui_recorder && typeof health.ui_recorder === "object" ? (health.ui_recorder as { running?: unknown }) : null
  const audio = typeof health.audio_capture_mode === "string" ? health.audio_capture_mode : ""
  const extras = [audio ? `micro : ${audio === "disabled" ? "coupé" : audio === "meetings-only" ? "réunions seulement" : "toujours"}` : ""].filter(Boolean)
  add(ctx, { id: "capture", group: "Screenpipe", status: cap.status, detail: [cap.detail, ...extras].join(" ; "), ...capFix })
  if (ctx.platform === "darwin" && ui && ui.running === false && cap.status === "ok") {
    add(ctx, {
      id: "accessibilite",
      group: "Screenpipe",
      status: "warn",
      detail: "Accessibilité non accordée : le texte des terminaux est lu à l'image, moins proprement (facultatif)",
      fix: "Réglages Système → Confidentialité et sécurité → Accessibilité → active « screenpipe ». Rien à relancer.",
    })
  }

  // Jeton d'API local et données « parsed ».
  const p = await screenpipeProbe(url, token, 6000)
  if (p.auth === "token_required")
    add(ctx, {
      id: "screenpipe-jeton",
      group: "Screenpipe",
      status: "fail",
      detail: `Screenpipe demande un jeton d'API local${token ? " (celui de la config est refusé)" : " (aucun dans la config)"} : brain-sync ne lit rien`,
      fix: "setup lit le jeton de Screenpipe et l'enregistre.",
      ...setup,
    })
  else if (p.auth !== "ok") add(ctx, { id: "screenpipe-jeton", group: "Screenpipe", status: "warn", detail: `lecture des données impossible (${p.detail})` })
  else {
    add(ctx, { id: "screenpipe-jeton", group: "Screenpipe", status: "ok", detail: token ? "jeton d'API local accepté" : "lecture des données sans jeton (authentification désactivée)" })
    if (p.parsed === false)
      add(ctx, {
        id: "screenpipe-parsed",
        group: "Screenpipe",
        status: "warn",
        detail: "aucune conversation structurée (« parsed ») sur 24 h : parseur sémantique inactif, ou aucune app IA utilisée depuis",
        fix: bin
          ? "Le CLI installé par setup l'active déjà : utilise ChatGPT ou Claude quelques minutes, puis relance doctor."
          : "Dans l'application Screenpipe : Settings → Recording → app context « memory ». Puis utilise ChatGPT ou Claude quelques minutes.",
      })
    else if (p.parsed) add(ctx, { id: "screenpipe-parsed", group: "Screenpipe", status: "ok", detail: "conversations IA structurées captées sur 24 h" })
  }
  if (pipeInstalled()) add(ctx, { id: "pipe", group: "Screenpipe", status: "info", detail: "pipe Screenpipe « brain-sync » installé" })
}

// ——— Claude Code ———

function checkClaudeCode(ctx: Ctx) {
  const claude = findOnPath("claude")
  const setup = { command: `${ctx.me} setup`, safe: true }
  const version = claude ? claudeCodeVersion(claude) : null
  if (!claude)
    add(ctx, {
      id: "claude",
      group: "Claude Code",
      status: "warn",
      detail: "CLI `claude` introuvable dans le PATH : MCP non vérifiable, distillation sans Claude",
      fix: "Installe Claude Code (https://claude.com/claude-code), puis relance setup.",
      ...setup,
    })
  else add(ctx, { id: "claude", group: "Claude Code", status: "ok", detail: `Claude Code ${version ?? "(version inconnue)"} (${claude})` })

  // MCP company-brain : lu dans ~/.claude.json, puis lancé pour de vrai.
  const entry = readMcpEntry()
  if (entry === undefined) add(ctx, { id: "mcp", group: "Claude Code", status: "warn", detail: `${claudeJsonPath()} illisible : impossible de vérifier le MCP` })
  else if (entry === null) add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: "MCP company-brain absent de Claude Code : tes agents ne peuvent pas interroger le cerveau", fix: "setup le branche.", ...setup })
  else {
    const p = probeOnce(entry.command, entry.args.slice(0, 1))
    const other = p.ok ? mismatch(entry.command, entry.args[0] ?? "") : null
    if (!p.ok) add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: `le MCP company-brain ne démarre pas (${p.error})`, fix: "setup le rebranche sur le client actuel.", ...setup })
    else if (other || !mcpUpToDate(entry, reference.execPath, reference.script))
      add(ctx, { id: "mcp", group: "Claude Code", status: "fail", detail: `le MCP company-brain ${other ?? "n'a pas les bons arguments"}`, fix: "setup le rebranche sur le client actuel.", ...setup })
    else add(ctx, { id: "mcp", group: "Claude Code", status: "ok", detail: "MCP company-brain branché (portée utilisateur), il démarre" })
  }

  // Hooks : les trois, sur le client actuel, sans doublon, et lançables par le shell de Claude Code.
  const installHooks = { command: `${ctx.me} install-hooks`, safe: true }
  let hooks: Record<string, HookCommand[]>
  try {
    hooks = ourHooks()
  } catch (err) {
    return add(ctx, { id: "hooks", group: "Claude Code", status: "fail", detail: clean(ctx, (err as Error).message), fix: `Corrige ${paths.claudeSettings()} (JSON invalide), puis relance install-hooks.` })
  }
  const missing = HOOK_EVENTS.filter((e) => !hooks[e]?.length)
  const all = HOOK_EVENTS.flatMap((e) => hooks[e] ?? [])
  const dup = HOOK_EVENTS.filter((e) => (hooks[e]?.length ?? 0) > 1)
  if (missing.length === HOOK_EVENTS.length) {
    return add(ctx, { id: "hooks", group: "Claude Code", status: "fail", detail: "hooks Claude Code absents : le cerveau ne s'allume pas pendant tes sessions", fix: "install-hooks les ajoute (sans toucher à tes autres réglages).", ...installHooks })
  }
  const problems: string[] = []
  let status: Status = "ok"
  if (missing.length) {
    status = "fail"
    problems.push(`manquants : ${missing.join(", ")}`)
  }
  const pairs = new Map<string, { exec: string; script: string } | null>()
  for (const h of all) pairs.set(hookText(h), hookTarget(h))
  for (const [text, t] of pairs) {
    if (!t) {
      status = "fail"
      problems.push(`commande illisible (${truncate(text, 80)})`)
      continue
    }
    const p = probeOnce(t.exec, [t.script])
    const other = p.ok ? mismatch(t.exec, t.script) : null
    if (!p.ok) {
      status = "fail"
      problems.push(`ne démarre pas (${p.error})`)
    } else if (other) {
      status = "fail"
      problems.push(other)
    }
  }
  if (dup.length) {
    if (status === "ok") status = "warn"
    problems.push(`en double : ${dup.join(", ")}`)
  }
  if (ctx.platform === "win32" && all.some((h) => !Array.isArray(h.args)) && !gitBashInstalled()) {
    status = "fail"
    problems.push("sans Git Bash, Claude Code passe ces hooks à PowerShell, qui ne sait pas les lancer")
  }
  if (status === "ok") add(ctx, { id: "hooks", group: "Claude Code", status, detail: `SessionStart, UserPromptSubmit et Stop branchés (${paths.claudeSettings()})` })
  else add(ctx, { id: "hooks", group: "Claude Code", status, detail: `hooks : ${problems.join(" ; ")}`, fix: "install-hooks les remet d'aplomb (sans toucher à tes autres réglages).", ...installHooks })

  const errors = recentHookErrors(readTail(paths.log()), ctx.now)
  if (errors.count)
    add(ctx, {
      id: "hooks-erreurs",
      group: "Claude Code",
      status: "warn",
      detail: `${errors.count} erreur(s) des hooks sur 24 h, la dernière : « ${clean(ctx, errors.last ?? "")} »`,
      fix: "Sans gravité pour Claude Code (les hooks ne le bloquent jamais) ; si ça dure, regarde la connexion au cerveau ci-dessus.",
    })
}

/** Node.js et script lancés par un hook, quelle que soit sa forme. */
function hookTarget(h: HookCommand): { exec: string; script: string } | null {
  if (Array.isArray(h.args) && typeof h.command === "string" && h.args.length) return { exec: h.command, script: String(h.args[0]) }
  const m = /^\s*"([^"]+)"\s+"([^"]+)"\s+hook\b/.exec(typeof h.command === "string" ? h.command : "")
  return m ? { exec: m[1], script: m[2] } : null
}

// ——— Synchro ———

function checkSync(ctx: Ctx) {
  const setup = { command: `${ctx.me} setup`, safe: true }
  const target = scheduleTarget(ctx.platform)
  const how = ctx.platform === "darwin" ? "launchd" : ctx.platform === "win32" ? "tâche Windows CompanyBrainSync" : "crontab"
  if (target === null)
    add(ctx, {
      id: "planification",
      group: "Synchro",
      status: "fail",
      detail: "synchro automatique non planifiée : rien ne part au cerveau tout seul",
      fix: "setup la planifie (toutes les 15 min, à partir de maintenant : aucun historique n'est envoyé).",
      ...setup,
    })
  else if (target === undefined) add(ctx, { id: "planification", group: "Synchro", status: "warn", detail: `synchro planifiée (${how}), mais sa commande est illisible` })
  else {
    const p = probeOnce(target.execPath, [target.script])
    const other = p.ok ? mismatch(target.execPath, target.script) : null
    if (!p.ok) add(ctx, { id: "planification", group: "Synchro", status: "fail", detail: `la synchro planifiée (${how}) ne démarre pas (${p.error})`, fix: "setup la rebranche sur le client actuel, sans rien sauter de ce qui attend.", ...setup })
    else if (other)
      add(ctx, { id: "planification", group: "Synchro", status: "fail", detail: `la synchro planifiée (${how}) ${other}`, fix: "setup la rebranche sur le client actuel, sans rien sauter de ce qui attend.", ...setup })
    else if (target.home && !samePath(target.home, brainHome()))
      add(ctx, { id: "planification", group: "Synchro", status: "fail", detail: `la synchro planifiée utilise un autre dossier (${target.home})`, fix: "setup la rebranche sur ce dossier.", ...setup })
    else add(ctx, { id: "planification", group: "Synchro", status: "ok", detail: `toutes les 15 min (${how})` })
  }

  const state = loadState()
  const last = state.last_sync
  const lastAt = last ? Date.parse(last.at) : NaN
  const run = lastLoggedRun(readTail(paths.log()))
  if (Number.isFinite(lastAt)) {
    const zones = Object.entries(last!.zones ?? {})
      .map(([z, n]) => `${zoneName(loadCache(), z)} ${n}`)
      .join(", ")
    const detail = `dernière synchro ${ago(ctx.now - lastAt)} : ${last!.items_sent} connaissance(s) envoyée(s)${zones ? ` (${zones})` : ""}, distillation ${DISTILLER_LABELS[last!.distiller as keyof typeof DISTILLER_LABELS] ?? last!.distiller}`
    const old = ctx.now - lastAt > 24 * 3_600_000
    add(ctx, { id: "derniere-synchro", group: "Synchro", status: old ? "warn" : "ok", detail: old ? `${detail} (poste éteint ou en veille ?)` : detail })
  } else {
    const since = state.baseline_at ? Date.parse(state.baseline_at) : NaN
    add(ctx, {
      id: "derniere-synchro",
      group: "Synchro",
      status: Number.isFinite(since) && ctx.now - since > 3_600_000 && target ? "warn" : "info",
      detail: Number.isFinite(since) ? `aucune synchro terminée depuis la mise en route (${ago(ctx.now - since)})` : "aucune synchro encore",
    })
  }
  // La dernière synchro du journal a échoué avant d'envoyer (cerveau injoignable, config…) : last_sync ne le dit pas.
  if (run?.error && !run.sent && (run.at === null || !Number.isFinite(lastAt) || run.at > lastAt)) {
    add(ctx, {
      id: "journal",
      group: "Synchro",
      status: "fail",
      detail: `la dernière synchro planifiée${run.at ? ` (${ago(ctx.now - run.at)})` : ""} a échoué : « ${clean(ctx, run.error)} »`,
      fix: `Corrige le point KO correspondant ci-dessus ; journal complet : ${paths.log()}.`,
    })
  }

  const lock = paths.lock()
  if (existsSync(lock)) {
    const info = readJson<{ pid?: number }>(lock) ?? {}
    let age = 0
    try {
      age = ctx.now - statSync(lock).mtimeMs
    } catch {
      // retiré entre-temps
    }
    const alive = typeof info.pid === "number" && pidAlive(info.pid) && age < LOCK_STALE_MS
    add(ctx, {
      id: "verrou",
      group: "Synchro",
      status: alive ? "info" : "warn",
      detail: alive ? `synchro en cours (processus ${info.pid}, ${ago(age)})` : `verrou orphelin (${ago(age)}) : la prochaine synchro le reprendra toute seule`,
    })
  }

  const failures = Object.keys(state.distill_failures ?? {}).length
  if (failures)
    add(ctx, {
      id: "en-attente",
      group: "Synchro",
      status: "info",
      detail: `${failures} conversation(s) que Claude n'a pas encore su distiller : retentées à chaque synchro (abandon après 3 échecs dus à leur contenu)`,
    })
  const preview = readJson<{ created_at?: string; items?: unknown[] }>(paths.preview())
  if (preview?.created_at && ctx.now - Date.parse(preview.created_at) < PREVIEW_TTL_MS)
    add(ctx, {
      id: "simulation",
      group: "Synchro",
      status: "info",
      detail: `simulation relue ${ago(ctx.now - Date.parse(preview.created_at))} (${preview.items?.length ?? 0} connaissance(s)), pas encore envoyée`,
      fix: "Elle ne part qu'avec ton accord explicite.",
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
      detail: `${DISTILLER_LABELS[d.kind]} — ${d.reason} : connaissances moins fines`,
      fix: "Installe Claude Code et connecte-toi (`claude`), ou donne une clé API avec init --anthropic-key.",
    })
  else add(ctx, { id: "distillation", group: "Distillation", status: "ok", detail: `${DISTILLER_LABELS[d.kind]} — ${d.reason}` })

  // Synchro planifiée : le PATH relevé à l'installation doit mener à `claude`, et Claude doit être connecté.
  if (!apiKey(cfg) && cfg.use_claude_cli !== false && cfg.schedule_env?.PATH !== undefined && d.kind === "claude-cli" && !findOnPath("claude", cfg.schedule_env.PATH)) {
    add(ctx, {
      id: "distillation-planifiee",
      group: "Distillation",
      status: "warn",
      detail: "la synchro planifiée ne trouve pas `claude` dans son PATH : elle distillerait sans LLM",
      fix: "setup relève le PATH actuel pour la synchro planifiée.",
      command: `${ctx.me} setup`,
      safe: true,
    })
  }
  const run = lastLoggedRun(readTail(paths.log()))
  if (run?.auth)
    add(ctx, {
      id: "claude-connexion",
      group: "Distillation",
      status: "fail",
      detail: `à la dernière synchro${run.at ? ` (${ago(ctx.now - run.at)})` : ""}, Claude n'était plus connecté : rien n'a été distillé (rien n'est perdu, tout repart une fois reconnecté)`,
      fix: "Lance `claude setup-token` dans un terminal (connexion dans le navigateur), puis enregistre le jeton affiché.",
      command: `${ctx.me} init --claude-token <jeton>`,
      safe: false,
    })
  else if (cfg.claude_oauth_token) add(ctx, { id: "claude-connexion", group: "Distillation", status: "ok", detail: "jeton Claude Code longue durée enregistré pour la synchro planifiée" })
}

// ——— Ensemble ———

export async function runDoctor(opts: { version: string; platform?: NodeJS.Platform; now?: number } = { version: "?" }): Promise<DoctorReport> {
  probes.clear()
  reference = { execPath: process.execPath, script: selfScript() }
  const ctx: Ctx = { checks: [], me: selfCommand(opts.platform), platform: opts.platform ?? process.platform, now: opts.now ?? Date.now(), cfg: null, secrets: [] }
  checkNode(ctx)
  const configured = checkConfig(ctx)
  checkClientFiles(ctx)
  // Réseau en parallèle (cerveau et Screenpipe), puis ce qui lance des processus.
  const network: Promise<void>[] = [checkScreenpipe(ctx)]
  if (configured) network.unshift(checkBrain(ctx))
  else {
    for (const id of ["connexion", "version"]) add(ctx, { id, group: "Cerveau", status: "skip", detail: "sans config" })
  }
  await Promise.all(network)
  checkClaudeCode(ctx)
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
  const out = [`NOS Brainer — diagnostic du poste (client ${r.version}, ${r.platform}-${r.arch}, Node.js ${r.node})`]
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
  out.push("", `Bilan : ${s.ok} OK, ${s.warn} à surveiller, ${s.fail} KO${s.info ? `, ${s.info} pour info` : ""}${s.skip ? `, ${s.skip} non vérifié(s)` : ""}.`)
  if (r.next && r.next.status === "fail") out.push(`À régler d'abord : ${r.next.id} — ${r.next.command ? `\`${r.next.command}\`` : r.next.fix}`)
  else if (!s.fail) out.push(s.warn ? "Rien de bloquant." : "Tout est en ordre.")
  return out.join("\n")
}

export async function cmdDoctor(opts: { version: string; json?: boolean }, log: Log = console.log): Promise<number> {
  const report = await runDoctor({ version: opts.version })
  log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report))
  return report.exit_code
}
