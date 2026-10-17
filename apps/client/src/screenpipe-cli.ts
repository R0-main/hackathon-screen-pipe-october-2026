// Screenpipe en CLI, géré par le client : installé dans ~/.company-brain/screenpipe (chemin stable, sans droits admin),
// lancé en service (launchd sur macOS, systemd --user sous Linux) ou, à défaut, en arrière-plan.
// Pourquoi un chemin stable : le service lance ce binaire précis, et macOS rattache les autorisations (Enregistrement de
// l'écran, Accessibilité) à ce chemin. Un binaire dans le cache de npx changerait de chemin à chaque mise à jour.

import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { brainHome, loadState, UserError } from "./config"
import { findOnPath, spawnTarget } from "./distill"

type Log = (s: string) => void

/** Version du CLI installée par `setup` (options vérifiées sur celle-ci : service install --record-args, --app-context). */
export const SCREENPIPE_VERSION = "0.4.52"
/** Libellé du LaunchAgent écrit par `screenpipe service install` sur macOS. */
export const SCREENPIPE_LAUNCHD_LABEL = "com.screenpipe.agent"

/**
 * Paquets npm des binaires (dépendances optionnelles du paquet `screenpipe`). Windows ARM64 : Screenpipe ne publie que
 * le binaire x64, que Windows 11 exécute en émulation (installé avec `--cpu=x64`).
 */
const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@screenpipe/cli-darwin-arm64",
  "darwin-x64": "@screenpipe/cli-darwin-x64",
  "linux-x64": "@screenpipe/cli-linux-x64",
  "win32-x64": "@screenpipe/cli-win32-x64",
  "win32-arm64": "@screenpipe/cli-win32-x64",
}

/** Postes sans binaire Screenpipe publié : setup branche quand même le reste (sessions Claude Code et Codex). */
export function screenpipeSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return Boolean(PLATFORM_PACKAGES[`${platform}-${arch}`])
}

/** Ni télémétrie de Screenpipe à l'installation (nom du poste envoyé à PostHog), ni pendant nos appels au CLI. */
export const NO_TELEMETRY_ENV = { DO_NOT_TRACK: "1", SCREENPIPE_DISABLE_TELEMETRY: "1" }

export function screenpipePrefix(home = brainHome()): string {
  return join(home, "screenpipe")
}

/** Chemin du binaire natif une fois installé ; null si Screenpipe ne publie pas de binaire pour ce poste. */
export function screenpipeBinPath(prefix = screenpipePrefix(), platform: string = process.platform, arch: string = process.arch): string | null {
  const pkg = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!pkg) return null
  return join(prefix, "node_modules", ...pkg.split("/"), "bin", platform === "win32" ? "screenpipe.exe" : "screenpipe")
}

/**
 * Le binaire démarre-t-il ? Sous Linux il lui faut glibc ≥ 2.39 et des bibliothèques système (pipewire, pulse…) ; sur un
 * Mac trop ancien, dyld refuse. On ne lit que ces erreurs de chargement : une option inconnue ne dit rien du binaire.
 */
export function screenpipeLoadError(bin: string): string | null {
  const r = runCommand(bin, ["--version"], 15_000, NO_TELEMETRY_ENV)
  if (r.ok) return null
  const text = `${r.stderr}\n${r.stdout}`
  const line = text.split(/\r?\n/).find((l) => LOAD_ERROR_RE.test(l))
  // Le chemin du binaire (très long, sous ~/.company-brain/screenpipe/node_modules/…) n'apprend rien : seule l'erreur compte.
  return line ? line.split(bin).join("screenpipe").trim().slice(0, 300) : null
}

const LOAD_ERROR_RE = /error while loading shared libraries|cannot open shared object|GLIBC_\d|GLIBCXX_\d|dyld\b|Library not loaded|Symbol not found|Exec format error|bad CPU type|ENOEXEC|EACCES/i

/** Le binaire installé par le client, s'il existe. */
export function installedScreenpipeBin(): string | null {
  const bin = screenpipeBinPath()
  return bin && existsSync(bin) ? bin : null
}

