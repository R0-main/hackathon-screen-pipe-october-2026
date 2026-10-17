// Choosing the distiller: Claude SDK (API key) → `claude -p` CLI → heuristic without an LLM.
// The heuristic is only used if no LLM is available: an LLM failure leaves the conversation for later.

import { AsyncLocalStorage } from "node:async_hooks"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import {
  ENTITY_TYPES,
  KnowledgeItemInputSchema,
  buildCliExtractionPrompt,
  classifyZones,
  distillHeuristic,
  redactText,
  truncate,
  type Conversation,
  type KnowledgeItemInput,
  type ZoneHint,
} from "@brain/core"
import { UserError, brainHome, selfCommand, type Config } from "./config"

export type DistillerKind = "claude-api" | "claude-cli" | "heuristic"

export const DISTILLER_LABELS: Record<DistillerKind, string> = {
  "claude-api": "Claude (Anthropic API)",
  "claude-cli": "Local Claude Code (`claude -p`)",
  heuristic: "local heuristic (no LLM)",
}

/**
 * Nature of an LLM failure. `auth`: Claude is no longer signed in (expired or revoked token, "Please run /login", key
 * refused); `outage`: computer or service outage (CLI not found, network, subscription limit or quotas,
 * overload). Those two affect every conversation: no attempt is counted. `conversation`: failure on
 * this entry (refusal, unreadable output, timeout, unknown error), counted for it.
 */
export type FailureKind = "auth" | "outage" | "conversation"

/**
 * `failed`: the LLM gave nothing usable. No item is produced and the conversation is not marked as
 * processed: it will be distilled again on the next sync (never by the heuristic).
 * `signature`: for a failure without an answer from the model (timeout, unknown error), something to recognize "every call
 * fails the same way". Such a failure proves nothing about the conversation on its own. Missing when the model
 * answered (refusal, unreadable output): the failure is down to the conversation.
 */
export type DistillResult = {
  items: KnowledgeItemInput[]
  used: DistillerKind
  error?: string
  failed?: boolean
  failure?: FailureKind
  signature?: string
}

export type Failure = { error: string; failure: FailureKind; signature?: string }

// Error patterns of the CLI or the API. On a model answer, they only serve to judge it inconclusive (see
// unreadableFailure), never to turn it into an outage. Simple alternatives, bounded quantifiers: linear time.
const AUTH_FAILURE =
  /please run \/login|\/login\b|not logged in|oauth token|token (?:has )?expired|token (?:has been |was )?revoked|authentication_error|authentication failed|failed to authenticate|invalid api key|invalid bearer token|invalid x-api-key|unauthori[sz]ed|(?:api error|status|http)\W{0,3}401\b/i
// Subscription limits of the current CLI: "You've hit your session limit · resets 3pm" (weekly, Opus…),
// "Session limit reached", "5-hour limit reached", "You're out of usage credits", "Your org is out of usage".
const OUTAGE_FAILURE =
  /\b(?:ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|fetch failed|connection error|network error|socket hang up|overloaded|(?:session|weekly|opus|usage|hour|spend|rate)[ _-]?limit|(?:hit|reached) your [\w'’ -]{0,30}limit|out of usage|credit balance|quota|permission_error|(?:api error|status|http)\W{0,3}(?:403|429|5\d\d)\b/i

/** Classifies an error message from the `claude` CLI or the API: lost sign-in, general outage, or specific to the request. */
export function classifyFailure(text: string): FailureKind {
  if (AUTH_FAILURE.test(text)) return "auth"
  if (OUTAGE_FAILURE.test(text)) return "outage"
  return "conversation"
}

/**
 * HTTP status of the API error that ended a `claude -p` (numeric `api_error_status` field of the JSON envelope):
 * 401/403 → lost sign-in; 429, 529 and 5xx → outage (subscription limit, overload). Otherwise null: the text is read.
 */
export function statusFailure(status: unknown): FailureKind | null {
  if (typeof status !== "number") return null
  if (status === 401 || status === 403) return "auth"
  if (status === 429 || (status >= 500 && status <= 599)) return "outage"
  return null
}

/** Claude Code is no longer signed in: what to do (shown by sync and refresh-status). */
export function claudeAuthHelp(detail?: string): string {
  return (
    `Claude Code is no longer signed in on this computer: the Claude token has expired or was revoked${detail ? ` ("${truncate(detail, 160)}")` : ""}. ` +
    `Run \`claude setup-token\`, then \`${selfCommand()} init --claude-token <token>\` (or \`claude /login\`).`
  )
}

/** API key refused (distillation through the SDK). */
export function apiAuthHelp(detail?: string): string {
  return `Anthropic API key refused${detail ? ` ("${truncate(detail, 160)}")` : ""}: check it, or replace it with \`init --anthropic-key <key>\`.`
}

export type Distiller = {
  kind: DistillerKind
  concurrency: number
  distill(conv: Conversation, zones: ZoneHint[], fallbackZone: string): Promise<DistillResult>
}

/**
 * How to run `cmd`: on Windows, a .cmd / .bat (npm, npx, claude installed by npm) only starts through the shell,
 * which quotes nothing itself (paths with spaces: "C:\Users\Jane Doe\…"); an .exe starts directly, without a
 * shell, empty arguments included. Elsewhere, never a shell.
 */
export function spawnTarget(cmd: string, args: string[], platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; shell: boolean } {
  const shell = platform === "win32" && /\.(cmd|bat)$/i.test(cmd)
  if (!shell) return { cmd, args, shell }
  const q = (s: string) => (s === "" || /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return { cmd: q(cmd), args: args.map(q), shell }
}

/** Looks for an executable in the PATH (handles PATHEXT on Windows). */
export function findOnPath(cmd: string, pathEnv = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat([""]) : [""]
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase())
      try {
        if (!statSync(p).isFile()) continue
        if (process.platform !== "win32") accessSync(p, constants.X_OK)
        return p
      } catch {
        // next
      }
    }
  }
  return null
}

