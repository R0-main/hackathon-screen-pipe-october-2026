// init, hello and status commands.

import { BrainApi } from "./api"
import { applyCa, describeCa, readCaFile, type CaInfo } from "./ca"
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
import { shortDate } from "./format"

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
  const claudeToken = str("claude-token")
  if (flags["claude-token"] === true) throw new UserError("--claude-token: give the token shown by `claude setup-token` (or \"none\" to remove it).")
  if (claudeToken !== undefined) {
    if (["none", "aucun", "no", ""].includes(claudeToken.toLowerCase())) delete next.claude_oauth_token
    else if (/\s/.test(claudeToken) || claudeToken.length < 20) throw new UserError("--claude-token: invalid token (a single string, the one shown by `claude setup-token`).")
    else next.claude_oauth_token = claudeToken
  }
  const share = str("share-prompt-summaries")
  if (share !== undefined) {
    const v = share.toLowerCase()
    if (["yes", "on", "true", "1", "oui"].includes(v)) next.share_prompt_summaries = true
    else if (["no", "off", "false", "0", "non"].includes(v)) next.share_prompt_summaries = false
    else throw new UserError(`--share-prompt-summaries: "yes" or "no" (got "${share}").`)
  }
  const meetings = str("screenpipe-meetings")
  if (meetings !== undefined) {
    const v = meetings.toLowerCase()
    if (["yes", "on", "true", "1", "oui"].includes(v)) next.screenpipe_meetings = true
    else if (["no", "off", "false", "0", "non"].includes(v)) next.screenpipe_meetings = false
    else throw new UserError(`--screenpipe-meetings: "yes" or "no" (got "${meetings}").`)
  }
  const ca = str("ca")
  if (flags.ca === true) throw new UserError("--ca: give the PEM file of the brain's certificate (or \"none\" to remove it).")
  let caInfo: CaInfo | null = null
  if (ca !== undefined) {
    if (["none", "aucun", "no", ""].includes(ca.toLowerCase())) delete next.ca_file
    else {
      caInfo = readCaFile(ca)
      // Right away for this process: the connection test that follows goes over HTTPS.
      applyCa(caInfo.certs)
      next.ca_file = caInfo.file
    }
  }
  if (!next.url || !next.token) {
    throw new UserError("First configuration: --url and --token are required (e.g. init --url https://brain.example --token cb_…).")
  }
  if (next.url && !/^https?:\/\//.test(next.url)) throw new UserError(`Invalid URL: "${next.url}" (expected http:// or https://).`)
  saveConfig(next)
  log(`Configuration saved in ${paths.config()} (mode 600, token ${maskSecret(next.token)}).`)
  if (ca !== undefined) {
    log(caInfo ? `Brain certificate saved: ${caInfo.file} (${caInfo.cn}, SHA-256 fingerprint ${caInfo.fingerprint}).` : "Brain certificate removed from the config.")
  }
  if (claudeToken !== undefined) {
    log(
      next.claude_oauth_token
        ? `Claude Code token saved (${maskSecret(next.claude_oauth_token)}): every \`claude -p\` of the client (distillation, refresh-status) uses it, scheduled sync included. It stays in config.json, never in the scheduler.`
        : "Claude Code token removed from the config.",
    )
  }

  const api = new BrainApi(next.url, next.token)
  let code = 0
  try {
    const [who, zones] = await Promise.all([api.whoami(), api.zones()])
    saveCache(cacheFrom(who, zones, loadCache()))
    const readable = zones.filter((z) => z.readable).map((z) => z.name)
    log(`Connection to the brain OK: ${who.profile.name}${who.profile.title ? ` (${who.profile.title})` : ""} at ${who.org.name}.`)
    log(`Accessible zones: ${readable.join(", ") || "none for now"}${who.access.isAdmin ? " (admin)" : ""}.`)
  } catch (err) {
    log(`Connection test failed: ${(err as Error).message}`)
    code = 1
  }
  if (str("screenpipe-token") || str("screenpipe-url")) {
    const spUrl = next.screenpipe_url ?? DEFAULT_SCREENPIPE_URL
    const h = await screenpipeHealth(spUrl, next.screenpipe_token)
    log(`Screenpipe (${spUrl}) : ${h.ok ? "OK" : "KO"} — ${h.detail}.`)
    if (h.ok) {
      const p = await screenpipeProbe(spUrl, next.screenpipe_token)
      log(`Screenpipe, reading the data: ${p.detail}.`)
      if (p.auth === "token_required") log(`  → show the token with \`${TOKEN_COMMAND}\` then run init --screenpipe-token <token> again.`)
      if (p.auth === "ok" && p.parsed === false)
        log("  → turn on semantic context in Screenpipe (app: Settings → Recording → app context \"memory\"; CLI: --enable-semantic-context), use ChatGPT or Claude for a few minutes, then run `status` again.")
    }
  }
  return code
}

