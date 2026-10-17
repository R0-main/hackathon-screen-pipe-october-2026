// `brain.mjs setup` : tout le branchement du poste en une commande, pour que le prompt d'installation ne demande qu'une
// autorisation dans Claude Code. Cerveau (config) → Screenpipe (installé et lancé s'il ne tourne pas) → autorisations
// macOS (réglages ouverts au bon endroit, reprise automatique dès qu'elles sont accordées) → MCP + hooks → synchro
// planifiée (activité à venir seulement) → néon (hello) → le cerveau s'ouvre dans le navigateur, déjà connecté.
// Idempotent : `setup` sans paramètres reprend là où ça s'est arrêté.

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

/** Code de sortie quand tout est branché sauf l'autorisation d'enregistrer l'écran : relancer `setup` une fois cochée. */
export const EXIT_PERMISSIONS_PENDING = 3
/** Code de sortie quand tout est branché sauf Screenpipe (pas de binaire pour ce poste, ou il ne démarre pas) : `doctor` dit pourquoi. */
export const EXIT_NO_SCREENPIPE = 6
export const DEFAULT_WAIT_S = 300

export const MACOS_PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

export type CaptureState = {
  /** L'API locale de Screenpipe répond. */
  up: boolean
  /** Au moins une image capturée : l'autorisation « Enregistrement de l'écran » est accordée. */
  screen: boolean
  /** Lecture de l'accessibilité active (texte propre des fenêtres) ; null si Screenpipe ne le dit pas. */
  accessibility: boolean | null
  detail?: string
}

/** Lit l'état de capture dans la réponse de GET /health (qui répond 200 même quand la capture n'a pas démarré). */
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
  /** Binaire à ajouter à la main dans les réglages s'il n'apparaît pas dans la liste. */
  bin?: string | null
  open?: (url: string) => void
  restart?: () => boolean
  log?: Log
}

/**
 * Attend que Screenpipe capture vraiment. Sur macOS, ouvre le bon panneau des Réglages et reprend tout seul dès que
 * l'autorisation est accordée : personne n'a à revenir au terminal pour dire « c'est fait ».
 * Écran : obligatoire. Accessibilité : recommandée (texte propre des terminaux au lieu de l'OCR), sans bloquer.
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
    // Pas d'autorisation à demander : on laisse un peu de temps à la première capture.
    st = await waitUntil(o.url, o.token, (s) => s.screen, Math.min(deadline, Date.now() + 20_000), poll)
    if (!st.screen) log(`Screenpipe tourne mais n'a encore rien capturé${st.detail ? ` (${st.detail})` : ""}${platform === "linux" ? " ; sous Wayland, accepte le partage d'écran s'il est proposé" : ""}.`)
    return st
  }

  if (!st.screen) {
    log("→ Autorisation 1/2 : Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran et de l'audio système → active « screenpipe ».")
    log("  Si macOS propose « Quitter et rouvrir », choisis « Plus tard » : Screenpipe reprend tout seul.")
    if (o.bin) {
      const copied = copyToClipboard(o.bin)
      log(`  Si « screenpipe » n'est pas dans la liste : bouton « + », puis ⌘⇧G et colle ce chemin${copied ? " (déjà copié dans le presse-papiers)" : ""} : ${o.bin}`)
    }
    open(MACOS_PANES.screen)
    log(`  En attente de l'autorisation (jusqu'à ${Math.round(o.waitMs / 1000)} s)…`)
    st = await waitUntil(o.url, o.token, (s) => s.screen, deadline, poll, (left) => log(`  … toujours en attente de l'Enregistrement de l'écran (${left} s restantes).`))
    if (!st.screen) return st
    log("✓ Enregistrement de l'écran autorisé : la capture a démarré.")
  }

  if (st.accessibility === false) {
    log("→ Autorisation 2/2 (recommandée) : Réglages Système → Confidentialité et sécurité → Accessibilité → active « screenpipe » (même méthode avec « + » s'il manque).")
    log("  Elle permet de lire le texte des fenêtres (terminal, Claude) proprement au lieu de le déchiffrer à l'image.")
    open(MACOS_PANES.accessibility)
    const axDeadline = Date.now() + Math.min(o.waitMs, 120_000)
    let restarted = false
    st = await waitUntil(o.url, o.token, (s) => s.accessibility !== false && s.up, axDeadline, poll, () => {
      // Une autorisation accordée à un service déjà lancé n'est parfois prise en compte qu'au redémarrage.
      if (!restarted && o.restart) restarted = o.restart()
    })
    if (st.accessibility === false) {
      log("  Accessibilité pas encore accordée : la capture marche quand même. Coche « screenpipe » dans Accessibilité quand tu veux, rien d'autre à relancer.")
    } else if (st.accessibility) {
      log("✓ Accessibilité autorisée.")
    }
  }
  return st
}

/**
 * MCP company-brain dans Claude Code (portée utilisateur). Déjà enregistré mais sur un autre Node.js ou un autre script
 * (réinstallation, Node mis à jour) : remplacé, sinon Claude Code lancerait un serveur qui n'existe plus.
 */
