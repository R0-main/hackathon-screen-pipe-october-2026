// `moderate`: a run of the brain's moderator done by Claude Code on an admin's computer (`claude -p`, Sonnet, their
// subscription). The scheduled sync of an admin's computer runs it every 15 min, with the token saved at install
// (`connect-claude`). The computer reads what arrived since the previous run, Claude decides here, the brain applies.
// The Claude token never leaves the computer.

import { MODERATION_REASON_LABELS, buildCliModerationPrompt, parseModerationJson, truncate, type ModerationVerdict } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { UserError, loadCache, requireConfig } from "./config"
import { claudeAuthHelp, claudeCliOptions, cliFailure, findOnPath, runClaudeCli } from "./distill"
import { maskOwnSecrets, ownSecrets } from "./secrets"

export const MODERATION_CLI_TIMEOUT_MS = 300_000

type Log = (s: string) => void

function adminOnly(err: unknown, what: string): never {
  if (err instanceof ApiError && err.status === 403) {
    throw new UserError(`moderate is reserved to the brain's administrators: your token does not have admin rights (${what} refused, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("This brain does not know the moderator yet (route missing, 404): update the server.")
  }
  throw err
}

/** `brain.mjs moderate [--dry-run] [--refresh-status]` (admin): material → Claude Code here → POST /api/admin/moderation. */
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
    log(material.skipped === "off" ? "moderate: the moderator is off (Admin → Zones → Moderator)." : "moderate: nothing new to review.")
    return 0
  }
  const { input, remaining } = material
  log(`moderate — ${input.companyName || "company"}: ${input.items.length} knowledge item(s) to review${remaining ? ` (${remaining} at the next run)` : ""}.`)

  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (!claudePath) throw new UserError("`claude` CLI not found: install Claude Code (`npm install -g @anthropic-ai/claude-code`) and give it a token (`claude setup-token`).")
  const cli = claudeCliOptions(cfg)
  const token = cli.oauthToken ? ", Claude Code token from the config" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? ", CLAUDE_CODE_OAUTH_TOKEN token" : ""
  log(`Claude Code (\`claude -p\`, Sonnet${token}): reviewing…`)
  const run = await runClaudeCli(claudePath, buildCliModerationPrompt(input), opts.timeoutMs ?? MODERATION_CLI_TIMEOUT_MS, cli)
  const fail = cliFailure(run)
  if (fail) {
    const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
    if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Then run \`moderate\` again.`)
    throw new UserError(`\`claude -p\` failed: ${detail}. Nothing is applied: this knowledge will be reviewed at the next run.`)
  }
  const verdicts = parseModerationJson(run.stdout)
  if (!verdicts) {
    throw new UserError(
      `Unreadable \`claude -p\` answer (no "verdicts" JSON): ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "empty output"}. Nothing is applied.`,
    )
  }

  // Numbers → ids: only the knowledge of the material, each one once.
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
    if (v.decision === "edit") log(`  ✎ edited: ${what}${v.title ? ` → ${truncate(v.title, 80)}` : ""}${v.zone && v.zone !== i.zone ? ` (to ${v.zone})` : ""}`)
    else log(`  ✕ removed: ${what} — ${MODERATION_REASON_LABELS[v.category ?? "other"]}`)
  }
  if (opts.dryRun) {
    log("Nothing was applied (dry run).")
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
  log(`Moderator: ${result.reviewed} reviewed, ${result.edited} edited, ${result.rejected} removed${result.remaining ? `, ${result.remaining} waiting` : ""}.`)
  if (opts.refreshStatus && result.reviewed > 0) {
    log("")
    const { cmdRefreshStatus } = await import("./refresh-status")
    return cmdRefreshStatus({}, log)
  }
  return 0
}

/**
 * Scheduled sync of an admin's computer: one moderator run, then the summary if there was something new. An error
 * (Claude signed out, brain without a moderator) is written to the sync log, never thrown.
 */
export async function scheduledModeration(log: Log = console.log): Promise<void> {
  if (loadCache()?.whoami?.role !== "admin") return
  try {
    await cmdModerate({ refreshStatus: true }, log)
  } catch (err) {
    log(`Moderator: ${(err as Error).message}`)
  }
}
