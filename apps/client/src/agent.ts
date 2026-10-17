// The computer's Screenpipe agent: at each sync, Claude Code (`claude -p`) or Codex (`codex exec`) looks at the recent
// activity itself through the Screenpipe MCP (read-only tools) and draws from it the knowledge useful to the company.
// What it proposes goes through the same filters as distillation (redaction, personal content, contract) before being
// sent by the sync.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { buildAgentPrompt, looksPersonal, type Conversation, type KnowledgeItemInput, type ZoneHint } from "@brain/core"
import { brainHome, writeJson, type Config, type State } from "./config"
import { claudeCliArgs, claudeCliOptions, cliFailure, findOnPath, parseCliOutput, runClaudeCli, unreadableFailure, type Failure } from "./distill"
import type { CheckpointCommit } from "./sources/types"

/** Pinned version: the allowlist below depends on the server's tool names. */
export const SCREENPIPE_MCP_PACKAGE = "screenpipe-mcp@0.20.3"

/** Tools the agent may call, all read-only (the server can also drive recording, write, etc.). */
export const SCREENPIPE_READ_TOOLS = ["activity-summary", "search-content", "keyword-search", "list-meetings", "get-meeting"]

/** Claude Code: built-in tools refused, on top of `--tools ""` (missing from old CLIs and on Windows via claude.cmd). */
const CLAUDE_BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"]
/** Codex: features turned off (shell, browser, apps, plugins); it keeps only the Screenpipe MCP. */
const CODEX_DISABLED_FEATURES = ["shell_tool", "apps", "browser_use", "in_app_browser", "computer_use", "plugins"]

/** Default model on the Claude side: Sonnet (the cheaper of the two that handle tools well), unless `agent_model`. */
export const CLAUDE_AGENT_MODEL = "sonnet"

/** Window looked at on each run: since the previous one, 15 min the first time, 60 min at most (waking from sleep). */
export const AGENT_WINDOW_MS = 15 * 60_000
export const AGENT_MAX_WINDOW_MS = 60 * 60_000
/** Below this, wait for the next run (manual syncs close together). */
export const AGENT_MIN_WINDOW_MS = 5 * 60_000
export const AGENT_TIMEOUT_MS = 5 * 60_000

export type AgentEngine = "claude" | "codex"
export const AGENT_ENGINE_LABELS: Record<AgentEngine, string> = { claude: "Claude Code", codex: "Codex" }

export type AgentWindow = { start: Date; end: Date }

/** Window to look at, or null if it is too short. `floor`: nothing earlier (when the scheduled sync was set up). */
export function agentWindow(state: State, now = new Date(), floor?: Date): AgentWindow | null {
  const end = now.getTime()
  const last = Date.parse(state.screenpipe?.agent_until ?? "")
  const start = Math.max(Number.isFinite(last) ? last : end - AGENT_WINDOW_MS, end - AGENT_MAX_WINDOW_MS, floor?.getTime() ?? -Infinity)
  if (end - start < AGENT_MIN_WINDOW_MS) return null
  return { start: new Date(start), end: new Date(end) }
}

/**
 * Who runs the agent: the one the config requires (`screenpipe_agent: "claude" | "codex"`), otherwise Claude Code
 * (unless disabled by use_claude_cli), otherwise Codex. Null: agent off, or neither CLI on the computer.
 */
export function pickAgentEngine(
  cfg: Partial<Pick<Config, "screenpipe_agent" | "use_claude_cli">>,
  find: (cmd: string) => string | null = (cmd) => findOnPath(cmd),
): { engine: AgentEngine; path: string } | null {
  const pref = cfg.screenpipe_agent
  if (pref === false) return null
  const claude = () => {
    const path = find("claude")
    return path ? { engine: "claude" as const, path } : null
  }
  const codex = () => {
    const path = find("codex")
    return path ? { engine: "codex" as const, path } : null
  }
  if (pref === "claude") return claude()
  if (pref === "codex") return codex()
  return (cfg.use_claude_cli !== false ? claude() : null) ?? codex()
}

/**
 * The Screenpipe MCP server as the agent launches it (without the token: each engine passes it its own way). npx is
 * taken next to the running Node.js (private copy outside the PATH included), and that Node.js goes first in the PATH
 * for npx's `#!/usr/bin/env node`.
 */
export function screenpipeMcpServer(
  cfg: Pick<Config, "screenpipe_url">,
  client: AgentEngine,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  pathEnv = process.env.PATH ?? "",
): { command: string; args: string[]; env: Record<string, string> } {
  const nodeDir = dirname(execPath)
  const sep = platform === "win32" ? ";" : delimiter
  const env: Record<string, string> = { SCREENPIPE_API_URL: cfg.screenpipe_url, SCREENPIPE_MCP_CLIENT: client, PATH: [nodeDir, pathEnv].filter(Boolean).join(sep) }
  const args = ["-y", SCREENPIPE_MCP_PACKAGE]
  if (platform === "win32") {
    const npx = join(nodeDir, "npx.cmd")
    return { command: "cmd", args: ["/c", existsSync(npx) ? npx : "npx", ...args], env }
  }
  const npx = join(nodeDir, "npx")
  return { command: existsSync(npx) ? npx : "npx", args, env }
}