export function ensureMcp(log: Log = console.log): boolean {
  const manual = mcpAddCommand()
  const claude = findOnPath("claude")
  if (!claude) {
    log(`MCP : CLI \`claude\` introuvable dans le PATH. À lancer à la main : ${manual}`)
    return false
  }
  const current = readMcpEntry()
  if (current && mcpUpToDate(current)) {
    log(`MCP ${MCP_NAME} : déjà branché dans Claude Code.`)
    return true
  }
  // Fichier de Claude Code illisible : on s'en remet à la CLI pour savoir s'il est là.
  if (current === undefined && runCommand(claude, ["mcp", "get", MCP_NAME], 30_000).ok) {
    log(`MCP ${MCP_NAME} : déjà branché dans Claude Code.`)
    return true
  }
  if (current) runCommand(claude, ["mcp", "remove", MCP_NAME, "--scope", "user"], 30_000)
  const r = runCommand(claude, ["mcp", "add", MCP_NAME, "--scope", "user", "--", process.execPath, ...mcpArgs()], 30_000)
  log(
    r.ok
      ? `MCP ${MCP_NAME} ${current ? "mis à jour (il pointait vers un ancien chemin)" : "branché dans Claude Code"} : actif dès la prochaine session.`
      : `MCP : échec (${r.stderr.trim().slice(0, 200)}). À lancer à la main : ${manual}`,
  )
  return r.ok
}

/**
 * MCP : le serveur de chaque entreprise du poste (endpoint du cerveau, HTTP), branché dans Claude Code et Codex sous
 * « nos-brainer-<entreprise> » ; le serveur du poste (stdio) ferait alors doublon avec celui de la première entreprise
 * et il est retiré. Cerveau à certificat privé (inconnu de Claude Code et Codex), ou endpoint injoignable : le serveur
 * du poste, comme avant.
 */
export async function ensureMcpServers(log: Log = console.log): Promise<void> {
  const cfg = requireConfig()
  const list = cfg.ca_file ? null : await companiesWithIds(cfg)
  const specs = list ? mcpSpecs(list) : null
  const down = specs ? (await Promise.all(specs.map(async (s) => ({ s, err: await probeMcp(s.url) })))).find((p) => p.err) : undefined
  if (!specs || down) {
    log(
      cfg.ca_file
        ? "MCP : cerveau à certificat privé, que Claude Code et Codex ne connaissent pas : serveur MCP du poste (company-brain)."
        : `MCP : ${down ? `le serveur MCP de ${down.s.label} ne répond pas (${down.err})` : "ce cerveau ne donne pas l'identifiant de l'entreprise"} : serveur MCP du poste (company-brain) à la place.`,
    )
    ensureMcp(log)
    return
  }
  if (!registerMcpServers(specs, log)) return
  const legacy = readMcpEntry()
  const claude = findOnPath("claude")
  if (legacy && claude && runCommand(claude, ["mcp", "remove", MCP_NAME, "--scope", "user"], 30_000).ok) {
    log(`MCP ${MCP_NAME} (serveur du poste) retiré : chaque entreprise a maintenant son propre serveur MCP.`)
  }
  log("Les serveurs MCP sont actifs dès la prochaine session (Claude Code : /mcp ; Codex : codex mcp list).")
}

