// Source « logs Codex CLI » : ~/.codex/sessions/**/*.jsonl. Parseur tolérant (plusieurs formats connus).

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
      // Nos propres appels, ou la session d'installation du cerveau (jeton en clair) : ignorés.
      if (m.text.includes(DISTILL_MARKER) || isBrainSetupText(m.text, opts.secrets)) internal = true
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

/** Événements Codex qui marquent la fin d'un tour (selon les versions de la CLI). */
const TURN_END_EVENTS = new Set(["task_complete", "turn_complete", "turn_aborted", "task_aborted"])
/** Éléments qui montrent que l'agent travaille encore (outil appelé, résultat, raisonnement). */
const WORK_ITEMS = /^(?:function_call|function_call_output|custom_tool_call|custom_tool_call_output|local_shell_call|local_shell_call_output|web_search_call|tool_call|tool_call_output|reasoning)$/

function payloadOf(j: Record<string, unknown>): Record<string, unknown> {
  return (j.payload && typeof j.payload === "object" ? j.payload : {}) as Record<string, unknown>
}

/** Fin de tour : événement task_complete, turn_aborted…, ou sa trace dans l'historique (message « <turn_aborted> »). */
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
 * Nombre de lignes à traiter maintenant (même règle que pour Claude Code) : tout, sauf le dernier tour s'il n'est pas
 * fini (pas encore de réponse de l'agent, ou l'agent appelle encore un outil) et encore actif depuis moins de `idleMs`.
 * Un événement de fin de tour (task_complete…) clôt le tour quoi qu'il arrive.
 */
export function completeCodexLineCount(lines: Record<string, unknown>[], now = Date.now(), idleMs = TURN_IDLE_MS): number {
  // Début du dernier tour : la première ligne de la dernière suite de messages utilisateur (response_item + son doublon
  // event_msg). Seule une réponse de l'agent ou une fin de tour coupe la suite : après un tour interrompu sans réponse
  // (q1, turn_aborted, q2), le tour en cours commence à q2 et la fin de tour de q1 ne le clôt pas ; un message ajouté
  // pendant que l'agent travaille (q1, outil, q2) reste dans le tour de q1, gardé en entier jusqu'à sa réponse.
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
  // Tour abandonné (ou format sans horodatage) : on le traite tel quel.
  if (lastActivity === -Infinity || now - lastActivity >= idleMs) return lines.length
  return turnStart
}

/**
 * `since` s'applique aux fichiers jamais lus ; aux autres seulement si `explicitSince`. `floor` (install-schedule) :
 * aucun message antérieur, même dans un fichier déjà suivi. Un tour en cours est laissé pour le prochain passage.
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
    // Tour en cours (réponse pas encore écrite) : on s'arrête avant, sans avancer l'offset au-delà.
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
