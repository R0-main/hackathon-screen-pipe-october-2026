import type { Conversation, ConversationMessage } from "@brain/core"
import type { SourceName, State } from "../config"

/** Mise à jour de checkpoint, appliquée seulement si toutes les conversations couvertes ont été traitées. */
export type CheckpointCommit = { covers: string[]; apply: (state: State) => void }

export type SourceResult = {
  source: SourceName
  available: boolean
  conversations: Conversation[]
  commits: CheckpointCommit[]
  warnings: string[]
  stats: Record<string, number | string>
}

/** Fusionne les messages consécutifs d'un même rôle (Claude Code écrit un bloc par ligne). */
export function mergeConsecutive(messages: ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = []
  for (const m of messages) {
    const text = m.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.text = `${last.text}\n\n${text}`
      if (m.at) last.at = m.at
    } else out.push({ ...m, text })
  }
  return out
}

export function buildConversation(
  base: Omit<Conversation, "messages" | "started_at" | "ended_at">,
  messages: ConversationMessage[],
): Conversation | null {
  const merged = mergeConsecutive(messages)
  if (merged.length === 0) return null
  const times = merged.map((m) => m.at).filter((x): x is string => Boolean(x))
  const now = new Date().toISOString()
  return { ...base, messages: merged, started_at: times[0] ?? now, ended_at: times[times.length - 1] ?? now }
}