export async function cmdHello(log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  const who = await api.whoami()
  const first = firstName(who.profile.name)
  const zones = who.access.readable
  const res = await api.events([
    { agent: "brain-sync", type: "started", zones, summary: `${first} just connected their computer to the brain` },
    { agent: "brain-sync", type: "query", zones, summary: `${first}'s connection test` },
  ])
  const cache = loadCache()
  saveCache(cacheFrom(who, null, cache))
  log(`Hello ${first}. ${res.recorded} events sent: your zones (${zones.map((z) => zoneName(cache, z)).join(", ") || "none"}) light up on ${cfg.url}.`)
  return 0
}

export async function cmdStatus(log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const state = loadState()
  const cache = loadCache()
  log("NOS Brainer — client status")
  log(`  Script        : ${selfScript()}`)
  log(`  Config        : ${paths.config()}`)
  log(`  Brain         : ${cfg.url} (token ${maskSecret(cfg.token)})`)
  if (cfg.ca_file) log(`  Certificate   : ${cfg.ca_file} (${describeCa(cfg.ca_file)})`)
  try {
    const who = await new BrainApi(cfg.url, cfg.token, 5000).whoami()
    log(`  Connection    : OK — ${who.profile.name}, ${who.org.name}, zones: ${who.access.readable.map((z) => zoneName(cache, z)).join(", ") || "none"}`)
  } catch (err) {
    log(`  Connection    : KO — ${(err as Error).message}`)
  }
  const ls = state.last_sync
  log(
    `  Last sync     : ${ls ? `${shortDate(ls.at)} ${new Date(ls.at).toLocaleTimeString("en-GB")} — ${ls.items_sent} knowledge item(s) sent, distillation ${DISTILLER_LABELS[ls.distiller as keyof typeof DISTILLER_LABELS] ?? ls.distiller}` : "never"}`,
  )
  log(`  Sources       : ${cfg.sources.join(", ")}`)
  log(`  Claude Code   : ${claudeDir()} (${Object.keys(state.claude?.files ?? {}).length} file(s) followed)`)
  log(`  Codex         : ${codexDir()} (${Object.keys(state.codex?.files ?? {}).length} file(s) followed)`)
  const h = await screenpipeHealth(cfg.screenpipe_url, cfg.screenpipe_token)
  log(`  Screenpipe    : ${cfg.screenpipe_url} — ${h.ok ? "OK" : "KO"} (${h.detail})${cfg.screenpipe_token ? `, token ${maskSecret(cfg.screenpipe_token)}` : ""}`)
  if (h.ok) {
    const p = await screenpipeProbe(cfg.screenpipe_url, cfg.screenpipe_token)
    log(`                  data: ${p.detail}${cfg.screenpipe_meetings === false ? "; meetings not distilled (--screenpipe-meetings no)" : "; meetings distilled"}`)
  }
  log(`  Screenpipe pipe : ${pipeInstalled() ? `installed (${pipePath()})` : "not installed (install-pipe, if the Screenpipe app is present)"}`)
  log(`  Claude hooks  : ${hooksInstalled() ? "installed" : "not installed"} (${paths.claudeSettings()})`)
  log(
    `  Prompt summaries : ${cfg.share_prompt_summaries === false ? "disabled (fingerprint only)" : "sent only for prompts classified in a zone and not personal"}`,
  )
  let sched = false
  try {
    sched = scheduleInstalled()
  } catch {
    sched = false
  }
  log(`  Auto sync     : ${sched ? "scheduled every 15 min" : "not scheduled (install-schedule)"}`)
  const d = pickDistiller(cfg)
  log(`  Distillation  : ${DISTILLER_LABELS[d.kind]} — ${d.reason}`)
  log(`  Anthropic key: ${maskSecret(cfg.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY)}`)
  log(`  Claude Code token : ${cfg.claude_oauth_token ? `${maskSecret(cfg.claude_oauth_token)} (passed to every \`claude -p\`)` : "(none) — `claude setup-token` then `init --claude-token <token>` for the scheduled sync"}`)
  return 0
}
