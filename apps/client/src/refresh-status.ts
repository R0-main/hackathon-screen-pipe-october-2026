// `refresh-status` : le résumé « où en est la boîte » produit sur le poste d'un admin, avec Claude via son abonnement
// (`claude -p`, sans clé API) — ou le SDK si une clé est configurée et que la CLI manque — puis renvoyé au cerveau.

import { buildCliStatusPrompt, parseStatusJson, redactText, truncate, type StatusInput, type ZoneStatus } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { UserError, requireConfig, type Config } from "./config"
import { apiKey, claudeAuthHelp, claudeCliOptions, cliFailure, findOnPath, runClaudeCli } from "./distill"
import { formatStatus } from "./format"
import { maskOwnSecrets, ownSecrets } from "./secrets"

export const STATUS_CLI_TIMEOUT_MS = 180_000

type Log = (s: string) => void

export type RefreshStatusOptions = { dryRun?: boolean; verbose?: boolean; timeoutMs?: number }

export type GeneratedStatus = { headline: string; zones: ZoneStatus[] }

function adminOnly(err: unknown, what: string): never {
  if (err instanceof ApiError && err.status === 403) {
    throw new UserError(`refresh-status est réservé aux administrateurs du cerveau : votre jeton n'a pas les droits admin (${what} refusé, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("Ce cerveau ne connaît pas encore refresh-status (route absente, 404) : mettez le serveur à jour.")
  }
  throw err
}

/** Masque secrets et données perso du résumé avant de l'afficher ou de l'envoyer (le cerveau re-masque à l'arrivée). */
export function redactStatus(status: GeneratedStatus, literals: string[] = []): GeneratedStatus {
  const r = (t: string) => redactText(t, { literals })
  return {
    headline: r(status.headline),
    zones: status.zones.map((z) => ({
      ...z,
      summary: r(z.summary),
      objectives: z.objectives.map(r),
      progress: r(z.progress),
      next_steps: z.next_steps.map(r),
      who_did_what: z.who_did_what.map((w) => ({ person: r(w.person), did: r(w.did) })),
    })),
  }
}

/** Génère le résumé : `claude -p` (abonnement, jeton de la config) si la CLI est là, sinon le SDK avec la clé API. */
export async function generateStatus(
  cfg: Config,
  input: StatusInput,
  opts: { timeoutMs?: number; log?: Log } = {},
): Promise<{ status: GeneratedStatus; via: string }> {
  const zoneIds = input.zones.map((z) => z.id)
  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (claudePath) {
    const cli = claudeCliOptions(cfg)
    opts.log?.(`Claude Code en local (\`claude -p\`, ${claudePath}${cli.oauthToken ? ", jeton Claude Code de la config" : ""}) : rédaction du résumé…`)
    const run = await runClaudeCli(claudePath, buildCliStatusPrompt(input), opts.timeoutMs ?? STATUS_CLI_TIMEOUT_MS, cli)
    const fail = cliFailure(run)
    if (fail) {
      const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
      // Jeton expiré ou révoqué, « Please run /login » : dire quoi faire, pas seulement que ça a échoué.
      if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Puis relancez \`refresh-status\`.`)
      throw new UserError(`\`claude -p\` a échoué : ${detail}. Vérifiez la connexion de Claude Code (ou \`init --claude-token\`).`)
    }
    const status = parseStatusJson(run.stdout, zoneIds)
    if (!status) throw new UserError(`Réponse de \`claude -p\` illisible (pas de résumé JSON valide) : ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "sortie vide"}`)
    return { status, via: "Claude Code (`claude -p`)" }
  }
  const key = apiKey(cfg)
  if (key) {
    opts.log?.("Claude (API Anthropic) : rédaction du résumé…")
    const { createClaude, summarizeStatusInput } = await import("@brain/core/claude")
    const client = createClaude(key)
    const res = client ? await summarizeStatusInput(client, input) : null
    if (!res) throw new UserError("Claude (API Anthropic) n'a pas produit de résumé (clé invalide, quota ou refus).")
    const known = new Set(zoneIds)
    return { status: { headline: res.headline, zones: res.zones.filter((z) => known.has(z.zone)) }, via: "Claude (API Anthropic)" }
  }
  throw new UserError(
    cfg.use_claude_cli === false
      ? "Pas de clé API et CLI Claude désactivée (use_claude_cli: false) : impossible de rédiger le résumé sur ce poste."
      : "Ni CLI `claude` dans le PATH ni clé API : installez Claude Code (connecté à votre abonnement) ou `init --anthropic-key <clé>`.",
  )
}

/** `brain.mjs refresh-status [--dry-run]` (admin) : matière → Claude sur ce poste → POST /api/status. */
export async function cmdRefreshStatus(opts: RefreshStatusOptions = {}, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  let input: StatusInput
  try {
    input = await api.statusInput()
  } catch (err) {
    adminOnly(err, "GET /api/status/input")
  }
  if (!input || !Array.isArray(input.zones) || !input.zones.length) throw new UserError("Le cerveau n'a encore aucune zone : rien à résumer.")
  log(
    `refresh-status — ${input.company_name || "entreprise"}, ${input.generated_for} : ${input.zones.length} zone(s), ` +
      `${input.items?.length ?? 0} connaissance(s) des 30 derniers jours, ${input.tasks?.length ?? 0} tâche(s).`,
  )
  const generated = await generateStatus(cfg, { ...input, items: input.items ?? [], tasks: input.tasks ?? [] }, { timeoutMs: opts.timeoutMs, log })
  const status = redactStatus(generated.status, ownSecrets(cfg))
  const via = generated.via
  if (!status.zones.length) throw new UserError(`${via} n'a résumé aucune zone connue de l'entreprise : rien n'a été envoyé.`)
  const names = new Map(input.zones.map((z) => [z.id, z.name]))
  const zoneName = (id: string) => names.get(id) ?? id
  if (opts.dryRun) {
    log("")
    log(formatStatus({ ...status, generated_at: new Date().toISOString(), generator: "claude" }, zoneName))
    log("")
    log(`Rien n'a été envoyé (simulation). Sans --dry-run, ce résumé (${via}) remplace l'état affiché sur le dashboard.`)
    return 0
  }
  let saved
  try {
    saved = await api.saveStatus(status)
  } catch (err) {
    adminOnly(err, "POST /api/status")
  }
  log(`État de l'entreprise mis à jour (${via}, ${saved.zones?.length ?? status.zones.length} zone(s)) : ${saved.headline ?? status.headline}`)
  if (opts.verbose) log(formatStatus(saved, zoneName))
  return 0
}
