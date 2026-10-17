// `moderate` : un passage du modérateur du cerveau fait par Claude Code sur le poste d'un admin (`claude -p`, Sonnet, son
// abonnement). La synchro planifiée d'un poste admin le lance toutes les 15 min, avec le jeton enregistré à l'installation
// (`connect-claude`). Le poste lit ce qui est arrivé depuis le passage précédent, Claude décide ici, le cerveau applique.
// Le jeton Claude ne quitte jamais le poste.

import { MODERATION_REASON_LABELS, buildCliModerationPrompt, parseModerationJson, truncate, type ModerationVerdict } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { UserError, loadCache, requireConfig } from "./config"
import { claudeAuthHelp, claudeCliOptions, cliFailure, findOnPath, runClaudeCli } from "./distill"
import { maskOwnSecrets, ownSecrets } from "./secrets"

export const MODERATION_CLI_TIMEOUT_MS = 300_000

type Log = (s: string) => void

function adminOnly(err: unknown, what: string): never {
  if (err instanceof ApiError && err.status === 403) {
    throw new UserError(`moderate est réservé aux administrateurs du cerveau : votre jeton n'a pas les droits admin (${what} refusé, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("Ce cerveau ne connaît pas encore le modérateur (route absente, 404) : mettez le serveur à jour.")
  }
  throw err
}

/** `brain.mjs moderate [--dry-run] [--refresh-status]` (admin) : matière → Claude Code ici → POST /api/admin/moderation. */
export async function cmdModerate(opts: { dryRun?: boolean; refreshStatus?: boolean; timeoutMs?: number } = {}, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  let material: Awaited<ReturnType<BrainApi["moderationInput"]>>
  try {
    material = await api.moderationInput()
  } catch (err) {
    adminOnly(err, "GET /api/admin/moderation/input")
  }
  if ("skipped" in material) {
    log(material.skipped === "off" ? "moderate : le modérateur est coupé (Admin → Zones → Modérateur)." : "moderate : rien de nouveau à relire.")
    return 0
  }
  const { input, remaining } = material
  log(`moderate — ${input.companyName || "entreprise"} : ${input.items.length} connaissance(s) à relire${remaining ? ` (${remaining} au passage suivant)` : ""}.`)

  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (!claudePath) throw new UserError("CLI `claude` introuvable : installez Claude Code (`npm install -g @anthropic-ai/claude-code`) et donnez-lui un jeton (`claude setup-token`).")
  const cli = claudeCliOptions(cfg)
  const token = cli.oauthToken ? ", jeton Claude Code de la config" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? ", jeton CLAUDE_CODE_OAUTH_TOKEN" : ""
  log(`Claude Code (\`claude -p\`, Sonnet${token}) : relecture…`)
  const run = await runClaudeCli(claudePath, buildCliModerationPrompt(input), opts.timeoutMs ?? MODERATION_CLI_TIMEOUT_MS, cli)
  const fail = cliFailure(run)
  if (fail) {
    const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
    if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Puis relancez \`moderate\`.`)
    throw new UserError(`\`claude -p\` a échoué : ${detail}. Rien n'est appliqué : ces connaissances seront relues au passage suivant.`)
  }
  const verdicts = parseModerationJson(run.stdout)
  if (!verdicts) {
    throw new UserError(
      `Réponse de \`claude -p\` illisible (pas de JSON « verdicts ») : ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "sortie vide"}. Rien n'est appliqué.`,
    )
  }

  // Numéros → identifiants : seules les connaissances de la matière, chacune une fois.
  const byRef = new Map(input.items.map((i) => [i.ref, i]))
  const seen = new Set<number>()
  const decided: (Omit<ModerationVerdict, "ref"> & { id: string })[] = []
  for (const { ref, ...v } of verdicts) {
    const item = byRef.get(ref)
    if (!item?.id || seen.has(ref)) continue
    seen.add(ref)
    decided.push({ ...v, id: item.id })
  }
  for (const i of input.items) {
    const v = decided.find((d) => d.id === i.id)
    if (!v || v.decision === "publish") continue
    const what = `[${i.zone}] ${truncate(i.title, 80)}`
    if (v.decision === "edit") log(`  ✎ corrigée : ${what}${v.title ? ` → ${truncate(v.title, 80)}` : ""}${v.zone && v.zone !== i.zone ? ` (vers ${v.zone})` : ""}`)
    else log(`  ✕ retirée : ${what} — ${MODERATION_REASON_LABELS[v.category ?? "autre"]}`)
  }
  if (opts.dryRun) {
    log("Rien n'a été appliqué (simulation).")
    return 0
  }
  let result
  try {
    result = await api.applyModeration(
      input.items.map((i) => i.id!).filter(Boolean),
      decided,
    )
  } catch (err) {
    adminOnly(err, "POST /api/admin/moderation")
  }
  log(`Modérateur : ${result.reviewed} relue(s), ${result.edited} corrigée(s), ${result.rejected} retirée(s)${result.remaining ? `, ${result.remaining} en attente` : ""}.`)
  if (opts.refreshStatus && result.reviewed > 0) {
    log("")
    const { cmdRefreshStatus } = await import("./refresh-status")
    return cmdRefreshStatus({}, log)
  }
  return 0
}

/**
 * Synchro planifiée d'un poste admin : un passage du modérateur, puis le résumé s'il y avait du nouveau. Une erreur
 * (Claude déconnecté, cerveau sans modérateur) est écrite dans le journal de la synchro, jamais remontée.
 */
export async function scheduledModeration(log: Log = console.log): Promise<void> {
  if (loadCache()?.whoami?.role !== "admin") return
  try {
    await cmdModerate({ refreshStatus: true }, log)
  } catch (err) {
    log(`Modérateur : ${(err as Error).message}`)
  }
}
