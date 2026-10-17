// Commandes init, hello et status.

import { BrainApi, type WhoAmI } from "./api"
import { applyCa, describeCa, readCaFile, type CaInfo } from "./ca"
import { cacheFrom, firstName, zoneName } from "./cache"
import { companyLabel, describeCompanies } from "./companies"
import {
  DEFAULT_SCREENPIPE_URL,
  claudeDir,
  codexDir,
  companiesOf,
  loadCache,
  loadPartialConfig,
  loadState,
  maskSecret,
  paths,
  requireConfig,
  saveCache,
  saveConfig,
  selfCommand,
  selfScript,
  UserError,
  withDefaults,
  type Company,
  type Config,
} from "./config"
import { DISTILLER_LABELS, pickDistiller } from "./distill"
import { hooksInstalled, pipeInstalled, pipePath, scheduleInstalled } from "./install"
import { TOKEN_COMMAND, screenpipeHealth, screenpipeProbe } from "./sources/screenpipe"
import { frDate } from "./format"

type Log = (s: string) => void

export async function cmdInit(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  return (await initBrain(flags, log)).code
}

/** Résultat d'`init` : `added` quand le jeton était celui d'une autre entreprise, ajoutée à côté de la première. */
export type InitResult = { code: number; company: Company; added: boolean }

/**
 * Le jeton donné est-il celui d'une AUTRE entreprise que la première du poste ? Oui seulement si les deux jetons sont
 * acceptés et désignent des entreprises différentes. Sinon (même entreprise, ancien jeton régénéré ou refusé, nouveau
 * jeton refusé), il remplace celui de la première, comme avant.
 */
async function otherCompany(first: Company, fresh: Company): Promise<{ first: WhoAmI; other: WhoAmI } | null> {
  const [a, b] = await Promise.allSettled([new BrainApi(first.url, first.token, 8000).whoami(), new BrainApi(fresh.url, fresh.token, 8000).whoami()])
  if (a.status !== "fulfilled" || b.status !== "fulfilled") return null
  const same = a.value.org.id && b.value.org.id ? a.value.org.id === b.value.org.id : first.url === fresh.url && a.value.org.name === b.value.org.name
  return same ? null : { first: a.value, other: b.value }
}

const orgOf = (who: WhoAmI) => ({
  ...(who.org.id ? { id: who.org.id } : {}),
  name: who.org.name,
  ...(who.org.description?.trim() ? { description: who.org.description.trim() } : {}),
})

