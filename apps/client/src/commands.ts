// Commandes init, hello et status.

import { BrainApi } from "./api"
import { cacheFrom, firstName, zoneName } from "./cache"
import {
  DEFAULT_SCREENPIPE_URL,
  claudeDir,
  codexDir,
  loadCache,
  loadPartialConfig,
  loadState,
  maskSecret,
  paths,
  requireConfig,
  saveCache,
  saveConfig,
  selfScript,
  UserError,
  withDefaults,
  type Config,
} from "./config"
import { DISTILLER_LABELS, pickDistiller } from "./distill"
import { hooksInstalled, pipeInstalled, pipePath, scheduleInstalled } from "./install"
import { TOKEN_COMMAND, screenpipeHealth, screenpipeProbe } from "./sources/screenpipe"
import { frDate } from "./format"

type Log = (s: string) => void

export async function cmdInit(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string).trim() : undefined)
  const prev = loadPartialConfig()
  const next: Partial<Config> = withDefaults({ ...prev })
  if (str("url")) next.url = str("url")!.replace(/\/+$/, "")
  if (str("token")) next.token = str("token")
  if (str("screenpipe-url")) next.screenpipe_url = str("screenpipe-url")!.replace(/\/+$/, "")
  if (str("screenpipe-token")) next.screenpipe_token = str("screenpipe-token")
  if (str("anthropic-key")) next.anthropic_api_key = str("anthropic-key")
  const share = str("share-prompt-summaries")
  if (share !== undefined) {
    const v = share.toLowerCase()
    if (["oui", "on", "true", "1", "yes"].includes(v)) next.share_prompt_summaries = true
    else if (["non", "off", "false", "0", "no"].includes(v)) next.share_prompt_summaries = false
    else throw new UserError(`--share-prompt-summaries : « oui » ou « non » (reçu « ${share} »).`)
  }
  const meetings = str("screenpipe-meetings")
  if (meetings !== undefined) {
    const v = meetings.toLowerCase()
    if (["oui", "on", "true", "1", "yes"].includes(v)) next.screenpipe_meetings = true
    else if (["non", "off", "false", "0", "no"].includes(v)) next.screenpipe_meetings = false
    else throw new UserError(`--screenpipe-meetings : « oui » ou « non » (reçu « ${meetings} »).`)
  }
  if (!next.url || !next.token) {
    throw new UserError("Première configuration : --url et --token sont obligatoires (ex. init --url https://cerveau.exemple --token cb_…).")
  }
  if (next.url && !/^https?:\/\//.test(next.url)) throw new UserError(`URL invalide : « ${next.url} » (attendu http:// ou https://).`)
  saveConfig(next)
  log(`Configuration enregistrée dans ${paths.config()} (mode 600, jeton ${maskSecret(next.token)}).`)

  const api = new BrainApi(next.url, next.token)
  let code = 0
  try {
    const [who, zones] = await Promise.all([api.whoami(), api.zones()])
    saveCache(cacheFrom(who, zones, loadCache()))
    const readable = zones.filter((z) => z.readable).map((z) => z.name)
    log(`Connexion au cerveau OK : ${who.profile.name}${who.profile.title ? ` (${who.profile.title})` : ""} chez ${who.org.name}.`)
    log(`Zones accessibles : ${readable.join(", ") || "aucune pour l'instant"}${who.access.isAdmin ? " (admin)" : ""}.`)
  } catch (err) {
    log(`Échec du test de connexion : ${(err as Error).message}`)
    code = 1
  }
  if (str("screenpipe-token") || str("screenpipe-url")) {
    const spUrl = next.screenpipe_url ?? DEFAULT_SCREENPIPE_URL
    const h = await screenpipeHealth(spUrl, next.screenpipe_token)
    log(`Screenpipe (${spUrl}) : ${h.ok ? "OK" : "KO"} — ${h.detail}.`)
    if (h.ok) {
      const p = await screenpipeProbe(spUrl, next.screenpipe_token)
      log(`Screenpipe, lecture des données : ${p.detail}.`)
      if (p.auth === "token_required") log(`  → affichez le jeton avec \`${TOKEN_COMMAND}\` puis relancez init --screenpipe-token <jeton>.`)
      if (p.auth === "ok" && p.parsed === false)
        log("  → activez le contexte sémantique dans Screenpipe (app : Settings → Recording → app context « memory » ; CLI : --enable-semantic-context), utilisez ChatGPT ou Claude quelques minutes, puis relancez `status`.")
    }
  }
  return code
}