/** Ouvre le cerveau, déjà connecté grâce à un lien de connexion à usage court ; à défaut, la page de connexion. */
async function openBrain(cfg: Pick<Config, "url" | "token">, noOpen: boolean, log: Log) {
  if (noOpen) return log(`Le cerveau : ${cfg.url}`)
  let target = `${cfg.url}/login`
  try {
    const { path } = await new BrainApi(cfg.url, cfg.token, 8000).loginLink()
    if (path.startsWith("/")) target = `${cfg.url}${path}`
  } catch {
    // cerveau plus ancien, sans lien de connexion : page de connexion avec le jeton
  }
  log(openUrl(target) ? `Le cerveau s'ouvre dans ton navigateur : ${cfg.url}` : `Ouvre le cerveau dans ton navigateur : ${cfg.url}`)
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
  if (["oui", "on", "true", "1", "yes"].includes(s)) return true
  if (["non", "off", "false", "0", "no"].includes(s)) return false
  throw new UserError(`--${flag} : « oui » ou « non » (reçu « ${v} »).`)
}

type ScreenpipeResult = { how: "existing" | "app" | "service" | "background"; bin: string | null }

/** Screenpipe déjà lancé (CLI ou application) : on le garde. Sinon l'application si elle est là, sinon le CLI en service. */
async function ensureScreenpipe(cfg: Config, audio: boolean | undefined, log: Log): Promise<ScreenpipeResult> {
  let bin = installedScreenpipeBin()
  const running = (await readHealth(cfg.screenpipe_url, cfg.screenpipe_token)) !== null
  if (running && !(audio !== undefined && bin)) {
    log(`Screenpipe tourne déjà (${cfg.screenpipe_url}) : on le garde tel quel.`)
    return { how: "existing", bin }
  }
  if (!running && !bin) {
    const app = desktopApp()
    if (app) {
      log(`Application Screenpipe trouvée (${app}) : lancement.`)
      runCommand("open", ["-a", app], 15_000)
      if (await waitUp(cfg.screenpipe_url, cfg.screenpipe_token, 60_000)) return { how: "app", bin: null }
      log("L'application ne répond pas : installation du CLI à la place.")
    }
  }
  if (!bin && !screenpipeSupported()) {
    throw new UserError(`Screenpipe ne publie pas de version pour ${process.platform}-${process.arch} (macOS, Linux x64 et Windows x64 seulement).`)
  }
  bin = bin ?? installScreenpipeCli(log)
  const loadError = screenpipeLoadError(bin)
  if (loadError) {
    const why = /GLIBC|shared object|shared librar/i.test(loadError)
      ? " : il lui faut glibc ≥ 2.39 (Ubuntu 24.04 ou plus récent) et les bibliothèques pipewire / pulseaudio du système"
      : /dyld|Library not loaded|Symbol not found/i.test(loadError)
        ? " : il lui faut macOS 11 ou plus récent"
        : ""
    throw new UserError(`Screenpipe ne démarre pas sur ce poste (« ${loadError} »)${why}.`)
  }
  const how = startScreenpipe(bin, { audio }, log)
  if (!(await waitUp(cfg.screenpipe_url, cfg.screenpipe_token, process.platform === "win32" ? 180_000 : 60_000))) {
    throw new UserError(`Screenpipe ne répond pas sur ${cfg.screenpipe_url} (journal : ${join(brainHome(), "screenpipe.log")}, ou \`"${bin}" service status\`).`)
  }
  if (audio) log("Micro activé : les réunions seront transcrites (macOS demandera aussi l'autorisation Micro).")
  else log("Micro coupé : seul l'écran est capté (relance `setup --audio oui` pour transcrire aussi les réunions).")
  return { how, bin }
}

