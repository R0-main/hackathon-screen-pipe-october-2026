// Source « logs Claude Code » : ~/.claude/projects/**/*.jsonl (la source la plus fiable pour la démo).

import { statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { DISTILL_MARKER, type Conversation, type ConversationMessage } from "@brain/core"
import type { FileCheckpoint, State } from "../config"
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

/** Extrait le texte utile d'une ligne de transcript, ou null si elle n'en contient pas. */
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
    // On garde les blocs texte ; tool_use / tool_result / thinking / images sont ignorés.
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

/** Regroupe les lignes d'un fichier par session. `internal` : session issue de nos propres appels `claude -p`. */
export function parseClaudeLines(
  lines: Record<string, unknown>[],
  opts: { fallbackId: string; since?: Date; brainHome?: string },
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
    if (p.text.includes(DISTILL_MARKER)) internal = true
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

/**
 * `since` s'applique aux fichiers jamais lus ; aux autres seulement si `explicitSince`
 * (sinon on reprend simplement à l'offset enregistré).
 */
export function readClaudeLogs(opts: { dir: string; state: State; since: Date; explicitSince?: boolean; reset?: boolean; brainHome?: string }): SourceResult {
  const root = join(opts.dir, "projects")
  const result: SourceResult = { source: "claude", available: true, conversations: [], commits: [], warnings: [], stats: { files: 0, bytes: 0, internal: 0 } }
  const files = listJsonlFiles(root, (name) => name === "subagents")
  if (files.length === 0) {
    result.available = false
    result.warnings.push(`Aucun transcript Claude Code trouvé dans ${root}.`)
    return result
  }
  const known = opts.reset ? {} : (opts.state.claude?.files ?? {})
  for (const file of files) {
    const prev = known[file]
    if (!prev) {
      // Fichier jamais lu et pas modifié depuis `since` : on note juste sa taille.
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
    const parsed = parseClaudeLines(chunk.lines, { fallbackId: basename(file, ".jsonl"), since, brainHome: opts.brainHome })
    if (parsed.internal) {
      result.stats.internal = Number(result.stats.internal) + 1
      result.commits.push({ covers: [], apply: (s) => setFile(s, file, { ...cp, internal: true }) })
      continue
    }
    result.conversations.push(...parsed.conversations)
    result.commits.push({ covers: parsed.conversations.map((c) => c.id), apply: (s) => setFile(s, file, cp) })
  }
  return result
}

function setFile(state: State, file: string, cp: FileCheckpoint) {
  state.claude ??= { files: {} }
  state.claude.files[file] = cp
}