export async function cmdHello(log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  const who = await api.whoami()
  const prenom = firstName(who.profile.name)
  const zones = who.access.readable
  const res = await api.events([
    { agent: "brain-sync", type: "started", zones, summary: `${prenom} vient de connecter son poste au cerveau` },
    { agent: "brain-sync", type: "query", zones, summary: `Test de connexion de ${prenom}` },
  ])
  const cache = loadCache()
  saveCache(cacheFrom(who, null, cache))
  log(`Bonjour ${prenom} ! ${res.recorded} événements envoyés : vos zones (${zones.map((z) => zoneName(cache, z)).join(", ") || "aucune"}) s'allument sur ${cfg.url}.`)
  return 0
}

export async function cmdStatus(log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const state = loadState()
  const cache = loadCache()
  log("Cerveau d'entreprise — état du client")
  log(`  Script        : ${selfScript()}`)
  log(`  Config        : ${paths.config()}`)
  log(`  Cerveau       : ${cfg.url} (jeton ${maskSecret(cfg.token)})`)
  try {
    const who = await new BrainApi(cfg.url, cfg.token, 5000).whoami()
    log(`  Connexion     : OK — ${who.profile.name}, ${who.org.name}, zones : ${who.access.readable.map((z) => zoneName(cache, z)).join(", ") || "aucune"}`)
  } catch (err) {
    log(`  Connexion     : KO — ${(err as Error).message}`)
  }
  const ls = state.last_sync
  log(
    `  Dernière synchro : ${ls ? `${frDate(ls.at)} ${new Date(ls.at).toLocaleTimeString("fr-FR")} — ${ls.items_sent} connaissance(s) envoyée(s), distillation ${DISTILLER_LABELS[ls.distiller as keyof typeof DISTILLER_LABELS] ?? ls.distiller}` : "jamais"}`,
  )
  log(`  Sources       : ${cfg.sources.join(", ")}`)
  log(`  Claude Code   : ${claudeDir()} (${Object.keys(state.claude?.files ?? {}).length} fichier(s) suivis)`)
  log(`  Codex         : ${codexDir()} (${Object.keys(state.codex?.files ?? {}).length} fichier(s) suivis)`)
  const h = await screenpipeHealth(cfg.screenpipe_url, cfg.screenpipe_token)
  log(`  Screenpipe    : ${cfg.screenpipe_url} — ${h.ok ? "OK" : "KO"} (${h.detail})${cfg.screenpipe_token ? `, jeton ${maskSecret(cfg.screenpipe_token)}` : ""}`)
  if (h.ok) {
    const p = await screenpipeProbe(cfg.screenpipe_url, cfg.screenpipe_token)
    log(`                  données : ${p.detail}${cfg.screenpipe_meetings === false ? " ; réunions non distillées (--screenpipe-meetings non)" : " ; réunions distillées"}`)
  }
  log(`  Pipe Screenpipe : ${pipeInstalled() ? `installé (${pipePath()})` : "non installé (install-pipe, si l'application Screenpipe est présente)"}`)
  log(`  Hooks Claude  : ${hooksInstalled() ? "installés" : "non installés"} (${paths.claudeSettings()})`)
  log(
    `  Résumés de prompts : ${cfg.share_prompt_summaries === false ? "désactivés (empreinte seule)" : "envoyés seulement pour les prompts classés dans une zone et non personnels"}`,
  )
  let sched = false
  try {
    sched = scheduleInstalled()
  } catch {
    sched = false
  }
  log(`  Synchro auto  : ${sched ? "planifiée toutes les 15 min" : "non planifiée (install-schedule)"}`)
  const d = pickDistiller(cfg)
  log(`  Distillation  : ${DISTILLER_LABELS[d.kind]} — ${d.reason}`)
  log(`  Clé Anthropic : ${maskSecret(cfg.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY)}`)
  return 0
}
