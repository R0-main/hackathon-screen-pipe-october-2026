// Client HTTP de l'API du cerveau (jeton Bearer personnel).

import type { AgentEventInput, AgentName, KnowledgeItemInput, ModerationInput, ModerationVerdict, NewZonesInput, Skill, SkillFile, StatusInput, SyncReport, ZoneStatus } from "@brain/core"
import type { ApiZone, CompanyStatusResult, ConnectedCall, ConnectedTools, IngestResult, QueryResult, WhoAmI, ZoneSummary } from "@brain/core/mcp"

// Réponses de l'API lues par les outils MCP : partagées avec l'endpoint MCP du cerveau (@brain/core/mcp).
export type { ApiItem, ApiZone, CompanyStatusResult, IngestResult, QueryResult, WhoAmI, ZoneSummary } from "@brain/core/mcp"

/** Bilan d'un passage du modérateur (POST /api/admin/moderation). */
export type ModerationRunResult = { status: string; reviewed: number; edited: number; rejected: number; remaining?: number }

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export type NewZonesRunResult =
  | { status: "created"; zones: { id: string; name: string; items: number; readers: number }[] }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }

export type Workflow = {
  id: string
  title: string
  description: string
  schedule?: string
  occurrences: number
  days: number
  zone?: string
  minutes_saved_per_week: number
}

/** Un skill reçu du cerveau : ceux de toute l'entreprise et ceux des cortex que la personne lit. */
export type ApiSkill = Skill & { can_manage?: boolean }

export type SkillPush = { name: string; description: string; zone?: string | null; files: SkillFile[] }

export class BrainApi {
  readonly url: string

  constructor(
    url: string,
    private token: string,
    private timeoutMs = 15000,
  ) {
    this.url = url.replace(/\/+$/, "")
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const e = err as Error
      const why = e.name === "TimeoutError" || e.name === "AbortError" ? `pas de réponse après ${timeoutMs} ms` : (causeMessage(e) ?? e.message)
      throw new ApiError(`Impossible de joindre le cerveau (${this.url}) : ${why}`, 0)
    }
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error
      const details = (data as { details?: unknown } | null)?.details
      if (res.status === 401) throw new ApiError("Jeton refusé par le cerveau (401) : relancez `init` avec un jeton valide.", 401)
      throw new ApiError(
        `Le cerveau a répondu ${res.status}${msg ? ` : ${msg}` : ""}${details ? ` ${JSON.stringify(details).slice(0, 300)}` : ""}`,
        res.status,
      )
    }
    return data as T
  }

  whoami() {
    return this.request<WhoAmI>("GET", "/api/whoami")
  }
  zones() {
    return this.request<{ zones: ApiZone[] }>("GET", "/api/zones").then((r) => r.zones)
  }
  zone(id: string) {
    return this.request<ZoneSummary>("GET", `/api/zones/${encodeURIComponent(id)}`)
  }
  status() {
    return this.request<CompanyStatusResult>("GET", "/api/status")
  }
  /** Admins : matière du résumé « où en est la boîte » (30 derniers jours), pour le générer sur ce poste. */
  statusInput() {
    return this.request<StatusInput>("GET", "/api/status/input", undefined, 30000)
  }
  /** Admins : enregistre un résumé d'état produit sur ce poste (masqué et validé par le cerveau). */
  saveStatus(status: { headline: string; zones: ZoneStatus[] }) {
    return this.request<NonNullable<CompanyStatusResult>>("POST", "/api/status", { status }, 30000)
  }
  /** Admins : matière d'un passage « nouvelles zones », ou la raison de ne rien faire. */
  newZonesInput() {
    return this.request<{ input: NewZonesInput } | { skipped: string }>("GET", "/api/admin/zones/auto/input", undefined, 30000)
  }
  /** Admins : applique les zones proposées par Claude sur ce poste (mêmes garde-fous qu'un passage du serveur). */
  applyNewZones(zones: { name: string; description: string; keywords: string[]; item_ids: string[] }[]) {
    return this.request<NewZonesRunResult>("POST", "/api/admin/zones/auto", { zones }, 60000)
  }
  /** Admins : connaissances arrivées depuis le dernier passage du modérateur, ou `{skipped}` s'il n'y a rien à relire. */
  moderationInput() {
    return this.request<{ input: ModerationInput; remaining: number } | { skipped: string }>("GET", "/api/admin/moderation/input", undefined, 30000)
  }
  /** Admins : applique les décisions prises ici par Claude (`ids` : les connaissances relues, dans l'ordre). */
  applyModeration(ids: string[], verdicts: (Omit<ModerationVerdict, "ref"> & { id: string })[]) {
    return this.request<ModerationRunResult>("POST", "/api/admin/moderation", { ids, verdicts }, 120000)
  }
  /** Outils des connecteurs MCP de l'entreprise ouverts aux agents. */
  connectedTools(input: { connector?: string; query?: string }) {
    const q = new URLSearchParams({ ...(input.connector ? { connector: input.connector } : {}), ...(input.query ? { query: input.query } : {}) })
    return this.request<ConnectedTools>("GET", `/api/connected-tools${q.toString() ? `?${q}` : ""}`, undefined, 60000)
  }
  /** Appelle un outil d'un connecteur, avec le compte branché par l'admin. */
  callConnectedTool(input: { connector: string; tool: string; arguments: Record<string, unknown> }) {
    return this.request<ConnectedCall>("POST", "/api/connected-tools/call", input, 70000)
  }
  query(input: { query: string; zones?: string[]; limit?: number; agent?: AgentName }) {
    return this.request<QueryResult>("POST", "/api/query", input)
  }
  events(events: AgentEventInput[], timeoutMs?: number) {
    const body = events.length === 1 ? events[0] : { events }
    return this.request<{ recorded: number; zones: string[] }>("POST", "/api/events", body, timeoutMs)
  }
  ingest(items: KnowledgeItemInput[], agent: AgentName = "brain-sync") {
    return this.request<IngestResult>("POST", "/api/ingest", { items, agent }, 60000)
  }
  automations(workflows: Workflow[]) {
    return this.request<{ saved: number }>("POST", "/api/automations", { workflows })
  }
  /** Compte rendu d'une synchro (réussie ou non) pour la page Supervision. */
  report(report: SyncReport) {
    return this.request<{ saved: boolean; health: string }>("POST", "/api/sync/report", report, 10000)
  }
  skills() {
    return this.request<{ can_publish: boolean; skills: ApiSkill[] }>("GET", "/api/skills", undefined, 30000)
  }
  /** Publie un skill (droit de publication requis) ; même nom : version suivante. */
  publishSkill(skill: SkillPush) {
    return this.request<Skill>("POST", "/api/skills", { ...skill, agent: "brain-sync" }, 60000)
  }
  /** Lien de connexion au dashboard, valable 2 minutes (ouvert par `setup` dans le navigateur). */
  loginLink() {
    return this.request<{ path: string; expires_in: number }>("POST", "/api/session/link")
  }
}

function causeMessage(e: Error): string | undefined {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause
  if (!cause) return undefined
  if (cause.code === "ECONNREFUSED") return "connexion refusée (le serveur est-il lancé ?)"
  if (cause.code === "ENOTFOUND") return "adresse introuvable"
  return cause.message ?? cause.code
}