/** Jeton d'API local de Screenpipe : lu et enregistré s'il manque ou ne marche plus. */
async function ensureScreenpipeToken(cfg: Config, bin: string | null, log: Log): Promise<Config> {
  let probe = await screenpipeProbe(cfg.screenpipe_url, cfg.screenpipe_token)
  if (probe.auth === "token_required") {
    const token = readScreenpipeToken(bin)
    if (token) {
      saveConfig({ ...loadPartialConfig(), screenpipe_token: token })
      cfg = { ...cfg, screenpipe_token: token }
      log(`Jeton d'API local de Screenpipe enregistré (${maskSecret(token)}).`)
      probe = await screenpipeProbe(cfg.screenpipe_url, token)
    } else {
      log(`Jeton Screenpipe introuvable : affiche-le avec \`${bin ? `"${bin}" auth token` : TOKEN_COMMAND}\`, puis \`${selfCommand()} init --screenpipe-token <jeton>\`.`)
    }
  }
  log(`Lecture des données Screenpipe : ${probe.detail}.`)
  return cfg
}

/** Cerveau auto-hébergé : son certificat est installé pour les navigateurs du poste, une seule fois par certificat. */
export function trustCaForBrowsers(file: string, log: Log) {
  const state = loadState()
  const fp = fingerprintOfFile(file)
  if (fp && state.ca_trusted === fp) return log(`Certificat du cerveau déjà installé pour les navigateurs (${file}).`)
  const t = trustInBrowsers(file)
  log(t.message)
  if (t.ok && fp) saveState({ ...state, ca_trusted: fp })
}

/**
 * Jeton Claude Code du poste, demandé à l'installation : dans un terminal, `connect-claude` tout de suite ; lancé par
 * Claude Code (pas de terminal à soi), une ligne « À FAIRE » que le prompt d'installation fait répéter. Rien à demander
 * avec un jeton déjà enregistré, une clé API, ou sans Claude Code. Renvoie la ligne « À FAIRE », ou null.
 */
async function askClaudeToken(log: Log): Promise<string | null> {
  if (hasScheduledClaude() || !findOnPath("claude")) {
    if (hasScheduledClaude()) log("Jeton Claude Code : déjà enregistré pour la synchro planifiée.")
    return null
  }
  const todo = `À FAIRE (une fois, 1 min) : dans un terminal, lance \`${selfCommand()} connect-claude\` (connexion à Claude dans le navigateur, puis colle le jeton affiché). Sans lui, la synchro des 15 min ne peut pas lancer Claude quand aucune session n'est ouverte.`
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return todo
  try {
    await cmdConnectClaude(log)
    return null
  } catch (err) {
    log(`Jeton Claude Code : ${(err as Error).message}`)
    return todo
  }
}