/**
 * CLI Screenpipe déjà installé sur le poste hors du client (Homebrew, `npm install -g`, script officiel) : setup s'en
 * sert plutôt que d'en installer un second. Cherché dans le PATH et les dossiers habituels (setup peut tourner avec un
 * PATH réduit). Sous Windows, seulement un .exe (un raccourci .cmd ne se lance pas en arrière-plan sans shell).
 */
export function externalScreenpipeBin(pathEnv = process.env.PATH ?? "", platform: string = process.platform): string | null {
  const usual = platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")]
  const bin = findOnPath("screenpipe", [pathEnv, ...usual].filter(Boolean).join(delimiter))
  if (!bin || bin.startsWith(screenpipePrefix())) return null
  return platform === "win32" && !/\.exe$/i.test(bin) ? null : bin
}

/** Le binaire que setup fait tourner : le sien, sinon le CLI installé à part qu'il a lancé (noté dans l'état). */
export function managedScreenpipeBin(): string | null {
  const own = installedScreenpipeBin()
  if (own) return own
  const other = loadState().screenpipe_bin
  return other && existsSync(other) ? other : null
}

/**
 * Options d'enregistrement : pas de micro par défaut (une autorisation macOS de moins, rien d'audio à expliquer), contexte
 * d'app « memory » (les données `parsed` que lit brain-sync), et vidéos / captures effacées après 14 jours (le texte reste
 * cherchable ; ~19 Go en deux semaines sinon). Masquage des données perso et navigation privée ignorée : actifs par défaut.
 */
export function recordArgs(opts: { audio?: boolean } = {}): string[] {
  return [...(opts.audio ? [] : ["--disable-audio"]), "--app-context", "memory", "--retention-days", "14"]
}

/** `screenpipe auth token` (jeton du type « sp-1a2b3c4d ») peut écrire des journaux avant : on garde la dernière ligne sans espace. */
export function parseAuthToken(out: string): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const l of lines.reverse()) if (/^[A-Za-z0-9._~+/=-]{8,}$/.test(l)) return l
  return null
}

export function runCommand(cmd: string, args: string[], timeoutMs = 30_000, extraEnv: Record<string, string> = {}) {
  // Windows : npm.cmd / npx.cmd ne se lancent que via le shell, qui ne cite rien lui-même (chemins avec espaces).
  const t = spawnTarget(cmd, args)
  // npm et npx sont des scripts « #!/usr/bin/env node » : le node qui exécute ce client passe en tête du PATH.
  const env = { ...process.env, ...extraEnv, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) }
  const r = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: timeoutMs, shell: t.shell, env, windowsHide: true })
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error?.message ?? "") }
}

/** Dernières lignes utiles d'une sortie, pour un message d'erreur lisible. */
export function tail(text: string, lines = 3): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(" / ").slice(0, 400) || "sans détail"
}

function npmPath(): string | null {
  const local = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm")
  return existsSync(local) ? local : findOnPath("npm")
}

/** Installe le CLI (paquet npm officiel) s'il n'est pas déjà là ; renvoie le chemin du binaire. */
export function installScreenpipeCli(log: Log = console.log): string {
  const bin = screenpipeBinPath()
  if (!bin) {
    throw new UserError(
      `Screenpipe ne publie pas de CLI pour ${process.platform}-${process.arch} : installe l'application Screenpipe (https://screenpi.pe), lance-la, puis relance setup.`,
    )
  }
  if (existsSync(bin)) return bin
  const npm = npmPath()
  if (!npm) throw new UserError("npm introuvable (il est livré avec Node.js) : réinstalle Node.js ≥ 20, puis relance setup.")
  const prefix = screenpipePrefix()
  mkdirSync(prefix, { recursive: true })
  log(`Installation de Screenpipe ${SCREENPIPE_VERSION} (paquet npm officiel « screenpipe ») dans ${prefix}… une à deux minutes.`)
  // --ignore-scripts : le script post-installation du paquet télécharge un ffmpeg non figé depuis un site tiers (macOS),
  // lance `sudo apt-get` (Linux) et envoie de la télémétrie. Screenpipe installe lui-même ffmpeg au premier lancement.
  const cpu = process.platform === "win32" && process.arch === "arm64" ? ["--cpu=x64", "--os=win32"] : []
  const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...cpu, `screenpipe@${SCREENPIPE_VERSION}`]
  const r = runCommand(npm, args, 10 * 60_000, NO_TELEMETRY_ENV)
  if (!r.ok || !existsSync(bin)) {
    throw new UserError(`Échec de l'installation de Screenpipe (${tail(r.stderr || r.stdout)}). Autre voie : l'application Screenpipe (https://screenpi.pe), puis relance setup.`)
  }
  if (process.platform !== "win32") chmodSync(bin, 0o755)
  // Ce que faisait le script post-installation qui compte : macOS ne doit pas bloquer le binaire téléchargé.
  if (process.platform === "darwin") runCommand("xattr", ["-d", "com.apple.quarantine", bin], 10_000)
  return bin
}

