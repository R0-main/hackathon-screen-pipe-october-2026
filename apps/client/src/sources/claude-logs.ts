// "Claude Code logs" source: ~/.claude/projects/**/*.jsonl (the most reliable source for the demo).

import { statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { DISTILL_MARKER, type Conversation, type ConversationMessage } from "@brain/core"
import type { FileCheckpoint, State } from "../config"
import { isBrainSetupText } from "../secrets"
import { asString, listJsonlFiles, readNewLines, toIso } from "./jsonl"
import { buildConversation, type SourceResult } from "./types"

type Block = { type?: string; text?: unknown; name?: unknown }

const NOISE_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-memory-input>",
  "Caveat: The messages below were generated",
  "[Request interrupted",
]

function cleanUserText(s: string): string {
  const t = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
  if (NOISE_PREFIXES.some((p) => t.startsWith(p))) return ""
  return t
}

/** Extracts the useful text of a transcript line, or null if it has none. */
export function parseClaudeLine(j: Record<string, unknown>): { sessionId?: string; role: "user" | "assistant"; text: string; at?: string; cwd?: string } | null {
  const type = j.type
  if (type !== "user" && type !== "assistant") return null
  if (j.isSidechain === true || j.isMeta === true || j.isCompactSummary === true || j.isVisibleInTranscriptOnly === true || j.isApiErrorMessage === true) return null
  const message = (j.message ?? {}) as { role?: unknown; content?: unknown }
  const role = message.role === "assistant" || message.role === "user" ? message.role : type
  const content = message.content
  let text = ""
  if (typeof content === "string") {
    text = role === "user" ? cleanUserText(content) : content.trim()
  } else if (Array.isArray(content)) {
    // Text blocks are kept; tool_use / tool_result / thinking / images are ignored.
    const parts = (content as Block[])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => (role === "user" ? cleanUserText(b.text as string) : (b.text as string).trim()))
      .filter(Boolean)
    text = parts.join("\n\n")
  }
  if (!text) return null
  return { sessionId: asString(j.sessionId), role, text, at: toIso(j.timestamp), cwd: asString(j.cwd) }
}

export type ClaudeParseResult = { conversations: Conversation[]; internal: boolean }

/**
 * Groups a file's lines by session. `internal`: session coming from our own `claude -p` calls,
 * or the brain's install session (the magic prompt contains the personal token in clear text).
 */
export function parseClaudeLines(
  lines: Record<string, unknown>[],
  opts: { fallbackId: string; since?: Date; brainHome?: string; secrets?: string[] },
): ClaudeParseResult {
  const sessions = new Map<string, { messages: ConversationMessage[]; cwd?: string }>()
  let title: string | undefined
  let internal = false
  const sinceMs = opts.since?.getTime()
  for (const j of lines) {
    if (j.type === "summary" && typeof j.summary === "string") title = j.summary
    const cwd = asString(j.cwd)
    if (cwd && opts.brainHome && resolve(cwd) === opts.brainHome) internal = true
    const p = parseClaudeLine(j)
    if (!p) continue
    if (p.text.includes(DISTILL_MARKER) || isBrainSetupText(p.text, opts.secrets)) internal = true
    if (sinceMs !== undefined && p.at && Date.parse(p.at) < sinceMs) continue
    const id = p.sessionId ?? opts.fallbackId
    const s = sessions.get(id) ?? { messages: [] }
    s.messages.push({ role: p.role, text: p.text, at: p.at })
    if (p.cwd) s.cwd = p.cwd
    sessions.set(id, s)
  }
  if (internal) return { conversations: [], internal }
  const conversations: Conversation[] = []
  for (const [id, s] of sessions) {
    const conv = buildConversation({ id, tool: "claude-code", app: "Claude Code", title, cwd: s.cwd }, s.messages)
    if (conv) conversations.push(conv)
  }
  return { conversations, internal }
}

