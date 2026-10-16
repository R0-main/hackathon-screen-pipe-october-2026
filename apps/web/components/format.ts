import type { AgentName, AgentEventType, KnowledgeKind } from "@brain/core"

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" })

// Fuseau fixe (celui de l'entreprise, comme DEFAULT_TIMEZONE côté cerveau) : le serveur (UTC) et le navigateur
// affichent la même date, sinon l'hydratation échoue autour de minuit.
export const DISPLAY_TIMEZONE = "Europe/Paris"

/**
 * « il y a 5 minutes ». Pour un rendu serveur hydraté, passer `now` venu du serveur (jamais Date.now() pendant le
 * rendu) : voir <RelTime>.
 */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const diff = (t - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return "à l'instant"
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day")
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: DISPLAY_TIMEZONE })
}

export function absoluteTime(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ""
  return new Date(t).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: DISPLAY_TIMEZONE })
}

/** Zones sans doublon (un client tiers peut envoyer ["dev", "dev"] : clés React en double sinon). */
export function uniqueZones<T extends { zones: string[] }>(e: T): T {
  return new Set(e.zones).size === e.zones.length ? e : { ...e, zones: [...new Set(e.zones)] }
}

/** Message d'erreur lisible pour l'interface. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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

export const KIND_COLOR: Record<KnowledgeKind, string> = {
  fact: "#94a3b8",
  decision: "#f472b6",
  task: "#facc15",
  procedure: "#22d3ee",
  question: "#a78bfa",
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      credentials: "same-origin",
    })
  } catch {
    throw new Error("Serveur injoignable : vérifiez la connexion puis réessayez.")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (data as { error?: string }).error
    if (msg) throw new Error(msg)
    throw new Error(res.status === 401 ? "Session expirée : reconnectez-vous." : `Erreur ${res.status}`)
  }
  return data as T
}
