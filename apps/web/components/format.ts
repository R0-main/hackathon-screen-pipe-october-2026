import type { AgentName, AgentEventType, KnowledgeKind } from "@brain/core"

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" })

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—"
  const diff = (Date.parse(iso) - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return "à l'instant"
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day")
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
}

export function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("")
}

export function firstName(name: string): string {
  return name.split(" ")[0] ?? name
}

export const AGENT_LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "brain-sync": "brain-sync",
  job: "Cerveau",
  dashboard: "Dashboard",
  mcp: "Agent (MCP)",
}

export const EVENT_VERB: Record<AgentEventType, string> = {
  started: "a démarré une session",
  query: "cherche",
  write: "a nourri le cerveau",
  stopped: "a terminé sa session",
}

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  fact: "Fait",
  decision: "Décision",
  task: "Tâche",
  procedure: "Procédure",
  question: "Question",
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: "same-origin",
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Erreur ${res.status}`)
  return data as T
}