export function apiKey(cfg: Pick<Config, "anthropic_api_key">): string | undefined {
  return cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY || undefined
}

/** Which distiller would be used, and why. */
export function pickDistiller(cfg: Pick<Config, "anthropic_api_key" | "use_claude_cli">, force?: DistillerKind): { kind: DistillerKind; reason: string; claudePath?: string } {
  const claudePath = findOnPath("claude") ?? undefined
  if (force === "heuristic") return { kind: "heuristic", reason: "forced by --distiller" }
  if (force === "claude-api") return { kind: "claude-api", reason: "forced by --distiller" }
  if (force === "claude-cli") return { kind: "claude-cli", reason: "forced by --distiller", claudePath }
  if (apiKey(cfg)) return { kind: "claude-api", reason: cfg.anthropic_api_key ? "API key in the config" : "ANTHROPIC_API_KEY set" }
  if (cfg.use_claude_cli !== false && claudePath) return { kind: "claude-cli", reason: `CLI found (${claudePath})`, claudePath }
  return {
    kind: "heuristic",
    reason: cfg.use_claude_cli === false ? "Claude CLI disabled (use_claude_cli: false) and no API key" : "neither an API key nor a `claude` CLI in the PATH",
  }
}

/** Extracts the first JSON object of a text (tolerates code blocks and text around it). */
export function extractJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, "").trim()
  try {
    return JSON.parse(t)
  } catch {
    // we look for the widest object
  }
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Validates and completes the items returned by an LLM (source, known zone, bounds). */
export function normalizeItems(raw: unknown, conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : []
  const zoneIds = new Set(zones.map((z) => z.id))
  const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, ...(conv.screenpipe_ref ? { screenpipe_ref: conv.screenpipe_ref } : {}) }
  const out: KnowledgeItemInput[] = []
  for (const r of list.slice(0, 6)) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const title = typeof o.title === "string" ? truncate(o.title.trim(), 140) : ""
    const body = typeof o.body === "string" ? truncate(o.body.trim(), 2000) : ""
    const zone = typeof o.zone === "string" && zoneIds.has(o.zone) ? o.zone : (classifyZones(`${title} ${body}`, zones, 1)[0] ?? fallbackZone)
    const entities = (Array.isArray(o.entities) ? (o.entities as { type?: unknown; name?: unknown }[]) : [])
      .filter((e) => e && (ENTITY_TYPES as readonly unknown[]).includes(e.type) && typeof e.name === "string" && e.name.trim())
      .map((e) => ({ type: e.type, name: truncate(String(e.name).trim(), 120) }))
      .slice(0, 10)
    const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.6
    const parsed = KnowledgeItemInputSchema.safeParse({ zone, kind: o.kind, title, body, entities, source, confidence })
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Parses the output of `claude -p --output-format json` ({ result: "…" }). */
export function parseCliOutput(stdout: string, conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] | null {
  const envelope = extractJsonObject(stdout) as { result?: unknown; is_error?: boolean } | null
  if (!envelope || envelope.is_error) return null
  const inner = typeof envelope.result === "string" ? extractJsonObject(envelope.result) : "items" in envelope ? envelope : null
  if (!inner || typeof inner !== "object") return null
  return normalizeItems(inner, conv, zones, fallbackZone)
}

