// `connect-claude`: the computer's long-lived Claude Code token, asked for at install. `claude setup-token` opens the
// sign-in in the browser and shows the token; it is pasted here (hidden input), tried, then stored in config.json
// (mode 600). The scheduled sync (every 15 min, with no session open) passes it to each `claude -p`: distillation,
// Screenpipe agent and, on an admin's computer, the moderator. It never leaves the computer.

import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { UserError, loadPartialConfig, maskSecret, saveConfig } from "./config"
import { claudeAuthHelp, cliFailure, findOnPath, runClaudeCli, spawnTarget } from "./distill"

type Log = (s: string) => void

/** A token from `claude setup-token` (sk-ant-oat01-…). */
export const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,300}$/

/** Hidden input in the terminal (nothing is shown while pasting). */
function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (s: string) => void }
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s)
    }
    rl.question(question, (answer) => {
      process.stdout.write("\n")
      rl.close()
      resolve(answer.trim())
    })
  })
}

export type ConnectDeps = {
  isTTY?: boolean
  claudePath?: string | null
  /** Runs `claude setup-token` in the terminal (sign-in in the browser). */
  runSetupToken?: (claudePath: string) => boolean
  readToken?: () => Promise<string>
}

/** True if the computer can already run Claude with no session open (saved token, or API key). */
export function hasScheduledClaude(cfg = loadPartialConfig()): boolean {
  return Boolean(cfg.claude_oauth_token || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY)
}

/** `brain.mjs connect-claude`: the computer's Claude Code token, asked for once, tried, saved. Code 0 if saved. */
export async function cmdConnectClaude(log: Log = console.log, deps: ConnectDeps = {}): Promise<number> {
  const claudePath = deps.claudePath !== undefined ? deps.claudePath : findOnPath("claude")
  if (!claudePath) throw new UserError("`claude` CLI not found: install Claude Code (`npm install -g @anthropic-ai/claude-code`), then rerun connect-claude.")
  if (!(deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new UserError("connect-claude runs in a terminal: sign in to Claude in the browser, then paste the token shown.")
  }
  log("Signing in to Claude: the browser will open. Once signed in, copy the token shown (sk-ant-oat01-…).")
  const ran = (
    deps.runSetupToken ??
    ((p) => {
      const t = spawnTarget(p, ["setup-token"])
      return spawnSync(t.cmd, t.args, { stdio: "inherit", shell: t.shell }).status === 0
    })
  )(claudePath)
  if (!ran) log("`claude setup-token` did not finish normally: if a token was shown, paste it anyway.")
  const token = await (deps.readToken ?? (() => readHidden("Paste the token here (nothing is shown): ")))()
  if (!CLAUDE_TOKEN_RE.test(token)) throw new UserError("This is not a `claude setup-token` token (it starts with \"sk-ant-oat\"). Rerun connect-claude.")

  log("Trying the token…")
  const run = await runClaudeCli(claudePath, "Answer only OK.", 60_000, { oauthToken: token })
  const fail = cliFailure(run)
  if (fail?.failure === "auth") throw new UserError(`${claudeAuthHelp(fail.error)} The token was not saved.`)
  if (fail) log(`Claude could not be reached for the test (${fail.error}): the token is saved anyway.`)

  saveConfig({ ...loadPartialConfig(), claude_oauth_token: token })
  log(`Claude Code token saved (${maskSecret(token)}): the 15-min sync uses it, even with no session open. It stays on this computer.`)
  return 0
}
