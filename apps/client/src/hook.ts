// Claude Code hook (SessionStart, UserPromptSubmit, Stop): fast, silent, never breaks Claude Code.

import { appendFileSync } from "node:fs"
import { classifyZones, looksPersonal, promptFingerprint, redactText, truncate, type AgentEventInput } from "@brain/core"
import { BrainApi } from "./api"
import { firstName, zoneName } from "./cache"
import { loadCache, loadConfig, paths, type Cache } from "./config"
import { isBrainSetupText, maskOwnSecrets, ownSecrets } from "./secrets"

export const HOOK_GLOBAL_TIMEOUT_MS = 2500
export const HOOK_NETWORK_TIMEOUT_MS = 1500

export type HookInput = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  prompt?: string
  source?: string
}

function logHookError(err: unknown) {
  try {
    appendFileSync(paths.log(), `[${new Date().toISOString()}] hook: ${(err as Error)?.message ?? String(err)}\n`)
  } catch {
    // never mind
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("")
    let data = ""
    const finish = () => {
      clearTimeout(timer)
      process.stdin.removeAllListeners()
      process.stdin.pause()
      resolve(data)
    }
    const timer = setTimeout(finish, timeoutMs)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => (data += d))
    process.stdin.on("end", finish)
    process.stdin.on("error", finish)
  })
}

/** The context line injected by SessionStart into the Claude Code session. */
export function sessionStartLine(cache: Cache | null): string {
  const who = cache?.whoami
  const zones = who?.readable?.length ? who.readable.map((z) => zoneName(cache, z)).join(", ") : "none for now"
  const org = who?.org ? ` for ${who.org}` : ""
  const access = who ? ` (${firstName(who.name)} can read the zones: ${zones})` : ""
  return (
    `Company brain${org} connected${access}. ` +
    `For any company context (decisions, procedures, customers, projects, tools, who does what), ` +
    `use the search_brain MCP tool of the company-brain server before guessing; remember to record an important decision or procedure in it.`
  )
}

export type HookOptions = {
  /** `share_prompt_summaries` from the config: false → never a prompt summary. */
  shareSummaries?: boolean
  /** The computer's secrets (brain token…), redacted and a sign of an install session. */
  secrets?: string[]
}

/**
 * Builds the event to send, or null if the event is ignored.
 * UserPromptSubmit: the summary (160 redacted characters) is only sent if the prompt relates to at least one zone
 * and has nothing personal; otherwise the event goes without a summary (fingerprint only, or nothing for a personal prompt).
 */
export function eventForHook(input: HookInput, cache: Cache | null, opts: HookOptions = {}): AgentEventInput | null {
  const session_id = input.session_id ? String(input.session_id).slice(0, 200) : undefined
  switch (input.hook_event_name) {
    case "SessionStart":
      return { agent: "claude-code", type: "started", session_id }
    case "Stop":
      return { agent: "claude-code", type: "stopped", session_id }
    case "UserPromptSubmit": {
      const prompt = (input.prompt ?? "").trim()
      if (!prompt) return null
      const secrets = opts.secrets ?? []
      // Install prompt or pasted token: we only report the activity.
      if (isBrainSetupText(prompt, secrets) || maskOwnSecrets(prompt, secrets).count > 0) return { agent: "claude-code", type: "query", zones: [], session_id }
      // Personal content: no zone, no fingerprint, no summary.
      if (looksPersonal(prompt)) return { agent: "claude-code", type: "query", zones: [], session_id }
      const zones = cache?.zones?.length ? classifyZones(prompt, cache.zones, 2) : []
      const event: AgentEventInput = { agent: "claude-code", type: "query", zones, fingerprint: promptFingerprint(prompt), session_id }
      if (opts.shareSummaries !== false && zones.length > 0) event.summary = truncate(redactText(prompt, { literals: secrets }).replace(/\s+/g, " "), 160)
      return event
    }
    default:
      return null
  }
}

async function hookMain(): Promise<void> {
  const raw = await readStdin(800)
  let input: HookInput = {}
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {}
  } catch {
    return
  }
  const cfg = loadConfig()
  const cache = loadCache()
  // SessionStart: stdout is injected into Claude Code's context → a single line.
  if (input.hook_event_name === "SessionStart" && cfg) process.stdout.write(sessionStartLine(cache) + "\n")
  const event = eventForHook(input, cache, { shareSummaries: cfg?.share_prompt_summaries !== false, secrets: ownSecrets(cfg) })
  if (!cfg || !event) return
  await new BrainApi(cfg.url, cfg.token, HOOK_NETWORK_TIMEOUT_MS).events([event], HOOK_NETWORK_TIMEOUT_MS)
}

function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve()
    process.stdout.write("", () => resolve())
  })
}

/** `brain.mjs hook` entry point: always exits with code 0. */
export async function runHook(): Promise<never> {
  if (process.env.COMPANY_BRAIN_INTERNAL === "1") process.exit(0)
  const hard = setTimeout(() => process.exit(0), HOOK_GLOBAL_TIMEOUT_MS)
  hard.unref()
  try {
    await hookMain()
  } catch (err) {
    logHookError(err)
  }
  await flushStdout()
  process.exit(0)
}