/** Result of a `claude -p`: standard output, or an error (cannot start, timeout, non-zero exit code). */
export type ClaudeCliRun = { stdout: string; error?: string; failure?: FailureKind; signature?: string }

type CliEnvelope = { result?: unknown; is_error?: unknown; api_error_status?: unknown }

function cliEnvelope(stdout: string): CliEnvelope | null {
  const e = extractJsonObject(stdout)
  return e && typeof e === "object" ? (e as CliEnvelope) : null
}

/** Readable error text of a CLI that failed: stderr, otherwise the `result` field of the JSON envelope, otherwise stdout. */
function cliErrorText(stdout: string, stderr: string, envelope: CliEnvelope | null): string {
  if (stderr.trim()) return stderr.trim()
  return typeof envelope?.result === "string" ? envelope.result.trim() : stdout.trim()
}

/**
 * Failure of a `claude -p` (process, timeout, or `is_error` envelope with code 0), or null if the CLI answered.
 * A model answer that is not usable JSON is not handled here (it is a failure specific to the entry).
 */
export function cliFailure(run: ClaudeCliRun): Failure | null {
  if (run.error) return { error: run.error, failure: run.failure ?? classifyFailure(run.error), ...(run.signature ? { signature: run.signature } : {}) }
  const envelope = cliEnvelope(run.stdout)
  if (envelope?.is_error !== true) return null
  const text = typeof envelope.result === "string" && envelope.result.trim() ? envelope.result.trim() : "error without details"
  const failure = statusFailure(envelope.api_error_status) ?? classifyFailure(text)
  const error = truncate(text, 200)
  return failure === "conversation" ? { error, failure, signature: truncate(text, 160) } : { error, failure }
}

let cliFlags: string[] | null = null

