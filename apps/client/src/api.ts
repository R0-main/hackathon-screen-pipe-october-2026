// HTTP client of the brain's API (personal Bearer token).

import type { AddDocumentResult, AgentEventInput, AgentName, DocumentUploadInput, KnowledgeItemInput, ModerationInput, ModerationVerdict, NewZonesInput, Skill, SkillFile, StatusInput, SyncReport, ZoneStatus } from "@brain/core"
import type { ApiZone, CompanyStatusResult, ConnectedCall, ConnectedTools, DocumentResult, IngestResult, QueryResult, WhoAmI, ZoneSummary } from "@brain/core/mcp"

// API responses read by the MCP tools: shared with the brain's MCP endpoint (@brain/core/mcp).
export type { ApiItem, ApiZone, CompanyStatusResult, IngestResult, QueryResult, WhoAmI, ZoneSummary } from "@brain/core/mcp"

/** Outcome of a moderator run (POST /api/admin/moderation). */
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

/** A skill received from the brain: the company-wide ones and those of the cortices the person reads. */
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
      const why = e.name === "TimeoutError" || e.name === "AbortError" ? `no response after ${timeoutMs} ms` : (causeMessage(e) ?? e.message)
      throw new ApiError(`Cannot reach the brain (${this.url}): ${why}`, 0)
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
      if (res.status === 401) throw new ApiError("Token refused by the brain (401): run `init` again with a valid token.", 401)
      throw new ApiError(
        `The brain answered ${res.status}${msg ? `: ${msg}` : ""}${details ? ` ${JSON.stringify(details).slice(0, 300)}` : ""}`,
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
  /** Admins: material for the "where the company stands" summary (last 30 days), to generate it on this computer. */
  statusInput() {
    return this.request<StatusInput>("GET", "/api/status/input", undefined, 30000)
  }
  /** Admins: saves a status summary produced on this computer (redacted and validated by the brain). */
  saveStatus(status: { headline: string; zones: ZoneStatus[] }) {
    return this.request<NonNullable<CompanyStatusResult>>("POST", "/api/status", { status }, 30000)
  }
  /** Admins: material for a "new zones" run, or the reason to do nothing. */
  newZonesInput() {
    return this.request<{ input: NewZonesInput } | { skipped: string }>("GET", "/api/admin/zones/auto/input", undefined, 30000)
  }
  /** Admins: applies the zones proposed by Claude on this computer (same safeguards as a server run). */
  applyNewZones(zones: { name: string; description: string; keywords: string[]; item_ids: string[] }[]) {
    return this.request<NewZonesRunResult>("POST", "/api/admin/zones/auto", { zones }, 60000)
  }
  /** Admins: knowledge that arrived since the moderator's last run, or `{skipped}` if there is nothing to review. */
  moderationInput() {
    return this.request<{ input: ModerationInput; remaining: number } | { skipped: string }>("GET", "/api/admin/moderation/input", undefined, 30000)
  }
  /** Admins: applies the decisions made here by Claude (`ids`: the knowledge reviewed, in order). */
  applyModeration(ids: string[], verdicts: (Omit<ModerationVerdict, "ref"> & { id: string })[]) {
    return this.request<ModerationRunResult>("POST", "/api/admin/moderation", { ids, verdicts }, 120000)
  }
  /** The company's MCP connector tools open to agents. */
  connectedTools(input: { connector?: string; query?: string }) {
    const q = new URLSearchParams({ ...(input.connector ? { connector: input.connector } : {}), ...(input.query ? { query: input.query } : {}) })
    return this.request<ConnectedTools>("GET", `/api/connected-tools${q.toString() ? `?${q}` : ""}`, undefined, 60000)
  }
  /** Calls a connector tool, with the account the admin connected. */
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
  /** A document and its text; `agent`: its zone lights up on the dashboard. */
  document(id: string, agent: AgentName = "mcp") {
    return this.request<DocumentResult>("GET", `/api/documents/${encodeURIComponent(id)}?agent=${agent}`, undefined, 30000)
  }
  /** Sends a document (base64), or links one the brain already has (`sha256` without `content`). */
  uploadDocument(doc: DocumentUploadInput) {
    return this.request<AddDocumentResult>("POST", "/api/documents", doc, 120000)
  }
  automations(workflows: Workflow[]) {
    return this.request<{ saved: number }>("POST", "/api/automations", { workflows })
  }
  /** Report of a sync (successful or not) for the Monitoring page. */
  report(report: SyncReport) {
    return this.request<{ saved: boolean; health: string }>("POST", "/api/sync/report", report, 10000)
  }
  skills() {
    return this.request<{ can_publish: boolean; skills: ApiSkill[] }>("GET", "/api/skills", undefined, 30000)
  }
  /** Publishes a skill (publishing permission required); same name: next version. */
  publishSkill(skill: SkillPush) {
    return this.request<Skill>("POST", "/api/skills", { ...skill, agent: "brain-sync" }, 60000)
  }
  /** Sign-in link to the dashboard, valid for 2 minutes (opened by `setup` in the browser). */
  loginLink() {
    return this.request<{ path: string; expires_in: number }>("POST", "/api/session/link")
  }
}

function causeMessage(e: Error): string | undefined {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause
  if (!cause) return undefined
  if (cause.code === "ECONNREFUSED") return "connection refused (is the server running?)"
  if (cause.code === "ENOTFOUND") return "address not found"
  return cause.message ?? cause.code
}