/**
 * Lance l'enregistrement : en service si possible (démarre avec la session, relancé après une panne), sinon en
 * arrière-plan. Relancer `service install` applique de nouvelles options et redémarre le service.
 */
export function startScreenpipe(bin: string, opts: { audio?: boolean }, log: Log = console.log): "service" | "background" {
  const args = recordArgs(opts)
  if (process.platform !== "win32") {
    const r = runCommand(bin, ["service", "install", `--record-args=${args.join(" ")}`], 60_000)
    if (r.ok) {
      log(`Screenpipe tourne en service (${process.platform === "darwin" ? "launchd" : "systemd"}) : il démarre avec ta session et redémarre tout seul.`)
      return "service"
    }
    log(`Service Screenpipe impossible (${tail(r.stderr || r.stdout, 1)}) : lancement en arrière-plan à la place.`)
  }
  const logFile = join(brainHome(), "screenpipe.log")
  mkdirSync(brainHome(), { recursive: true })
  const fd = openSync(logFile, "a")
  const child = spawn(bin, ["record", ...args], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true })
  child.on("error", () => {})
  child.unref()
  if (child.pid) writeFileSync(pidFile(), String(child.pid))
  log(`Screenpipe tourne en arrière-plan (journal : ${logFile}). Après un redémarrage du poste, relance \`setup\`.`)
  return "background"
}

/** PID de l'enregistrement lancé en arrière-plan (sans service), pour pouvoir l'arrêter à la désinstallation. */
function pidFile(): string {
  return join(brainHome(), "screenpipe.pid")
}

/** macOS : redémarre le service (une autorisation fraîchement accordée est parfois prise en compte au redémarrage seulement). */
export function restartScreenpipeService(): boolean {
  if (process.platform !== "darwin") return false
  if (!existsSync(join(homedir(), "Library", "LaunchAgents", `${SCREENPIPE_LAUNCHD_LABEL}.plist`))) return false
  return runCommand("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${SCREENPIPE_LAUNCHD_LABEL}`], 15_000).ok
}

/** Jeton d'API local (obligatoire pour /search) ; via notre binaire, sinon via npx (application Screenpipe). */
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

/** Arrête Screenpipe s'il a été lancé par `setup` (service ou arrière-plan) ; les données de ~/.screenpipe restent. */
export function uninstallScreenpipeService(log: Log = console.log) {
  const bin = managedScreenpipeBin()
  if (!bin) return log("Screenpipe : pas installé par le client, rien à arrêter (une application Screenpipe reste à gérer à part).")
  const pid = Number.parseInt(existsSync(pidFile()) ? readFileSync(pidFile(), "utf8") : "", 10)
  if (pid > 0) {
    try {
      process.kill(pid)
      log(`Screenpipe arrêté (processus ${pid}).`)
    } catch {
      // déjà arrêté
    }
    rmSync(pidFile(), { force: true })
  }
  if (process.platform !== "win32") {
    const r = runCommand(bin, ["service", "uninstall"], 30_000)
    if (r.ok && !/none installed/i.test(r.stdout)) log("Service Screenpipe arrêté et retiré.")
  }
  log("Les enregistrements de Screenpipe restent dans ~/.screenpipe (à supprimer à la main si tu veux tout effacer).")
}