/** Optional options depending on the CLI version: no saved session, no tools. */
function detectCliFlags(claudePath: string): string[] {
  if (cliFlags) return cliFlags
  const t = spawnTarget(claudePath, ["--help"])
  const help = spawnSync(t.cmd, t.args, { encoding: "utf8", timeout: 8000, shell: t.shell, windowsHide: true, env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`
  cliFlags = []
  if (text.includes("--no-session-persistence")) cliFlags.push("--no-session-persistence")
  // `--tools ""` (no tools): not through the Windows shell (claude.cmd), which would lose the empty argument.
  if (/--tools\b/.test(text) && !t.shell) cliFlags.push("--tools", "")
  // Never `--bare`: that mode ignores CLAUDE_CODE_OAUTH_TOKEN (the token from `init --claude-token`), even if the CLI offers it.
  return cliFlags
}

/** Arguments of each `claude -p` (exported for the tests: never `--bare`). */
export function claudeCliArgs(claudePath: string): string[] {
  return ["-p", "--output-format", "json", "--model", "sonnet", ...detectCliFlags(claudePath)].filter((a) => a !== "--bare")
}

export type ClaudeCliOptions = {
  /** Long-lived token (`claude setup-token`, config claude_oauth_token): passed as CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken?: string
}

/**
 * Environment of each `claude -p`: session marked internal (our hooks ignore it), Claude Code token if configured.
 * CLAUDE_CODE_SIMPLE is removed: it is the equivalent of `--bare`, which ignores CLAUDE_CODE_OAUTH_TOKEN. It is inherited
 * when brain.mjs runs from a `claude --bare` session (Claude Code's Bash tool, install prompt).
 */
export function claudeCliEnv(opts: ClaudeCliOptions = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COMPANY_BRAIN_INTERNAL: "1" }
  delete env.CLAUDE_CODE_SIMPLE
  const token = opts.oauthToken?.trim()
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

/** `claude -p` options taken from the config. */
export function claudeCliOptions(cfg: Partial<Pick<Config, "claude_oauth_token">> | null | undefined): ClaudeCliOptions {
  return cfg?.claude_oauth_token ? { oauthToken: cfg.claude_oauth_token } : {}
}

/** Never lets the Claude Code token appear in an error message. */
function hideToken(s: string, opts: ClaudeCliOptions): string {
  const t = opts.oauthToken?.trim()
  return t && t.length >= 8 ? s.split(t).join("[token redacted]") : s
}

export function runClaudeCli(claudePath: string, prompt: string, timeoutMs = 120_000, opts: ClaudeCliOptions = {}): Promise<ClaudeCliRun> {
  return new Promise((resolve) => {
    const t = spawnTarget(claudePath, claudeCliArgs(claudePath))
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (r: ClaudeCliRun) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r.error ? { ...r, error: hideToken(r.error, opts) } : r)
    }
    let child
    try {
      child = spawn(t.cmd, t.args, {
        cwd: brainHome(),
        env: claudeCliEnv(opts),
        stdio: ["pipe", "pipe", "pipe"],
        shell: t.shell,
        windowsHide: true,
      })
    } catch (err) {
      done({ stdout: "", error: `cannot start \`claude\`: ${(err as Error).message}`, failure: "outage" })
      return
    }
    timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Timeout: specific to this entry, unless every call of the sync ends the same way (outage).
      done({ stdout, error: `timeout of ${Math.round(timeoutMs / 1000)} s exceeded`, failure: "conversation", signature: "timeout" })
    }, timeoutMs)
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.on("error", (err) => done({ stdout, error: `cannot start \`claude\`: ${err.message}`, failure: "outage" }))
    child.on("close", (code) => {
      if (code === 0) return done({ stdout })
      const envelope = cliEnvelope(stdout)
      const text = cliErrorText(stdout, stderr, envelope)
      // Classified on the envelope's HTTP status if there is one, otherwise on the error text (stderr, `result` field),
      // never on the raw envelope (durations, tokens…).
      const failure = statusFailure(envelope?.api_error_status) ?? classifyFailure(`${stderr}\n${text}`)
      const error = `code ${code}${text ? `: ${truncate(text, 200)}` : ""}`
      done(failure === "conversation" ? { stdout, error, failure, signature: truncate(hideToken(text, opts), 160) || `code ${code}` } : { stdout, error, failure })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

/**
 * `claude -p` output without usable JSON. Usually the model answered (refusal, prose): failure specific to the
 * conversation. But an empty output, or a short text that reads like a CLI error (subscription limit,
 * sign-in…), proves nothing about the conversation: treated as an unknown error (with a signature), never as
 * an outage, so that a real answer that talks about "rate limit" does not block the queue.
 */
export function unreadableFailure(stdout: string): Failure {
  const envelope = cliEnvelope(stdout)
  const text = (typeof envelope?.result === "string" ? envelope.result : envelope ? "" : stdout).trim()
  // Nothing at all: the model did not answer, that proves nothing either.
  if (!text) return { error: "empty `claude -p` output", failure: "conversation", signature: "empty output" }
  if (text.length <= 300 && classifyFailure(text) !== "conversation") return { error: `unexpected answer from \`claude -p\`: ${truncate(text, 160)}`, failure: "conversation", signature: truncate(text, 160) }
  return { error: "unreadable `claude -p` output: refusal or answer out of format", failure: "conversation" }
}

function heuristic(conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] {
  return distillHeuristic(conv, zones, fallbackZone)
}

type HttpTrace = { status?: number; body?: string; network?: string; thrown?: string }
const httpTrace = new AsyncLocalStorage<HttpTrace>()

/** Anthropic SDK fetch: records, for the call in progress (AsyncLocalStorage), the last HTTP status or the network error. */
const tracedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const trace = httpTrace.getStore()
  try {
    const res = await fetch(input, init)
    if (trace) {
      trace.status = res.status
      trace.network = undefined
      trace.body = res.ok ? undefined : await res.clone().text().then((t) => t.slice(0, 400), () => "")
    }
    return res
  } catch (err) {
    if (trace) trace.network = (err as Error).message
    throw err
  }
}

/** Failure of a distillation through the API, from the last HTTP call. */
export function apiFailure(trace: { status?: number; body?: string; network?: string; thrown?: string }): Failure {
  if (trace.network) return { error: `Anthropic API unreachable: ${truncate(trace.network, 160)}`, failure: "outage" }
  const s = trace.status
  if (s === undefined) return { error: `no answer from the API${trace.thrown ? `: ${truncate(trace.thrown, 160)}` : ""}`, failure: "conversation", signature: "no answer" }
  // The model answered (refusal, output out of schema): Claude works, the failure is down to this conversation.
  if (s >= 200 && s < 300) return { error: "Claude answer empty, refused or out of format", failure: "conversation" }
  const detail = `HTTP ${s}${trace.body ? ` ${truncate(trace.body.replace(/\s+/g, " "), 160)}` : ""}`
  if (s === 401) return { error: `Anthropic API: ${detail}`, failure: "auth" }
  if (s === 403 || s === 408 || s === 429 || s >= 500) return { error: `Anthropic API: ${detail}`, failure: "outage" }
  const failure = classifyFailure(trace.body ?? "")
  return failure === "conversation" ? { error: `Anthropic API: ${detail}`, failure, signature: `HTTP ${s}` } : { error: `Anthropic API: ${detail}`, failure }
}

export async function createDistiller(cfg: Config, force?: DistillerKind): Promise<Distiller & { reason: string }> {
  const pick = pickDistiller(cfg, force)
  if (pick.kind === "claude-api") {
    const key = apiKey(cfg)
    if (key || process.env.ANTHROPIC_AUTH_TOKEN) {
      const { distillWithClaude } = await import("@brain/core/claude")
      const { default: Anthropic } = await import("@anthropic-ai/sdk")
      // HTTP status of each call (through an instrumented fetch): tells apart a refused key, an outage and a model refusal.
      const client = new Anthropic({ ...(key ? { apiKey: key } : {}), fetch: tracedFetch })
      return {
        kind: "claude-api",
        reason: pick.reason,
        concurrency: 3,
        async distill(conv, zones, fallbackZone) {
          const trace: HttpTrace = {}
          try {
            const items = await httpTrace.run(trace, () => distillWithClaude(client, conv, zones, fallbackZone))
            if (items) return { items: normalizeItems(items, conv, zones, fallbackZone), used: "claude-api" }
          } catch (err) {
            trace.thrown = (err as Error).message
          }
          return { items: [], used: "claude-api", failed: true, ...apiFailure(trace) }
        },
      }
    }
    if (force === "claude-api") throw new UserError("--distiller claude-api: no API key (init --anthropic-key <key> or ANTHROPIC_API_KEY).")
  }
  if (pick.kind === "claude-cli" && pick.claudePath) {
    const claudePath = pick.claudePath
    const cliOpts = claudeCliOptions(cfg)
    return {
      kind: "claude-cli",
      reason: pick.reason + (cliOpts.oauthToken ? ", Claude Code token from the config" : ""),
      concurrency: 2,
      async distill(conv, zones, fallbackZone) {
        const run = await runClaudeCli(claudePath, buildCliExtractionPrompt(conv, zones), 120_000, cliOpts)
        const fail = cliFailure(run)
        if (fail) return { items: [], used: "claude-cli", failed: true, ...fail }
        const items = parseCliOutput(run.stdout, conv, zones, fallbackZone)
        if (items) return { items, used: "claude-cli" }
        return { items: [], used: "claude-cli", failed: true, ...unreadableFailure(run.stdout) }
      },
    }
  }
  if (force === "claude-cli") throw new UserError("--distiller claude-cli: `claude` CLI not found in the PATH.")
  return {
    kind: "heuristic",
    reason: pick.kind === "heuristic" ? pick.reason : `${DISTILLER_LABELS[pick.kind]} unavailable`,
    concurrency: 8,
    async distill(conv, zones, fallbackZone) {
      return { items: heuristic(conv, zones, fallbackZone), used: "heuristic" }
    },
  }
}

/**
 * Last safety net before sending: redacted again (with the computer's secrets, taken as is) and contract validation.
 * `seen`: deduplication shared between calls.
 */
export function finalizeItems(items: KnowledgeItemInput[], seen = new Set<string>(), literals: string[] = []): KnowledgeItemInput[] {
  const out: KnowledgeItemInput[] = []
  for (const i of items) {
    const parsed = KnowledgeItemInputSchema.safeParse({ ...i, title: redactText(i.title, { literals }), body: redactText(i.body, { literals }) })
    if (!parsed.success) continue
    const key = `${parsed.data.zone}:${parsed.data.kind}:${parsed.data.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed.data)
  }
  return out
}
