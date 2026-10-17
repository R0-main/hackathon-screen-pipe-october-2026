// "Codex CLI logs" source: ~/.codex/sessions/**/*.jsonl. Tolerant parser (several known formats).

import { statSync } from "node:fs"
import { basename, join } from "node:path"
import { DISTILL_MARKER, type Conversation, type ConversationMessage } from "@brain/core"
import type { FileCheckpoint, State } from "../config"
import { isBrainSetupText } from "../secrets"
import { TURN_IDLE_MS } from "./claude-logs"
import { asString, listJsonlFiles, readNewLines, toIso } from "./jsonl"
import { buildConversation, type SourceResult } from "./types"

const NOISE_PREFIXES = ["<environment_context>", "<user_instructions>", "<permissions", "# AGENTS.md instructions", "<INSTRUCTIONS>", "<user_shell_command>", "<turn_aborted>"]

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (typeof b === "string") return b
      if (b && typeof b === "object") {
        const o = b as { type?: unknown; text?: unknown }
        if (typeof o.text === "string" && (o.type === undefined || /text/.test(String(o.type)))) return o.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function cleanText(s: string): string {
  const t = s.trim()
  if (!t || NOISE_PREFIXES.some((p) => t.startsWith(p))) return ""
  return t
}

type Parsed = { role: "user" | "assistant"; text: string; at?: string }

/** One line → message (`response_item` format, historical `{type:"message"}` format or any line with role + content). */
export function parseCodexLine(j: Record<string, unknown>): { msg?: Parsed; event?: Parsed; cwd?: string; sessionId?: string } {
  const at = toIso(j.timestamp)
  const payload = (j.payload && typeof j.payload === "object" ? j.payload : null) as Record<string, unknown> | null
  if (j.type === "session_meta" && payload) return { sessionId: asString(payload.id), cwd: asString(payload.cwd) }
  if (j.type === "turn_context" && payload) return { cwd: asString(payload.cwd) }
  if (j.type === "event_msg" && payload) {
    // Duplicates of response_item: only used if the file has nothing else.
    const text = cleanText(asString(payload.message) ?? "")
    if (!text) return {}
    if (payload.type === "user_message") return { event: { role: "user", text, at } }
    if (payload.type === "agent_message") return { event: { role: "assistant", text, at } }
    return {}
  }
  const m = (j.type === "response_item" && payload ? payload : j) as Record<string, unknown>
  if (m.type !== undefined && m.type !== "message") return {}
  const role = m.role
  if (role !== "user" && role !== "assistant") return {}
  const text = cleanText(contentText(m.content))
  if (!text) return {}
  return { msg: { role, text, at: at ?? toIso(m.timestamp) } }
}

export function parseCodexLines(lines: Record<string, unknown>[], opts: { fallbackId: string; since?: Date; secrets?: string[] }): { conversation: Conversation | null; internal: boolean } {
  const msgs: ConversationMessage[] = []
  const events: ConversationMessage[] = []
  let cwd: string | undefined
  let internal = false
  const sinceMs = opts.since?.getTime()
  for (const j of lines) {
    const p = parseCodexLine(j)
    if (p.cwd) cwd = p.cwd
    for (const [list, m] of [[msgs, p.msg], [events, p.event]] as const) {
      if (!m) continue
      // Our own calls, or the brain's install session (token in clear text): ignored.
      if (m.text.includes(DISTILL_MARKER) || isBrainSetupText(m.text, opts.secrets)) internal = true
      if (sinceMs !== undefined && m.at && Date.parse(m.at) < sinceMs) continue
      list.push(m)
    }
  }
  if (internal) return { conversation: null, internal }
  const chosen = msgs.length ? msgs : events
  return { conversation: buildConversation({ id: opts.fallbackId, tool: "codex", app: "Codex", cwd }, chosen), internal }
}

/** Session id stable between two reads: the UUID of the file name (rollout-…-<uuid>.jsonl). */
export function codexSessionId(file: string): string {
  const name = basename(file, ".jsonl")
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return `codex:${m ? m[0] : name}`
}

/** Codex events that mark the end of a turn (depending on the CLI version). */
const TURN_END_EVENTS = new Set(["task_complete", "turn_complete", "turn_aborted", "task_aborted"])
/** Elements showing the agent is still working (tool called, result, reasoning). */
const WORK_ITEMS = /^(?:function_call|function_call_output|custom_tool_call|custom_tool_call_output|local_shell_call|local_shell_call_output|web_search_call|tool_call|tool_call_output|reasoning)$/

function payloadOf(j: Record<string, unknown>): Record<string, unknown> {
  return (j.payload && typeof j.payload === "object" ? j.payload : {}) as Record<string, unknown>
}

/** End of turn: task_complete event, turn_aborted…, or its trace in the history ("<turn_aborted>" message). */
function isTurnEnd(j: Record<string, unknown>): boolean {
  if (j.type === "event_msg") return TURN_END_EVENTS.has(String(payloadOf(j).type))
  const m = j.type === "response_item" ? payloadOf(j) : j
  return m.role === "user" && contentText(m.content).trimStart().startsWith("<turn_aborted>")
}

function isWork(j: Record<string, unknown>): boolean {
  const item = j.type === "response_item" ? payloadOf(j) : j
  return typeof item.type === "string" && WORK_ITEMS.test(item.type)
}

/**
 * Number of lines to process now (same rule as for Claude Code): everything, except the last turn if it is not
 * finished (no answer from the agent yet, or the agent still calls a tool) and still active for less than `idleMs`.
 * An end-of-turn event (task_complete…) closes the turn no matter what.
 */
export function completeCodexLineCount(lines: Record<string, unknown>[], now = Date.now(), idleMs = TURN_IDLE_MS): number {
  // Start of the last turn: the first line of the last run of user messages (response_item + its event_msg
  // duplicate). Only an agent answer or an end of turn breaks the run: after a turn interrupted without an answer
  // (q1, turn_aborted, q2), the turn in progress starts at q2 and q1's end of turn does not close it; a message added
  // while the agent works (q1, tool, q2) stays in q1's turn, kept in full until its answer.
  let turnStart = -1
  let inUserRun = false
  for (let i = 0; i < lines.length; i++) {
    const j = lines[i]
    if (isTurnEnd(j)) {
      inUserRun = false
      continue
    }
    const p = parseCodexLine(j)
    const m = p.msg ?? p.event
    if (!m) continue
    if (m.role === "user" && !inUserRun) turnStart = i
    inUserRun = m.role === "user"
  }
  if (turnStart === -1) return lines.length
  let answered = false
  let lastActivity = -Infinity
  for (let i = turnStart; i < lines.length; i++) {
    const j = lines[i]
    const t = Date.parse(String(j.timestamp ?? ""))
    if (Number.isFinite(t) && t > lastActivity) lastActivity = t
    if (isTurnEnd(j)) return lines.length
    if (isWork(j)) {
      answered = false
      continue
    }
    const p = parseCodexLine(j)
    if ((p.msg ?? p.event)?.role === "assistant") answered = true
  }
  if (answered) return lines.length
  // Abandoned turn (or format without timestamps): processed as is.
  if (lastActivity === -Infinity || now - lastActivity >= idleMs) return lines.length
  return turnStart
}

/**
 * `since` applies to files never read; to the others only if `explicitSince`. `floor` (install-schedule):
 * no earlier message, even in a file already followed. A turn in progress is left for the next pass.
 */
export function readCodexLogs(opts: {
  dir: string
  state: State
  since: Date
  explicitSince?: boolean
  reset?: boolean
  secrets?: string[]
  floor?: Date
  now?: number
  idleMs?: number
}): SourceResult {
  const root = join(opts.dir, "sessions")
  const result: SourceResult = { source: "codex", available: true, conversations: [], commits: [], warnings: [], stats: { files: 0, bytes: 0, pending: 0 } }
  const now = opts.now ?? Date.now()
  const files = listJsonlFiles(root)
  if (files.length === 0) {
    result.available = false
    return result
  }
  const known = opts.reset ? {} : (opts.state.codex?.files ?? {})
  for (const file of files) {
    const prev = known[file]
    if (!prev) {
      try {
        const st = statSync(file)
        if (st.mtimeMs < opts.since.getTime()) {
          const cp: FileCheckpoint = { offset: st.size, size: st.size, mtime: Math.round(st.mtimeMs) }
          result.commits.push({ covers: [], apply: (s) => setFile(s, file, cp) })
          continue
        }
      } catch {
        continue
      }
    }
    const chunk = readNewLines(file, prev)
    if (!chunk || (chunk.bytesRead === 0 && !chunk.reset)) continue
    result.stats.files = Number(result.stats.files) + 1
    result.stats.bytes = Number(result.stats.bytes) + chunk.bytesRead
    const cp = chunk.checkpoint
    if (prev?.internal) {
      result.commits.push({ covers: [], apply: (s) => setFile(s, file, cp) })
      continue
    }
    const since = !prev || opts.explicitSince ? opts.since : opts.floor
    const base = { fallbackId: codexSessionId(file), since, secrets: opts.secrets }
    const full = parseCodexLines(chunk.lines, base)
    if (full.internal) {
      result.commits.push({ covers: [], apply: (s) => setFile(s, file, { ...cp, internal: true }) })
      continue
    }
    // Turn in progress (answer not written yet): we stop before it, without moving the offset past it.
    const n = completeCodexLineCount(chunk.lines, now, opts.idleMs)
    if (n < chunk.lines.length) result.stats.pending = Number(result.stats.pending) + 1
    if (n === 0) continue
    const { conversation } = n === chunk.lines.length ? full : parseCodexLines(chunk.lines.slice(0, n), base)
    const upTo: FileCheckpoint = n === chunk.lines.length ? cp : { ...cp, offset: chunk.ends[n - 1] }
    if (conversation) result.conversations.push(conversation)
    result.commits.push({ covers: conversation ? [conversation.id] : [], apply: (s) => setFile(s, file, upTo) })
  }
  return result
}

function setFile(state: State, file: string, cp: FileCheckpoint) {
  state.codex ??= { files: {} }
  state.codex.files[file] = cp
}