export async function cmdSetup(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const audio = yesNo(flags.audio, "audio")
  const waitS = typeof flags.wait === "string" ? Number.parseInt(flags.wait, 10) : DEFAULT_WAIT_S
  if (!(waitS >= 0)) throw new UserError("--wait : un nombre de secondes.")
  const me = selfCommand()

  log("[1/6] Connexion au cerveau")
  // Entreprise ajoutée à côté de la première (jeton d'une autre entreprise) : c'est elle qui s'allume et s'ouvre à la fin.
  let added: Company | undefined
  if (flags.url || flags.token) {
    const init = await initBrain(flags, log)
    if (init.code !== 0) {
      log("Le cerveau n'a pas accepté la connexion : vérifie l'URL et le jeton, puis relance setup.")
      return 1
    }
    if (init.added) added = init.company
  }
  let cfg = requireConfig()
  if (!(flags.url || flags.token)) {
    try {
      const who = await new BrainApi(cfg.url, cfg.token, 8000).whoami()
      log(`Connexion au cerveau OK : ${who.profile.name} chez ${who.org.name}.`)
    } catch (err) {
      log(`Le cerveau ne répond pas (${(err as Error).message}).`)
      return 1
    }
  }

  if (cfg.ca_file) trustCaForBrowsers(cfg.ca_file, log)

  let capture: CaptureState | null = null
  let noScreenpipe: string | null = null
  if (flags["skip-screenpipe"]) {
    log("[2/6] Screenpipe : ignoré (--skip-screenpipe) ; brain-sync lira seulement les sessions Claude Code et Codex.")
    log("[3/6] Autorisations : rien à demander.")
  } else {
    log("[2/6] Screenpipe (capture locale de l'écran ; rien de brut ne quitte le poste)")
    // Sans Screenpipe, le reste (MCP, hooks, synchro des sessions Claude Code et Codex) vaut quand même d'être branché.
    let sp: ScreenpipeResult | null = null
    try {
      sp = await ensureScreenpipe(cfg, audio, log)
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      noScreenpipe = err.message
      log(`${err.message} On branche le reste : brain-sync lira les sessions Claude Code et Codex.`)
      log("[3/6] Autorisations : rien à demander sans Screenpipe.")
    }
    if (sp) {
      cfg = await ensureScreenpipeToken(cfg, sp.bin, log)
      log("[3/6] Autorisations")
      capture = await waitForCapture({
        url: cfg.screenpipe_url,
        token: cfg.screenpipe_token,
        waitMs: waitS * 1000,
        // Aussi quand setup est relancé (Screenpipe « déjà lancé » par nous) : c'est le cas typique après un code 3.
        bin: sp.how === "app" ? null : sp.bin,
        restart: sp.bin ? restartScreenpipeService : undefined,
        log,
      })
      if (capture.screen) log("Screenpipe capture l'écran.")
    }
  }

  log("[4/6] Claude Code et Codex : le serveur MCP de chaque entreprise, hooks et skills")
  await ensureMcpServers(log)
  installHooks(log)
  await refreshSkills(log)

  log("[5/6] Synchro automatique")
  // Déjà planifiée : chemins remis à jour, sans nouveau point de départ (ce qui attend d'être envoyé n'est pas sauté).
  if (scheduleInstalled()) refreshSchedule(log)
  else installSchedule(log)
  // Jeton Claude Code : sans lui, la synchro des 15 min (sans session ouverte) ne peut pas lancer Claude.
  const claudeToDo = await askClaudeToken(log)

  log("[6/6] Ton néon et le cerveau")
  try {
    await cmdHello(log, added)
  } catch (err) {
    log(`Néon : ${(err as Error).message}`)
  }
  await openBrain(added ?? cfg, Boolean(flags["no-open"]), log)

  log("")
  log("C'est branché. Continue à travailler avec Claude Code : chaque session allume ta zone, et les connaissances distillées arrivent dans le cerveau toutes les 15 minutes.")
  log(`Voir ce qui partirait : ${me} sync --dry-run --full — diagnostic : ${me} doctor — tout retirer : ${me} uninstall`)
  if (claudeToDo) {
    log("")
    log(claudeToDo)
  }
  if (capture && !capture.up) {
    log("")
    log(`EN ATTENTE : Screenpipe ne répond plus sur ${cfg.screenpipe_url}. Relance : ${me} setup`)
    return EXIT_PERMISSIONS_PENDING
  }
  if (capture && !capture.screen && process.platform === "darwin") {
    log("")
    log(`EN ATTENTE : autorisation « Enregistrement de l'écran » pour screenpipe pas encore accordée. Une fois cochée, relance : ${me} setup`)
    return EXIT_PERMISSIONS_PENDING
  }
  if (noScreenpipe) {
    log("")
    log(`BRANCHÉ SANS SCREENPIPE : ${noScreenpipe} Détail et correction : ${me} doctor`)
    return EXIT_NO_SCREENPIPE
  }
  return 0
}