export async function initBrain(flags: Record<string, string | boolean>, log: Log = console.log): Promise<InitResult> {
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string).trim() : undefined)
  const prev = loadPartialConfig()
  const next: Partial<Config> = withDefaults({ ...prev })
  if (str("url")) next.url = str("url")!.replace(/\/+$/, "")
  if (str("token")) next.token = str("token")
  if (str("screenpipe-url")) next.screenpipe_url = str("screenpipe-url")!.replace(/\/+$/, "")
  if (str("screenpipe-token")) next.screenpipe_token = str("screenpipe-token")
  if (str("anthropic-key")) next.anthropic_api_key = str("anthropic-key")
  const claudeToken = str("claude-token")
  if (flags["claude-token"] === true) throw new UserError("--claude-token : donnez le jeton affiché par `claude setup-token` (ou « aucun » pour le retirer).")
  if (claudeToken !== undefined) {
    if (["aucun", "none", "non", ""].includes(claudeToken.toLowerCase())) delete next.claude_oauth_token
    else if (/\s/.test(claudeToken) || claudeToken.length < 20) throw new UserError("--claude-token : jeton invalide (une seule chaîne, celle affichée par `claude setup-token`).")
    else next.claude_oauth_token = claudeToken
  }
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
  const ca = str("ca")
  if (flags.ca === true) throw new UserError("--ca : donnez le fichier PEM du certificat du cerveau (ou « aucun » pour le retirer).")
  let caInfo: CaInfo | null = null
  if (ca !== undefined) {
    if (["aucun", "none", "non", ""].includes(ca.toLowerCase())) delete next.ca_file
    else {
      caInfo = readCaFile(ca)
      // Dès maintenant pour ce processus : le test de connexion qui suit passe par HTTPS.
      applyCa(caInfo.certs)
      next.ca_file = caInfo.file
    }
  }
  if (!next.url || !next.token) {
    throw new UserError("Première configuration : --url et --token sont obligatoires (ex. init --url https://cerveau.exemple --token cb_…).")
  }
  if (next.url && !/^https?:\/\//.test(next.url)) throw new UserError(`URL invalide : « ${next.url} » (attendu http:// ou https://).`)

  // Un jeton d'une autre entreprise (prompt d'installation d'une deuxième entreprise) : elle s'ajoute à côté de la
  // première, qui reste celle par défaut. Celui d'une entreprise déjà ajoutée : mise à jour de cette entreprise.
  const fresh: Company = { url: next.url, token: next.token }
  if (prev.url && prev.token && fresh.token !== prev.token) {
    const known = prev.companies?.find((c) => c.token === fresh.token)
    if (known) {
      const who = await new BrainApi(fresh.url, fresh.token, 8000).whoami().catch((err: Error) => err)
      if (who instanceof Error) {
        log(`Échec du test de connexion à ${companyLabel(known)} : ${who.message}`)
        return { code: 1, company: known, added: true }
      }
      return addCompany(next, prev, { ...fresh, ...orgOf(who) }, who, log)
    }
    const found = await otherCompany({ url: prev.url, token: prev.token }, fresh)
    if (found) return addCompany({ ...next, org: prev.org ?? orgOf(found.first) }, prev, { ...fresh, ...orgOf(found.other) }, found.other, log)
  }

  saveConfig(next)
  log(`Configuration enregistrée dans ${paths.config()} (mode 600, jeton ${maskSecret(next.token)}).`)
  if (ca !== undefined) {
    log(caInfo ? `Certificat du cerveau enregistré : ${caInfo.file} (${caInfo.cn}, empreinte SHA-256 ${caInfo.fingerprint}).` : "Certificat du cerveau retiré de la config.")
  }
  if (claudeToken !== undefined) {
    log(
      next.claude_oauth_token
        ? `Jeton Claude Code enregistré (${maskSecret(next.claude_oauth_token)}) : chaque \`claude -p\` du client (distillation, refresh-status) l'utilise, synchro planifiée comprise. Il reste dans config.json, jamais dans le planificateur.`
        : "Jeton Claude Code retiré de la config.",
    )
  }

  const api = new BrainApi(next.url, next.token)
  let code = 0
  try {
    const [who, zones] = await Promise.all([api.whoami(), api.zones()])
    saveCache(cacheFrom(who, zones, loadCache()))
    // Qui est la première entreprise : son nom et sa description guident le choix d'entreprise des outils MCP.
    // Elle ne figure pas une seconde fois parmi les autres (ancien jeton refusé, remplacé par celui d'une entreprise ajoutée).
    const companies = next.companies?.filter((c) => !(who.org.id && c.id === who.org.id))
    saveConfig({ ...next, org: orgOf(who), companies: companies?.length ? companies : undefined })
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
  return { code, company: { url: next.url, token: next.token }, added: false }
}

/** Ajoute (ou met à jour) une autre entreprise ; la première, ses réglages et le cache des hooks ne bougent pas. */
function addCompany(next: Partial<Config>, prev: Partial<Config>, company: Company, who: WhoAmI, log: Log): InitResult {
  const others = prev.companies ?? []
  // Même entreprise déjà ajoutée (même jeton, ou nouveau jeton de la même entreprise) : remplacée à sa place.
  const at = others.findIndex((c) => c.token === company.token || (company.id !== undefined && c.id === company.id))
  const companies = at >= 0 ? others.map((c, i) => (i === at ? company : c)) : [...others, company]
  saveConfig({ ...next, url: prev.url, token: prev.token, companies })
  const list = companiesOf({ url: prev.url!, token: prev.token!, org: next.org, companies })
  const first = companyLabel(list[0])
  log(`Configuration enregistrée dans ${paths.config()} (mode 600, jeton ${maskSecret(company.token)}).`)
  log(`Connexion au cerveau OK : ${who.profile.name}${who.profile.title ? ` (${who.profile.title})` : ""} chez ${who.org.name}.`)
  log(
    `${at >= 0 ? "Entreprise mise à jour" : "Entreprise ajoutée"} sur ce poste : ${companyLabel(company)}, à côté de ${first}, qui reste celle par défaut. ` +
      `Les outils MCP du cerveau interrogent ${first} tant qu'on ne leur demande pas ${companyLabel(company)} ; la synchro, les hooks et les skills restent sur ${first}.`,
  )
  log(describeCompanies(list))
  log(`Changer l'entreprise par défaut : ${selfCommand()} companies --default "${companyLabel(company)}"`)
  return { code: 0, company, added: true }
}

/** `company` : l'entreprise à allumer (celle que setup vient d'ajouter) ; par défaut, la première. */
export async function cmdHello(log: Log = console.log, company?: Company): Promise<number> {
  const cfg = requireConfig()
  const target = company ?? cfg
  const api = new BrainApi(target.url, target.token)
  const who = await api.whoami()
  const prenom = firstName(who.profile.name)
  const zones = who.access.readable
  const res = await api.events([
    { agent: "brain-sync", type: "started", zones, summary: `${prenom} vient de connecter son poste au cerveau` },
    { agent: "brain-sync", type: "query", zones, summary: `Test de connexion de ${prenom}` },
  ])
  // Le cache est celui de la première entreprise : une autre ne le touche pas.
  const cache = company ? null : loadCache()
  if (!company) saveCache(cacheFrom(who, null, cache))
  log(`Bonjour ${prenom} ! ${res.recorded} événements envoyés : vos zones (${zones.map((z) => zoneName(cache, z)).join(", ") || "aucune"}) s'allument sur ${target.url}${company ? ` (${who.org.name})` : ""}.`)
  return 0
}

export async function cmdStatus(log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const state = loadState()
  const cache = loadCache()
  log("NOS Brainer — état du client")
  log(`  Script        : ${selfScript()}`)
  log(`  Config        : ${paths.config()}`)
  log(`  Cerveau       : ${cfg.url} (jeton ${maskSecret(cfg.token)})`)
  const companies = companiesOf(cfg)
  if (companies.length > 1) log(`  Entreprises   : ${companies.map((c, i) => `${i + 1}. ${companyLabel(c)}${i === 0 ? " (par défaut)" : ""}`).join(", ")} (détail : companies)`)
  if (cfg.ca_file) log(`  Certificat    : ${cfg.ca_file} (${describeCa(cfg.ca_file)})`)
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
  log(`  Jeton Claude Code : ${cfg.claude_oauth_token ? `${maskSecret(cfg.claude_oauth_token)} (passé à chaque \`claude -p\`)` : "(aucun) — `claude setup-token` puis `init --claude-token <jeton>` pour la synchro planifiée"}`)
  return 0
}
