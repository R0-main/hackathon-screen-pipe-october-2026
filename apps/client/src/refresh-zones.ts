// `refresh-zones` : le passage quotidien « nouvelles zones » fait par le Claude Code de l'entreprise (`claude -p`, son
// abonnement, jeton `claude setup-token` en CI), au lieu de la clé API du serveur. Le poste (ou la CI) lit la matière,
// Claude propose, le cerveau applique avec ses garde-fous. Le jeton Claude ne quitte jamais le poste ou la CI.

import { buildCliNewZonesPrompt, parseNewZonesJson, truncate, type NewZoneProposal, type NewZonesInput } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { UserError, requireConfig, type Config } from "./config"
import { apiKey, claudeAuthHelp, claudeCliOptions, cliFailure, findOnPath, runClaudeCli } from "./distill"
import { maskOwnSecrets, ownSecrets } from "./secrets"

export const ZONES_CLI_TIMEOUT_MS = 300_000

type Log = (s: string) => void

const SKIPPED: Record<string, string> = {
  max_zones: "l'entreprise a déjà 12 zones, le plafond",
  too_few_items: "pas assez de connaissances récentes (12 au moins sur 30 jours)",
}

function adminOnly(err: unknown, what: string): never {
  if (err instanceof ApiError && err.status === 403) {
    throw new UserError(`refresh-zones est réservé aux administrateurs du cerveau : votre jeton n'a pas les droits admin (${what} refusé, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("Ce cerveau ne connaît pas encore refresh-zones (route absente, 404) : mettez le serveur à jour.")
  }
  throw err
}

/** Propositions de Claude : `claude -p` (abonnement, jeton de la config ou CLAUDE_CODE_OAUTH_TOKEN) si la CLI est là, sinon le SDK. */
export async function proposeZones(cfg: Config, input: NewZonesInput, opts: { timeoutMs?: number; log?: Log } = {}): Promise<{ proposals: NewZoneProposal[]; via: string }> {
  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (claudePath) {
    const cli = claudeCliOptions(cfg)
    const token = cli.oauthToken ? ", jeton Claude Code de la config" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? ", jeton CLAUDE_CODE_OAUTH_TOKEN" : ""
    opts.log?.(`Claude Code (\`claude -p\`, ${claudePath}${token}) : analyse des connaissances…`)
    const run = await runClaudeCli(claudePath, buildCliNewZonesPrompt(input), opts.timeoutMs ?? ZONES_CLI_TIMEOUT_MS, cli)
    const fail = cliFailure(run)
    if (fail) {
      const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
      if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Puis relancez \`refresh-zones\`.`)
      throw new UserError(`\`claude -p\` a échoué : ${detail}. Vérifiez la connexion de Claude Code (ou CLAUDE_CODE_OAUTH_TOKEN).`)
    }
    const proposals = parseNewZonesJson(run.stdout)
    if (!proposals) throw new UserError(`Réponse de \`claude -p\` illisible (pas de JSON « zones ») : ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "sortie vide"}`)
    return { proposals, via: "Claude Code (`claude -p`)" }
  }
  const key = apiKey(cfg)
  if (key) {
    opts.log?.("Claude (API Anthropic) : analyse des connaissances…")
    const { createClaude, proposeNewZones } = await import("@brain/core/claude")
    const client = createClaude(key)
    const proposals = client ? await proposeNewZones(client, input) : null
    if (!proposals) throw new UserError("Claude (API Anthropic) n'a pas répondu (clé invalide, quota ou refus).")
    return { proposals, via: "Claude (API Anthropic)" }
  }
  throw new UserError("Ni CLI `claude` dans le PATH ni clé API : installez Claude Code (`npm install -g @anthropic-ai/claude-code`) et donnez-lui un jeton (`claude setup-token`).")
}

/** `brain.mjs refresh-zones [--dry-run]` (admin) : matière → Claude ici → POST /api/admin/zones/auto. */
export async function cmdRefreshZones(opts: { dryRun?: boolean; timeoutMs?: number } = {}, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  let material: Awaited<ReturnType<BrainApi["newZonesInput"]>>
  try {
    material = await api.newZonesInput()
  } catch (err) {
    adminOnly(err, "GET /api/admin/zones/auto/input")
  }
  if ("skipped" in material) {
    log(`refresh-zones : rien à faire, ${SKIPPED[material.skipped] ?? material.skipped}.`)
    return 0
  }
  const input = material.input
  log(`refresh-zones — ${input.company_name || "entreprise"} : ${input.zones.length} zone(s), ${input.items.length} connaissance(s) des 30 derniers jours.`)
  const { proposals, via } = await proposeZones(cfg, input, { timeoutMs: opts.timeoutMs, log })
  // Numéros → identifiants : la matière du serveur peut bouger d'ici l'envoi, les identifiants restent justes.
  const byRef = new Map(input.items.map((i) => [i.ref, i.id]))
  const zones = proposals.map((p) => ({
    name: p.name,
    description: p.description,
    keywords: p.keywords,
    item_ids: p.items.map((r) => byRef.get(r)).filter((id): id is string => Boolean(id)),
  }))
  if (zones.length === 0) {
    log(`${via} : aucune nouvelle zone ne s'impose.`)
    if (opts.dryRun) return 0
  } else {
    for (const z of zones) log(`  • ${z.name} — ${z.description} (${z.item_ids.length} connaissance${z.item_ids.length > 1 ? "s" : ""})`)
  }
  if (opts.dryRun) {
    log("Rien n'a été envoyé (simulation). Sans --dry-run, le cerveau crée ces zones s'il les juge solides (4 connaissances au moins, pas de doublon).")
    return 0
  }
  let run
  try {
    run = await api.applyNewZones(zones)
  } catch (err) {
    adminOnly(err, "POST /api/admin/zones/auto")
  }
  if (run.status === "created") log(`Zone(s) créée(s) : ${run.zones.map((z) => `${z.name} (${z.items} connaissance${z.items > 1 ? "s" : ""} rangée${z.items > 1 ? "s" : ""})`).join(", ")}.`)
  else if (run.status === "unchanged") log(zones.length ? "Le cerveau n'a rien créé : les propositions ne passaient pas ses garde-fous (trop maigres ou en doublon)." : "Rien de créé.")
  else log(`Le cerveau n'a rien fait : ${SKIPPED[run.reason] ?? run.reason}.`)
  return 0
}
