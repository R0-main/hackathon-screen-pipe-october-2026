// `refresh-status`: the "where the company stands" summary produced on an admin's computer, with Claude through their
// subscription (`claude -p`, no API key) — or the SDK if a key is configured and the CLI is missing — then sent back to the brain.

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
    throw new UserError(`refresh-status is reserved to the brain's administrators: your token does not have admin rights (${what} refused, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("This brain does not know refresh-status yet (route missing, 404): update the server.")
  }
  throw err
}

/** Redacts secrets and personal data from the summary before showing or sending it (the brain redacts again on arrival). */
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

/** Generates the summary: `claude -p` (subscription, token from the config) if the CLI is there, otherwise the SDK with the API key. */
export async function generateStatus(
  cfg: Config,
  input: StatusInput,
  opts: { timeoutMs?: number; log?: Log } = {},
): Promise<{ status: GeneratedStatus; via: string }> {
  const zoneIds = input.zones.map((z) => z.id)
  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (claudePath) {
    const cli = claudeCliOptions(cfg)
    opts.log?.(`Local Claude Code (\`claude -p\`, ${claudePath}${cli.oauthToken ? ", Claude Code token from the config" : ""}): writing the summary…`)
    const run = await runClaudeCli(claudePath, buildCliStatusPrompt(input), opts.timeoutMs ?? STATUS_CLI_TIMEOUT_MS, cli)
    const fail = cliFailure(run)
    if (fail) {
      const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
      // Expired or revoked token, "Please run /login": say what to do, not only that it failed.
      if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Then run \`refresh-status\` again.`)
      throw new UserError(`\`claude -p\` failed: ${detail}. Check Claude Code's sign-in (or \`init --claude-token\`).`)
    }
    const status = parseStatusJson(run.stdout, zoneIds)
    if (!status) throw new UserError(`Unreadable \`claude -p\` answer (no valid JSON summary): ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "empty output"}`)
    return { status, via: "Claude Code (`claude -p`)" }
  }
  const key = apiKey(cfg)
  if (key) {
    opts.log?.("Claude (Anthropic API): writing the summary…")
    const { createClaude, summarizeStatusInput } = await import("@brain/core/claude")
    const client = createClaude(key)
    const res = client ? await summarizeStatusInput(client, input) : null
    if (!res) throw new UserError("Claude (Anthropic API) did not produce a summary (invalid key, quota or refusal).")
    const known = new Set(zoneIds)
    return { status: { headline: res.headline, zones: res.zones.filter((z) => known.has(z.zone)) }, via: "Claude (API Anthropic)" }
  }
  throw new UserError(
    cfg.use_claude_cli === false
      ? "No API key and the Claude CLI is disabled (use_claude_cli: false): cannot write the summary on this computer."
      : "Neither a `claude` CLI in the PATH nor an API key: install Claude Code (signed in to your subscription) or `init --anthropic-key <key>`.",
  )
}

/** `brain.mjs refresh-status [--dry-run]` (admin): material → Claude on this computer → POST /api/status. */
export async function cmdRefreshStatus(opts: RefreshStatusOptions = {}, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  let input: StatusInput
  try {
    input = await api.statusInput()
  } catch (err) {
    adminOnly(err, "GET /api/status/input")
  }
  if (!input || !Array.isArray(input.zones) || !input.zones.length) throw new UserError("The brain has no zone yet: nothing to summarize.")
  log(
    `refresh-status — ${input.company_name || "company"}, ${input.generated_for}: ${input.zones.length} zone(s), ` +
      `${input.items?.length ?? 0} knowledge item(s) from the last 30 days, ${input.tasks?.length ?? 0} task(s).`,
  )
  const generated = await generateStatus(cfg, { ...input, items: input.items ?? [], tasks: input.tasks ?? [] }, { timeoutMs: opts.timeoutMs, log })
  const status = redactStatus(generated.status, ownSecrets(cfg))
  const via = generated.via
  if (!status.zones.length) throw new UserError(`${via} summarized no zone known to the company: nothing was sent.`)
  const names = new Map(input.zones.map((z) => [z.id, z.name]))
  const zoneName = (id: string) => names.get(id) ?? id
  if (opts.dryRun) {
    log("")
    log(formatStatus({ ...status, generated_at: new Date().toISOString(), generator: "claude" }, zoneName))
    log("")
    log(`Nothing was sent (dry run). Without --dry-run, this summary (${via}) replaces the status shown on the dashboard.`)
    return 0
  }
  let saved
  try {
    saved = await api.saveStatus(status)
  } catch (err) {
    adminOnly(err, "POST /api/status")
  }
  log(`Company status updated (${via}, ${saved.zones?.length ?? status.zones.length} zone(s)): ${saved.headline ?? status.headline}`)
  if (opts.verbose) log(formatStatus(saved, zoneName))
  return 0
}