/** `claude -p`: the distillation's arguments (model replaced if asked), plus only the Screenpipe MCP and its read tools. */
export function claudeAgentArgs(claudePath: string, mcpConfigFile: string, model?: string): string[] {
  const base = claudeCliArgs(claudePath)
  const m = base.indexOf("--model")
  if (model && m !== -1) base[m + 1] = model
  return [
    ...base,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
    "--allowedTools",
    SCREENPIPE_READ_TOOLS.map((t) => `mcp__screenpipe__${t}`).join(","),
    "--disallowedTools",
    CLAUDE_BUILTIN_TOOLS.join(","),
  ]
}

/**
 * `codex exec`: without the user's config (nor their other MCPs), no saved session, read-only sandbox, shell and browser
 * off, only the Screenpipe MCP and its read tools (approved up front), low reasoning effort. The Screenpipe token goes
 * through the environment (`env_vars`), never as an argument. Prompt on standard input (`-`), final answer in `outFile`.
 */
export function codexAgentArgs(server: { command: string; args: string[]; env: Record<string, string> }, dir: string, outFile: string, model?: string): string[] {
  // JSON strings and string arrays are also valid TOML.
  const toml = (v: unknown) => JSON.stringify(v)
  const env = `{${Object.entries(server.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`
  const mcp = (k: string, v: string) => ["-c", `mcp_servers.screenpipe.${k}=${v}`]
  return [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    dir,
    "-o",
    outFile,
    ...(model ? ["-m", model] : []),
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    'model_reasoning_effort="low"',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    ...mcp("command", toml(server.command)),
    ...mcp("args", toml(server.args)),
    ...mcp("env", env),
    ...mcp("env_vars", toml(["SCREENPIPE_LOCAL_API_KEY"])),
    ...mcp("enabled_tools", toml(SCREENPIPE_READ_TOOLS)),
    ...mcp("default_tools_approval_mode", toml("approve")),
    "-",
  ]
}

export type AgentResult =
  | { ok: true; id: string; window: AgentWindow; items: KnowledgeItemInput[]; personal: number; commit: CheckpointCommit }
  | ({ ok: false; window: AgentWindow } & Failure)

export async function runScreenpipeAgent(opts: {
  engine: AgentEngine
  path: string
  cfg: Config
  zones: ZoneHint[]
  fallbackZone: string
  window: AgentWindow
  who?: string
}): Promise<AgentResult> {
  const { window, cfg } = opts
  const start = window.start.toISOString()
  const end = window.end.toISOString()
  // Separate empty folder: the agent's session does not see ~/.company-brain (config, tokens).
  const dir = join(brainHome(), "agent")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const prompt = buildAgentPrompt({ zones: opts.zones, start, end, who: opts.who })
  const server = screenpipeMcpServer(cfg, opts.engine)

  let stdout: string
  if (opts.engine === "claude") {
    const mcpFile = join(dir, "mcp.json")
    const env = cfg.screenpipe_token ? { ...server.env, SCREENPIPE_LOCAL_API_KEY: cfg.screenpipe_token } : server.env
    writeJson(mcpFile, { mcpServers: { screenpipe: { ...server, env } } }, 0o600)
    const args = claudeAgentArgs(opts.path, mcpFile, cfg.agent_model ?? CLAUDE_AGENT_MODEL)
    const run = await runClaudeCli(opts.path, prompt, AGENT_TIMEOUT_MS, claudeCliOptions(cfg), { args, cwd: dir })
    const fail = cliFailure(run)
    if (fail) return { ok: false, window, ...fail }
    stdout = run.stdout
  } else {
    const outFile = join(dir, "codex-last-message.txt")
    rmSync(outFile, { force: true })
    const env: Record<string, string> = cfg.screenpipe_token ? { SCREENPIPE_LOCAL_API_KEY: cfg.screenpipe_token } : {}
    const run = await runClaudeCli(opts.path, prompt, AGENT_TIMEOUT_MS, {}, { args: codexAgentArgs(server, dir, outFile, cfg.agent_model), cwd: dir, env })
    if (run.error) return { ok: false, window, ...cliFailure(run)! }
    let last = ""
    try {
      last = readFileSync(outFile, "utf8")
    } catch {
      // no final answer
    }
    rmSync(outFile, { force: true })
    stdout = last
  }

  const id = `screenpipe-agent:${end}`
  const conv: Conversation = { id, tool: "agent", app: "Screenpipe", title: "Screenpipe agent", started_at: start, ended_at: end, messages: [] }
  const parsed = parseCliOutput(stdout, conv, opts.zones, opts.fallbackZone)
  if (!parsed) return { ok: false, window, ...unreadableFailure(stdout) }
  // Safety net after the model's judgment: knowledge that reads as personal is not sent.
  const items = parsed.filter((i) => !looksPersonal(`${i.title}\n${i.body}`))
  const commit: CheckpointCommit = {
    covers: [id],
    apply: (state) => {
      state.screenpipe ??= {}
      const prev = Date.parse(state.screenpipe.agent_until ?? "")
      if (!(prev >= window.end.getTime())) state.screenpipe.agent_until = end
    },
  }
  return { ok: true, id, window, items, personal: parsed.length - items.length, commit }
}
