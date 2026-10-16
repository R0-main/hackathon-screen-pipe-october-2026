// Source « logs Codex CLI » : ~/.codex/sessions/**/*.jsonl. Parseur tolérant (plusieurs formats connus).

import { statSync } from "node:fs"
import { basename, join } from "node:path"
import { DISTILL_MARKER, type Conversation, type ConversationMessage } from "@brain/core"
import type { FileCheckpoint, State } from "../config"
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

/** Une ligne → message (format `response_item`, format historique `{type:"message"}` ou toute ligne avec role + content). */
export function parseCodexLine(j: Record<string, unknown>): { msg?: Parsed; event?: Parsed; cwd?: string; sessionId?: string } {
  const at = toIso(j.timestamp)
  const payload = (j.payload && typeof j.payload === "object" ? j.payload : null) as Record<string, unknown> | null
  if (j.type === "session_meta" && payload) return { sessionId: asString(payload.id), cwd: asString(payload.cwd) }
  if (j.type === "turn_context" && payload) return { cwd: asString(payload.cwd) }
  if (j.type === "event_msg" && payload) {
    // Doublons des response_item : utilisés seulement si le fichier n'a rien d'autre.
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

export function parseCodexLines(lines: Record<string, unknown>[], opts: { fallbackId: string; since?: Date }): { conversation: Conversation | null; internal: boolean } {
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
      if (m.text.includes(DISTILL_MARKER)) internal = true
      if (sinceMs !== undefined && m.at && Date.parse(m.at) < sinceMs) continue
      list.push(m)
    }
  }
  if (internal) return { conversation: null, internal }
  const chosen = msgs.length ? msgs : events
  return { conversation: buildConversation({ id: opts.fallbackId, tool: "codex", app: "Codex", cwd }, chosen), internal }
}

/** Identifiant de session stable entre deux lectures : l'UUID du nom de fichier (rollout-…-<uuid>.jsonl). */
export function codexSessionId(file: string): string {
  const name = basename(file, ".jsonl")
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return `codex:${m ? m[0] : name}`
}

export function readCodexLogs(opts: { dir: string; state: State; since: Date; explicitSince?: boolean; reset?: boolean }): SourceResult {
  const root = join(opts.dir, "sessions")
  const result: SourceResult = { source: "codex", available: true, conversations: [], commits: [], warnings: [], stats: { files: 0, bytes: 0 } }
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
    const since = !prev || opts.explicitSince ? opts.since : undefined
    const { conversation, internal } = parseCodexLines(chunk.lines, { fallbackId: codexSessionId(file), since })
    if (internal) {
      result.commits.push({ covers: [], apply: (s) => setFile(s, file, { ...cp, internal: true }) })
      continue
    }
    if (conversation) result.conversations.push(conversation)
    result.commits.push({ covers: conversation ? [conversation.id] : [], apply: (s) => setFile(s, file, cp) })
  }
  return result
}

function setFile(state: State, file: string, cp: FileCheckpoint) {
  state.codex ??= { files: {} }
  state.codex.files[file] = cp
}