/** A session that has stayed silent for this long is considered finished, even in the middle of a turn. */
export const TURN_IDLE_MS = 30 * 60_000

/**
 * Number of lines to process now: everything, except the last turn if it is not finished (no text answer from
 * the assistant yet, or a last answer waiting for a tool) and still active (activity less than `idleMs` ago).
 * The turn in progress will be read in full on the next pass.
 */
export function completeLineCount(lines: Record<string, unknown>[], now = Date.now(), idleMs = TURN_IDLE_MS): number {
  let lastUser = -1
  for (let i = 0; i < lines.length; i++) if (parseClaudeLine(lines[i])?.role === "user") lastUser = i
  if (lastUser === -1) return lines.length
  let hasText = false
  let lastStop: unknown
  let lastActivity = -Infinity
  for (let i = lastUser; i < lines.length; i++) {
    const j = lines[i]
    const t = Date.parse(String(j.timestamp ?? ""))
    if (Number.isFinite(t) && t > lastActivity) lastActivity = t
    if (i === lastUser || j.type !== "assistant" || j.isSidechain === true) continue
    lastStop = (j.message as { stop_reason?: unknown } | undefined)?.stop_reason
    if (parseClaudeLine(j)?.role === "assistant") hasText = true
  }
  if (hasText && lastStop !== "tool_use") return lines.length
  // Abandoned turn (or format without timestamps): processed as is.
  if (lastActivity === -Infinity || now - lastActivity >= idleMs) return lines.length
  return lastUser
}

/**
 * `since` applies to files never read; to the others only if `explicitSince`
 * (otherwise we simply resume at the recorded offset). `floor` (set by install-schedule): no earlier message,
 * even in a file already followed (a turn held back across the setup was never read again).
 */
export function readClaudeLogs(opts: {
  dir: string
  state: State
  since: Date
  explicitSince?: boolean
  reset?: boolean
  brainHome?: string
  secrets?: string[]
  now?: number
  idleMs?: number
  floor?: Date
}): SourceResult {
  const root = join(opts.dir, "projects")
  const result: SourceResult = { source: "claude", available: true, conversations: [], commits: [], warnings: [], stats: { files: 0, bytes: 0, internal: 0, pending: 0 } }
  const files = listJsonlFiles(root, (name) => name === "subagents")
  if (files.length === 0) {
    result.available = false
    result.warnings.push(`No Claude Code transcript found in ${root}.`)
    return result
  }
  const now = opts.now ?? Date.now()
  const known = opts.reset ? {} : (opts.state.claude?.files ?? {})
  for (const file of files) {
    const prev = known[file]
    if (!prev) {
      // File never read and not modified since `since`: we just note its size.
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
    const base = { fallbackId: basename(file, ".jsonl"), since, brainHome: opts.brainHome, secrets: opts.secrets }
    const full = parseClaudeLines(chunk.lines, base)
    if (full.internal) {
      result.stats.internal = Number(result.stats.internal) + 1
      result.commits.push({ covers: [], apply: (s) => setFile(s, file, { ...cp, internal: true }) })
      continue
    }
    // Turn in progress (answer not written yet): we stop before it, without moving the offset past it.
    const n = completeLineCount(chunk.lines, now, opts.idleMs)
    if (n < chunk.lines.length) result.stats.pending = Number(result.stats.pending) + 1
    if (n === 0) continue
    const parsed = n === chunk.lines.length ? full : parseClaudeLines(chunk.lines.slice(0, n), base)
    const upTo: FileCheckpoint = n === chunk.lines.length ? cp : { ...cp, offset: chunk.ends[n - 1] }
    result.conversations.push(...parsed.conversations)
    result.commits.push({ covers: parsed.conversations.map((c) => c.id), apply: (s) => setFile(s, file, upTo) })
  }
  return result
}

function setFile(state: State, file: string, cp: FileCheckpoint) {
  state.claude ??= { files: {} }
  state.claude.files[file] = cp
}
