// `refresh-zones`: the daily "new zones" run done by the company's Claude Code (`claude -p`, its
// subscription, `claude setup-token` token in CI), instead of the server's API key. The computer (or CI) reads the material,
// Claude proposes, the brain applies with its safeguards. The Claude token never leaves the computer or the CI.

import { buildCliNewZonesPrompt, parseNewZonesJson, truncate, type NewZoneProposal, type NewZonesInput } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { UserError, requireConfig, type Config } from "./config"
import { apiKey, claudeAuthHelp, claudeCliOptions, cliFailure, findOnPath, runClaudeCli } from "./distill"
import { maskOwnSecrets, ownSecrets } from "./secrets"

export const ZONES_CLI_TIMEOUT_MS = 300_000

type Log = (s: string) => void

const SKIPPED: Record<string, string> = {
  max_zones: "the company already has 12 zones, the cap",
  too_few_items: "not enough recent knowledge (at least 12 over 30 days)",
}

function adminOnly(err: unknown, what: string): never {
  if (err instanceof ApiError && err.status === 403) {
    throw new UserError(`refresh-zones is reserved to the brain's administrators: your token does not have admin rights (${what} refused, 403).`)
  }
  if (err instanceof ApiError && err.status === 404) {
    throw new UserError("This brain does not know refresh-zones yet (route missing, 404): update the server.")
  }
  throw err
}

/** Claude's proposals: `claude -p` (subscription, token from the config or CLAUDE_CODE_OAUTH_TOKEN) if the CLI is there, otherwise the SDK. */
export async function proposeZones(cfg: Config, input: NewZonesInput, opts: { timeoutMs?: number; log?: Log } = {}): Promise<{ proposals: NewZoneProposal[]; via: string }> {
  const claudePath = cfg.use_claude_cli !== false ? findOnPath("claude") : null
  if (claudePath) {
    const cli = claudeCliOptions(cfg)
    const token = cli.oauthToken ? ", Claude Code token from the config" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? ", CLAUDE_CODE_OAUTH_TOKEN token" : ""
    opts.log?.(`Claude Code (\`claude -p\`, ${claudePath}${token}): analyzing the knowledge…`)
    const run = await runClaudeCli(claudePath, buildCliNewZonesPrompt(input), opts.timeoutMs ?? ZONES_CLI_TIMEOUT_MS, cli)
    const fail = cliFailure(run)
    if (fail) {
      const detail = maskOwnSecrets(fail.error, ownSecrets(cfg)).text
      if (fail.failure === "auth") throw new UserError(`${claudeAuthHelp(detail)} Then run \`refresh-zones\` again.`)
      throw new UserError(`\`claude -p\` failed: ${detail}. Check Claude Code's sign-in (or CLAUDE_CODE_OAUTH_TOKEN).`)
    }
    const proposals = parseNewZonesJson(run.stdout)
    if (!proposals) throw new UserError(`Unreadable \`claude -p\` answer (no "zones" JSON): ${truncate(maskOwnSecrets(run.stdout.trim(), ownSecrets(cfg)).text, 200) || "empty output"}`)
    return { proposals, via: "Claude Code (`claude -p`)" }
  }
  const key = apiKey(cfg)
  if (key) {
    opts.log?.("Claude (Anthropic API): analyzing the knowledge…")
    const { createClaude, proposeNewZones } = await import("@brain/core/claude")
    const client = createClaude(key)
    const proposals = client ? await proposeNewZones(client, input) : null
    if (!proposals) throw new UserError("Claude (Anthropic API) did not answer (invalid key, quota or refusal).")
    return { proposals, via: "Claude (API Anthropic)" }
  }
  throw new UserError("Neither a `claude` CLI in the PATH nor an API key: install Claude Code (`npm install -g @anthropic-ai/claude-code`) and give it a token (`claude setup-token`).")
}

/** `brain.mjs refresh-zones [--dry-run]` (admin): material → Claude here → POST /api/admin/zones/auto. */
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
    log(`refresh-zones: nothing to do, ${SKIPPED[material.skipped] ?? material.skipped}.`)
    return 0
  }
  const input = material.input
  log(`refresh-zones — ${input.company_name || "company"}: ${input.zones.length} zone(s), ${input.items.length} knowledge item(s) from the last 30 days.`)
  const { proposals, via } = await proposeZones(cfg, input, { timeoutMs: opts.timeoutMs, log })
  // Numbers → ids: the server's material can change before sending, the ids stay right.
  const byRef = new Map(input.items.map((i) => [i.ref, i.id]))
  const zones = proposals.map((p) => ({
    name: p.name,
    description: p.description,
    keywords: p.keywords,
    item_ids: p.items.map((r) => byRef.get(r)).filter((id): id is string => Boolean(id)),
  }))
  if (zones.length === 0) {
    log(`${via}: no new zone is needed.`)
    if (opts.dryRun) return 0
  } else {
    for (const z of zones) log(`  • ${z.name} — ${z.description} (${z.item_ids.length} knowledge item${z.item_ids.length === 1 ? "" : "s"})`)
  }
  if (opts.dryRun) {
    log("Nothing was sent (dry run). Without --dry-run, the brain creates these zones if it finds them solid (at least 4 knowledge items, no duplicate).")
    return 0
  }
  let run
  try {
    run = await api.applyNewZones(zones)
  } catch (err) {
    adminOnly(err, "POST /api/admin/zones/auto")
  }
  if (run.status === "created") log(`Zone(s) created: ${run.zones.map((z) => `${z.name} (${z.items} knowledge item${z.items === 1 ? "" : "s"} filed)`).join(", ")}.`)
  else if (run.status === "unchanged") log(zones.length ? "The brain created nothing: the proposals did not pass its safeguards (too thin or duplicated)." : "Nothing created.")
  else log(`The brain did nothing: ${SKIPPED[run.reason] ?? run.reason}.`)
  return 0
}
