// HTTP client of the brain's API (personal Bearer token).

import type { AgentEventInput, AgentName, Entity, KnowledgeItemInput, KnowledgeKind, NewZonesInput, Profile, Skill, SkillFile, StatusInput, SyncReport, Zone, ZoneStatus } from "@brain/core"

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export type ApiZone = Zone & { readable: boolean; count?: number }

export type NewZonesRunResult =
  | { status: "created"; zones: { id: string; name: string; items: number; readers: number }[] }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }

export type WhoAmI = {
  org: { name: string; description: string }
  profile: Profile
  access: { isAdmin: boolean; readable: string[]; writable: string[] }
  context: {
    person: Profile
    zones: { zone: string; weight: number }[]
    entities: { type: string; name: string; count: number; zones: string[] }[]
    frequent_prompts: { summary: string; count: number; last: string }[]
    items: ApiItem[]
    decisions: ApiItem[]
    procedures: ApiItem[]
  } | null
}

export type ApiItem = {
  id: string
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  source: { app: string; tool: string; at: string }
  confidence: number
  created_at: string
  author_id: string
  author?: string
  score?: number
}

export type QueryResult = {
  query: string
  zones_searched: string[]
  zones_hit: string[]
  zones_restricted: string[]
  items: ApiItem[]
}

export type ZoneSummary = {
  zone: Zone
  status: {
    summary: string
    objectives: string[]
    progress: string
    next_steps: string[]
    who_did_what: { person: string; did: string }[]
  } | null
  items: ApiItem[]
  entities: { type: string; name: string; count: number }[]
  tasks: { id: string; title: string; status: string; assignee?: string }[]
}

export type CompanyStatusResult = {
  headline: string
  zones: { zone: string; summary: string; objectives: string[]; progress: string; next_steps: string[]; who_did_what: { person: string; did: string }[] }[]
  generated_at: string
  generator: string
} | null

/**
 * Response of POST /api/ingest. `skipped`: items already received (same author, zone, title and content over 30 days), skipped.
 * `zones`: zones where at least one item was inserted. `per_zone` (optional): number of items inserted per zone.
 */
export type IngestResult = { inserted: number; skipped?: number; ids: string[]; zones: string[]; per_zone?: Record<string, number> }

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
