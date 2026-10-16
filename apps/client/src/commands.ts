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
import { hooksInstalled, scheduleInstalled } from "./install"
import { screenpipeHealth } from "./sources/screenpipe"
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
    const h = await screenpipeHealth(next.screenpipe_url ?? DEFAULT_SCREENPIPE_URL, next.screenpipe_token)
    log(`Screenpipe (${next.screenpipe_url}) : ${h.ok ? "OK" : "KO"} — ${h.detail}.`)
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
  log(`  Hooks Claude  : ${hooksInstalled() ? "installés" : "non installés"} (${paths.claudeSettings()})`)
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
