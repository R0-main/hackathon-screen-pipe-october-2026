// Postgres store (Supabase or other). Schema: supabase/migrations/.
// One instance = one organization: the root serves the oldest one in the `orgs` table (excluding companies created from
// /create), `forOrg` serves a given company while sharing the same connection.

import { randomBytes } from "node:crypto"
import postgres from "postgres"
import {
  CORE_ZONE,
  DEFAULT_ZONES,
  normalize,
  tokenize,
  type AgentEvent,
  type AutomationSuggestion,
  type BrainDocument,
  type CompanyStatus,
  type KnowledgeItem,
  type Org,
  type Profile,
  type ScoredDocument,
  type ScoredItem,
  type Skill,
  type SyncReport,
  type SyncReportRow,
  type Task,
  type Zone,
  type ZoneAccess,
} from "@brain/core"
import { SYNC_REPORTS_KEEP, type BrainStore, type DocumentFilter, type EntityStat, type JoinRequest, type JoinStatus, type NewEvent, type NewItem, type NewDocument, type NewJoinRequest, type NewProfile, type NewSkill, type NewTask, type NewTenantOrg, type ProfilePatch, type ZoneStat, type AuthorZoneStat } from "./types"
import { newJoinCode } from "./codes"
import { JOIN_MISSING_MESSAGE, SETTINGS_MISSING_MESSAGE, StoreSetupError, missingTable } from "./errors"

type Row = Record<string, any>
type Sql = postgres.Sql

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v))

function toOrg(r: Row): Org {
  return { id: r.id, name: r.name, description: r.description, created_at: iso(r.created_at) }
}
function toProfile(r: Row): Profile {
  return {
    id: r.id,
    org_id: r.org_id,
    name: r.name,
    email: r.email ?? undefined,
    title: r.title ?? undefined,
    role: r.role,
    manager_id: r.manager_id ?? null,
    can_publish_skills: Boolean(r.can_publish_skills),
    created_at: iso(r.created_at),
  }
}
function toZone(r: Row): Zone {
  return { id: r.id, name: r.name, description: r.description, color: r.color, keywords: r.keywords ?? [], position: r.position, ...(r.projects?.length ? { projects: r.projects } : {}) }
}
function toItem(r: Row): KnowledgeItem {
  return {
    id: r.id,
    org_id: r.org_id,
    author_id: r.author_id,
    zone: r.zone,
    kind: r.kind,
    title: r.title,
    body: r.body,
    entities: r.entities ?? [],
    source: r.source ?? {},
    confidence: Number(r.confidence),
    created_at: iso(r.created_at),
    superseded_by: r.superseded_by ?? null,
  }
}
function toEvent(r: Row): AgentEvent {
  return {
    id: Number(r.id),
    org_id: r.org_id,
    user_id: r.user_id,
    agent: r.agent,
    type: r.type,
    zones: r.zones ?? [],
    summary: r.summary ?? undefined,
    fingerprint: r.fingerprint ?? undefined,
    session_id: r.session_id ?? undefined,
    at: iso(r.at),
  }
}
function toJoinRequest(r: Row): JoinRequest {
  return {
    id: r.id,
    org_id: r.org_id,
    name: r.name ?? null,
    title: r.title ?? null,
    email: r.email ?? null,
    hostname: r.hostname ?? null,
    status: r.status,
    profile_id: r.profile_id ?? null,
    created_at: iso(r.created_at),
    decided_at: isoOrNull(r.decided_at),
  }
}

function toTask(r: Row): Task {
  return {
    id: r.id,
    title: r.title,
    zone: r.zone,
    assignee_id: r.assignee_id ?? undefined,
    status: r.status,
    source_item_id: r.source_item_id ?? undefined,
    external_source: r.external_source ?? undefined,
    external_id: r.external_id ?? undefined,
    external_url: r.external_url ?? undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

const QUALITY_MISSING_MESSAGE =
  "The database needs an update: superseded_by / embedding columns missing from knowledge_items. Apply the migrations (npm run db:migrate)."
const ZONE_PROJECTS_MISSING_MESSAGE =
  "The database needs an update: the projects column is missing from zones. Apply the migrations (npm run db:migrate)."
const TASKS_EXTERNAL_MISSING_MESSAGE =
  "The database needs an update: external_* columns missing from tasks (connectors). Apply the migrations (npm run db:migrate)."

/** Missing column (Postgres code 42703): migration not applied. */
function missingColumn(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42703"
}
function toAutomation(r: Row): AutomationSuggestion {
  return {
    id: r.id,
    key: r.key,
    user_id: r.user_id ?? undefined,
    zone: r.zone ?? undefined,
    title: r.title,
    description: r.description,
    schedule: r.schedule ?? undefined,
    evidence: r.evidence ?? { occurrences: 0, days: 0 },
    minutes_saved_per_week: r.minutes_saved_per_week,
    status: r.status,
    source: r.source,
    created_at: iso(r.created_at),
  }
}

function toSkill(r: Row): Skill {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    zone: r.zone ?? null,
    files: r.files ?? [],
    author_id: r.author_id ?? null,
    updated_by: r.updated_by ?? null,
    version: r.version,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

/** Columns of `documents` returned to callers: never the bytes nor the text (read apart). */
const DOCUMENT_COLUMNS = ["id", "org_id", "author_id", "zone", "name", "mime", "size", "sha256", "title", "summary", "pages", "source", "item_ids", "created_at"]

function toDocument(r: Row): BrainDocument {
  return {
    id: r.id,
    org_id: r.org_id,
    author_id: r.author_id,
    zone: r.zone,
    name: r.name,
    mime: r.mime,
    size: Number(r.size),
    sha256: r.sha256,
    title: r.title,
    summary: r.summary,
    ...(r.pages != null ? { pages: Number(r.pages) } : {}),
    source: r.source ?? {},
    item_ids: r.item_ids ?? [],
    created_at: iso(r.created_at),
  }
}

/** Search text of a document: the start is enough to find it (and keeps the tsvector under its 1 MB limit). */
const DOCUMENT_SEARCH_CHARS = 100_000

const DOCUMENTS_MISSING_MESSAGE =
  "The database needs an update: the documents table is missing. Apply the migrations (npm run db:migrate)."

/** Missing skills table: the skills migration was not applied. */
const SKILLS_MISSING_MESSAGE =
  "The database needs an update: the skills table is missing. Apply the migrations (npm run db:migrate)."

const UUID_RE = /^[0-9a-f-]{36}$/i

const SYNC_REPORTS_MISSING_MESSAGE =
  "Missing sync_reports table: apply the supabase/migrations/20261017000004_sync_reports.sql migration (npm run db:migrate)."

function toSyncReport(r: Row): SyncReportRow {
  return {
    id: r.id,
    org_id: r.org_id,
    user_id: r.user_id,
    at: iso(r.at),
    ok: Boolean(r.ok),
    duration_ms: Number(r.duration_ms),
    items_sent: Number(r.items_sent),
    duplicates: Number(r.duplicates),
    conversations: r.conversations ?? {},
    distiller: r.distiller,
    failed: Number(r.failed),
    deferred: Number(r.deferred),
    error: r.error ?? undefined,
    client_version: r.client_version ?? undefined,
    platform: r.platform ?? undefined,
    screenpipe: r.screenpipe ?? undefined,
  }
}
/** The organization is re-read regularly: a reseed (or an onboarding served by another instance) is seen without a restart. */
const ORG_TTL_MS = 5_000
/** Advisory lock (transaction) that serializes the creation of the organization and the reset. */
const ORG_LOCK_KEY = 7_204_331_117

/** Search terms: prefix only from 4 characters (like the file store: "pr" must not find "product"). */
function tsTerms(query: string): string[] {
  const tokens = [...new Set(tokenize(query))].filter((t) => /^[a-z0-9]+$/.test(t)).slice(0, 12)
  return tokens.map((t) => (t.length >= 4 ? `${t}:*` : t))
}

/** A company created from /create is marked by a `tenant:<id>` row in brain_settings (no migration). */
const TENANT_PREFIX = "tenant:"
/** A company's team message code: `join:<org_id>` → `cj_…` in brain_settings. */
const JOIN_PREFIX = "join:"

/** LISTEN/NOTIFY channel of the real-time stream: the payload is the company's id. */
const EVENTS_CHANNEL = "brain_events"

/**
 * Notifications are on by default, except on Vercel (one dedicated LISTEN connection per function):
 * BRAIN_EVENT_NOTIFY=1 forces them, =0 turns them off. DATABASE_LISTEN_URL: direct connection (a pooler in
 * transaction mode, Supabase port 6543 for example, does not forward LISTEN).
 */
function notifyEnabled(): boolean {
  const v = process.env.BRAIN_EVENT_NOTIFY
  if (v === "0" || v === "false" || v === "no") return false
  if (v === "1" || v === "true" || v === "yes") return true
  return !process.env.VERCEL
}

/** Stream subscribers, per company, and the LISTEN connection state: one set per process (shared through globalThis). */
type ListenState = {
  listeners: Map<string, Set<() => void>>
  status: "idle" | "starting" | "ready" | "failed"
  handle: { unlisten: () => Promise<void> } | null
  sql: Sql | null
}

export class PostgresStore implements BrainStore {
  readonly kind = "postgres" as const
  private sql: Sql
  private orgCache: { org: Org; at: number } | null = null
  private orgPending: Promise<Org> | null = null
  private secret: string | null = null
  /** Company served by this instance; absent on the root (the base organization). */
  private readonly fixedOrgId: string | null
  private tenants = new Map<string, PostgresStore>()
  private settingsReady = false
  private readonly url: string | null
  private listen: ListenState
  /** Do the columns of the "quality" migration (superseded_by, embedding) exist? Checked once. */
  private qualityColumns: boolean | null = null
  private taskExternalColumns: boolean | null = null
  private qualityWarned = false

  constructor(url: string | { sql: Sql; orgId: string; listen: ListenState; url: string | null }) {
    if (typeof url !== "string") {
      this.sql = url.sql
      this.fixedOrgId = url.orgId
      this.listen = url.listen
      this.url = url.url
      return
    }
    this.fixedOrgId = null
    this.url = url
    this.listen = { listeners: new Map(), status: "idle", handle: null, sql: null }
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
    const ssl = process.env.DATABASE_SSL === "disable" || local ? false : "require"
    // prepare: false → compatible with the Supabase pooler in transaction mode (port 6543).
    this.sql = postgres(url, { prepare: false, max: Number(process.env.DATABASE_POOL_MAX ?? 5), idle_timeout: 20, ssl, onnotice: () => {} })
  }

  /** Does brain_settings exist? Without it (migration not applied), there is simply no created company. */
  private async hasSettings(): Promise<boolean> {
    if (this.settingsReady) return true
    const [r] = await this.sql`select to_regclass('brain_settings') is not null as ok`
    this.settingsReady = Boolean(r.ok)
    return this.settingsReady
  }

  /**
   * SQL fragment "this organization is not a company created from /create". Synchronous on purpose: an async function
   * returning a postgres.js fragment would execute it (it is a thenable) instead of returning it.
   */
  private notTenant(col: string, hasSettings: boolean) {
    if (!hasSettings) return this.sql`true`
    return this.sql`not exists (select 1 from brain_settings s where s.key = ${TENANT_PREFIX} || ${this.sql(col)}::text)`
  }

  forOrg(orgId: string): BrainStore {
    if (this.fixedOrgId) throw new Error("forOrg is only available on the root store.")
    if (!UUID_RE.test(orgId)) throw new Error("Company not found.")
    let t = this.tenants.get(orgId)
    if (!t) {
      t = new PostgresStore({ sql: this.sql, orgId, listen: this.listen, url: this.url })
      this.tenants.set(orgId, t)
    }
    return t
  }

  onEvents(orgId: string, listener: () => void) {
    const { listeners } = this.listen
    let set = listeners.get(orgId)
    if (!set) listeners.set(orgId, (set = new Set()))
    set.add(listener)
    if (notifyEnabled()) this.startListening()
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(orgId)
    }
  }

  eventNotifyMode() {
    if (!notifyEnabled()) return "poll" as const
    return this.listen.status === "failed" ? ("poll" as const) : ("notify" as const)
  }

  async saveSyncReport(userId: string, report: SyncReport) {
    const org = await this.orgId()
    try {
      const [r] = await this.sql`insert into sync_reports
          (org_id, user_id, at, ok, duration_ms, items_sent, duplicates, conversations, distiller, failed, deferred, error, client_version, platform, screenpipe)
        values (${org}, ${userId}, ${report.at}, ${report.ok}, ${report.duration_ms}, ${report.items_sent}, ${report.duplicates},
          ${this.sql.json(report.conversations as any)}, ${report.distiller}, ${report.failed}, ${report.deferred}, ${report.error ?? null},
          ${report.client_version ?? null}, ${report.platform ?? null}, ${report.screenpipe ?? null})
        returning *`
      // History bounded per workstation.
      await this.sql`delete from sync_reports where user_id = ${userId} and org_id = ${org} and id not in
        (select id from sync_reports where user_id = ${userId} and org_id = ${org} order by at desc limit ${SYNC_REPORTS_KEEP})`
      return toSyncReport(r)
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(SYNC_REPORTS_MISSING_MESSAGE)
      throw err
    }
  }

  async latestSyncReports() {
    try {
      const rows = await this.sql`select distinct on (user_id) * from sync_reports where org_id = ${await this.orgId()} order by user_id, at desc`
      return rows.map(toSyncReport).sort((a, b) => b.at.localeCompare(a.at))
    } catch (err) {
      // Migration not applied yet: monitoring shows "never synced" rather than an error.
      if (missingTable(err)) return []
      throw err
    }
  }

  async listSyncReports(f: { userId?: string; limit?: number }) {
    const sql = this.sql
    try {
      const rows = await sql`select * from sync_reports where org_id = ${await this.orgId()}
        ${f.userId ? sql`and user_id = ${f.userId}` : sql``} order by at desc limit ${f.limit ?? 100}`
      return rows.map(toSyncReport)
    } catch (err) {
      if (missingTable(err)) return []
      throw err
    }
  }

  /**
   * Opens (only once per process) the LISTEN connection. On failure (pooler in transaction mode, permissions),
   * the stream stays on its periodic re-read: nothing is lost, the neons are just less instantaneous.
   */
  private startListening() {
    const st = this.listen
    if (st.status !== "idle") return
    st.status = "starting"
    const listenUrl = process.env.DATABASE_LISTEN_URL
    if (listenUrl && !st.sql) {
      const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(listenUrl) || listenUrl.includes("host=/")
      st.sql = postgres(listenUrl, { prepare: false, max: 1, idle_timeout: 0, ssl: process.env.DATABASE_SSL === "disable" || local ? false : "require", onnotice: () => {} })
    }
    const sql = st.sql ?? this.sql
    sql
      .listen(
        EVENTS_CHANNEL,
        (payload) => {
          const set = st.listeners.get(String(payload).trim())
          if (!set) return
          for (const fn of [...set]) {
            try {
              fn()
            } catch (err) {
              console.error("[store] stream subscriber:", err)
            }
          }
        },
        () => {
          // postgres.js reconnects automatically: nothing to do, subscribers are kept.
        },
      )
      .then((handle) => {
        st.handle = handle
        st.status = "ready"
      })
      .catch((err) => {
        st.status = "failed"
        console.error(`[store] LISTEN ${EVENTS_CHANNEL} failed, the stream re-reads periodically:`, err instanceof Error ? err.message : err)
      })
  }

  async createTenantOrg(o: NewTenantOrg) {
    if (!(await this.hasSettings())) throw new StoreSetupError(SETTINGS_MISSING_MESSAGE)
    return (await this.sql.begin(async (tx: any) => {
      const [org] = await tx`insert into orgs (name, description) values (${o.name}, ${o.description}) returning *`
      await tx`insert into brain_settings (key, value) values (${TENANT_PREFIX + org.id}, ${new Date().toISOString()})`
      for (const z of o.zones) {
        await tx`insert into zones (org_id, id, name, description, color, keywords, position)
                 values (${org.id}, ${z.id}, ${z.name}, ${z.description}, ${z.color}, ${tx.array(z.keywords)}, ${z.position})`
      }
      return toOrg(org)
    })) as Org
  }

  async countTenantOrgs() {
    if (!(await this.hasSettings())) return 0
    const [r] = await this.sql`select count(*)::int as n from brain_settings where key like ${TENANT_PREFIX + "%"}`
    return Number(r.n)
  }

  async listOrgIds() {
    const root = await this.orgId()
    if (!(await this.hasSettings())) return [root]
    const rows = await this.sql`select substr(key, ${TENANT_PREFIX.length + 1}) as id from brain_settings
      where key like ${TENANT_PREFIX + "%"} order by value, key`
    return [root, ...rows.map((r) => r.id as string).filter((id) => UUID_RE.test(id) && id !== root)]
  }

  async findUserOrg(by: { id: string } | { tokenHash: string }) {
    if ("id" in by && !UUID_RE.test(by.id)) return null
    const [r] =
      "id" in by
        ? await this.sql`select org_id from profiles where id = ${by.id}`
        : await this.sql`select org_id from profiles where token_hash = ${by.tokenHash}`
    return r ? (r.org_id as string) : null
  }

  /**
   * The organization of this database: the oldest one with accounts (an empty org created by mistake is ignored).
   * An org is created ONLY if the table is empty, on this instance's first load, never during a
   * cache refresh: an empty table during a refresh is transient (reset) or abnormal.
   */
  private async org(): Promise<Org> {
    const cached = this.orgCache
    if (cached && Date.now() - cached.at < ORG_TTL_MS) return cached.org
    if (!this.orgPending) {
      this.orgPending = (async () => {
        if (this.fixedOrgId) {
          const [r] = await this.sql`select * from orgs where id = ${this.fixedOrgId}`
          if (!r) throw new Error("Company not found.")
          this.orgCache = { org: toOrg(r), at: Date.now() }
          return this.orgCache.org
        }
        let org = await this.selectOrg()
        if (!org && !cached) org = (await this.createOrgIfNone({ name: "My company", description: "" })) ?? (await this.selectOrg())
        if (!org) {
          // Refresh on an empty table: keep the known org, without extending the cache (re-read on the next call).
          if (cached) return cached.org
          throw new Error("No organization in the database.")
        }
        this.orgCache = { org, at: Date.now() }
        return org
      })().finally(() => {
        this.orgPending = null
      })
    }
    return this.orgPending
  }

  private async selectOrg(): Promise<Org | null> {
    const has = await this.hasSettings()
    const [r] = await this.sql`select o.* from orgs o where ${this.notTenant("o.id", has)}
      order by exists (select 1 from profiles p where p.org_id = o.id) desc, o.created_at, o.id
      limit 1`
    return r ? toOrg(r) : null
  }

  /** Fresh database: creates the org (and its default zones) only if the table is empty, in one atomic statement. */
  private async createOrgIfNone(o: { name: string; description: string }): Promise<Org | null> {
    const has = await this.hasSettings()
    return this.sql.begin(async (tx: any) => {
      // Two instances starting together: the second one waits, then no longer finds the table empty.
      await tx`select pg_advisory_xact_lock(${ORG_LOCK_KEY})`
      const [org] = await tx`insert into orgs (name, description)
        select ${o.name}, ${o.description} where not exists (select 1 from orgs o where ${this.notTenant("o.id", has)}) returning *`
      if (!org) return null
      await this.insertDefaultZones(tx, org.id)
      return toOrg(org)
    }) as Promise<Org | null>
  }

  /** New organization and its default zones, in the `tx` transaction. */
  private async insertOrg(tx: any, o: { name: string; description: string }): Promise<Org> {
    const [org] = await tx`insert into orgs (name, description) values (${o.name}, ${o.description}) returning *`
    await this.insertDefaultZones(tx, org.id)
    return toOrg(org)
  }

  private async insertDefaultZones(tx: any, orgId: string) {
    for (const z of DEFAULT_ZONES) {
      await tx`insert into zones (org_id, id, name, description, color, keywords, position)
               values (${orgId}, ${z.id}, ${z.name}, ${z.description}, ${z.color}, ${tx.array(z.keywords)}, ${z.position})`
    }
  }

  private async orgId() {
    return (await this.org()).id
  }

  /** Query on join_requests: missing table (migration not applied) → clear configuration error (503). */
  private async joins<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(JOIN_MISSING_MESSAGE)
      throw err
    }
  }

  async findOrgByJoinCode(code: string) {
    const [r] = await this.settings(() => this.sql`select key from brain_settings where key like ${JOIN_PREFIX + "%"} and value = ${code}`)
    return r ? (r.key as string).slice(JOIN_PREFIX.length) : null
  }

  async findJoinRequestOrg(id: string) {
    if (!UUID_RE.test(id)) return null
    const [r] = await this.joins(() => this.sql`select org_id from join_requests where id = ${id}`)
    return r ? (r.org_id as string) : null
  }

  async getOrgSetting(name: string) {
    const key = `org:${name}:${await this.orgId()}`
    const [r] = await this.settings(() => this.sql`select value from brain_settings where key = ${key}`)
    return r ? (r.value as string) : null
  }

  async setOrgSetting(name: string, value: string | null) {
    const key = `org:${name}:${await this.orgId()}`
    if (value === null) await this.settings(() => this.sql`delete from brain_settings where key = ${key}`)
    else await this.settings(() => this.sql`insert into brain_settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`)
  }

  async getJoinCode() {
    const key = JOIN_PREFIX + (await this.orgId())
    // "Only once" insertion: two admins opening the page together see the same code.
    await this.settings(() => this.sql`insert into brain_settings (key, value) values (${key}, ${newJoinCode()}) on conflict (key) do nothing`)
    const [r] = await this.sql`select value from brain_settings where key = ${key}`
    return r.value as string
  }

  async rotateJoinCode() {
    const key = JOIN_PREFIX + (await this.orgId())
    const code = newJoinCode()
    await this.settings(() => this.sql`insert into brain_settings (key, value) values (${key}, ${code}) on conflict (key) do update set value = excluded.value`)
    return code
  }

  async createJoinRequest(r: NewJoinRequest) {
    const org = await this.orgId()
    const [row] = await this.joins(() => this.sql`insert into join_requests (org_id, name, title, email, hostname, token_hash)
      values (${org}, ${r.name ?? null}, ${r.title ?? null}, ${r.email ?? null}, ${r.hostname ?? null}, ${r.token_hash}) returning *`)
    return toJoinRequest(row)
  }

  async listJoinRequests(f: { status?: JoinStatus; limit?: number } = {}) {
    const org = await this.orgId()
    const limit = f.limit ?? 100
    const rows = await this.joins(() =>
      f.status
        ? this.sql`select * from join_requests where org_id = ${org} and status = ${f.status} order by created_at desc limit ${limit}`
        : this.sql`select * from join_requests where org_id = ${org} order by created_at desc limit ${limit}`,
    )
    return rows.map(toJoinRequest)
  }

  async getJoinRequest(id: string) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.joins(() => this.sql`select * from join_requests where id = ${id} and org_id = ${org}`)
    return r ? { ...toJoinRequest(r), token_hash: r.token_hash as string } : null
  }

  async decideJoinRequest(id: string, d: { status: Exclude<JoinStatus, "pending">; profile_id?: string }) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.joins(() => this.sql`update join_requests set status = ${d.status}, profile_id = ${d.profile_id ?? null}, decided_at = now()
      where id = ${id} and org_id = ${org} and status = 'pending' returning *`)
    return r ? toJoinRequest(r) : null
  }

  async getOrg() {
    return this.org()
  }
  async updateOrg(patch: Partial<Pick<Org, "name" | "description">>) {
    const org = await this.org()
    const next = { ...org, ...patch }
    const [r] = await this.sql`update orgs set name = ${next.name}, description = ${next.description} where id = ${org.id} returning *`
    this.orgCache = { org: toOrg(r), at: Date.now() }
    return toOrg(r)
  }

  async getProfileByTokenHash(hash: string) {
    const [r] = await this.sql`select * from profiles where token_hash = ${hash} and org_id = ${await this.orgId()}`
    return r ? toProfile(r) : null
  }
  async getProfile(id: string) {
    if (!UUID_RE.test(id)) return null
    const [r] = await this.sql`select * from profiles where id = ${id} and org_id = ${await this.orgId()}`
    return r ? toProfile(r) : null
  }
  async getTokenHash(userId: string) {
    if (!UUID_RE.test(userId)) return null
    const [r] = await this.sql`select token_hash from profiles where id = ${userId} and org_id = ${await this.orgId()}`
    return r ? (r.token_hash as string) : null
  }
  async listProfiles() {
    const rows = await this.sql`select * from profiles where org_id = ${await this.orgId()} order by created_at`
    return rows.map(toProfile)
  }
  async createProfile(p: NewProfile) {
    const [r] = await this.sql`insert into profiles (org_id, name, email, title, role, manager_id, can_publish_skills, token_hash)
      values (${await this.orgId()}, ${p.name}, ${p.email ?? null}, ${p.title ?? null}, ${p.role}, ${p.manager_id ?? null},
        ${p.can_publish_skills ?? false}, ${p.token_hash}) returning *`
    return toProfile(r)
  }
  async updateProfile(id: string, patch: ProfilePatch) {
    const current = await this.sql`select * from profiles where id = ${id} and org_id = ${await this.orgId()}`
    if (!current[0]) return null
    const c = current[0]
    const [r] = await this.sql`update profiles set
        name = ${patch.name ?? c.name}, email = ${patch.email ?? c.email}, title = ${patch.title ?? c.title},
        role = ${patch.role ?? c.role}, token_hash = ${patch.token_hash ?? c.token_hash},
        manager_id = ${patch.manager_id === undefined ? c.manager_id : patch.manager_id},
        can_publish_skills = ${patch.can_publish_skills ?? c.can_publish_skills}
      where id = ${id} returning *`
    return toProfile(r)
  }

  async listZones() {
    const org = await this.orgId()
    // The core comes after the other zones: the first zone stays a team's (the fallback of a classification, here and
    // in the clients already installed on the workstations).
    const rows = await this.sql`select * from zones where org_id = ${org} order by id = ${CORE_ZONE.id}, position, id`
    if (rows.some((r) => r.id === CORE_ZONE.id)) return rows.map(toZone)
    // Every brain has its core: created the first time it is missing.
    const z = CORE_ZONE
    await this.sql`insert into zones (org_id, id, name, description, color, keywords, position)
      values (${org}, ${z.id}, ${z.name}, ${z.description}, ${z.color}, ${this.sql.array(z.keywords)}, ${z.position})
      on conflict (org_id, id) do nothing`
    return [...rows.map(toZone), { ...z }]
  }
  async upsertZone(z: Zone) {
    await this.sql`insert into zones (org_id, id, name, description, color, keywords, position)
      values (${await this.orgId()}, ${z.id}, ${z.name}, ${z.description}, ${z.color}, ${this.sql.array(z.keywords)}, ${z.position})
      on conflict (org_id, id) do update set name = excluded.name, description = excluded.description,
        color = excluded.color, keywords = excluded.keywords, position = excluded.position`
    // Apart: a database not migrated yet (a preview sharing production's) keeps working for everything else.
    if (z.projects !== undefined) {
      try {
        await this.sql`update zones set projects = ${this.sql.array(z.projects)} where org_id = ${await this.orgId()} and id = ${z.id}`
      } catch (err) {
        if (!missingColumn(err)) throw err
        if (z.projects.length) throw new StoreSetupError(ZONE_PROJECTS_MISSING_MESSAGE)
      }
    }
    return z
  }
  async listZoneAccess(userId?: string): Promise<ZoneAccess[]> {
    const org = await this.orgId()
    const rows = userId
      ? await this.sql`select user_id, zone_id, can_write from zone_access where org_id = ${org} and user_id = ${userId}`
      : await this.sql`select user_id, zone_id, can_write from zone_access where org_id = ${org}`
    return rows.map((r) => ({ user_id: r.user_id, zone_id: r.zone_id, can_write: r.can_write }))
  }
  async setZoneAccess(userId: string, access: { zone_id: string; can_write: boolean }[]) {
    const org = await this.orgId()
    await this.sql.begin(async (tx: any) => {
      await tx`delete from zone_access where user_id = ${userId} and org_id = ${org}`
      for (const a of access) {
        await tx`insert into zone_access (org_id, user_id, zone_id, can_write) values (${org}, ${userId}, ${a.zone_id}, ${a.can_write})`
      }
    })
  }

  /** True if the 20261017000006 migration (superseded_by, embedding) is applied; otherwise queries do without it. */
  private async hasQuality(): Promise<boolean> {
    if (this.qualityColumns !== null) return this.qualityColumns
    const [r] = await this.sql`select exists (select 1 from information_schema.columns where table_name = 'knowledge_items' and column_name = 'superseded_by') as ok`
    this.qualityColumns = Boolean(r.ok)
    return this.qualityColumns
  }

  /** external_* columns of tasks (connectors migration): absent, no task is imported. */
  private async hasTaskExternal(): Promise<boolean> {
    if (this.taskExternalColumns !== null) return this.taskExternalColumns
    const [r] = await this.sql`select exists (select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'external_source') as ok`
    this.taskExternalColumns = Boolean(r.ok)
    return this.taskExternalColumns
  }

  /** "Not superseded" fragment (bare table or alias `k`), empty while the column does not exist. */
  private live(hasQuality: boolean, alias: "" | "k" = "") {
    if (!hasQuality) return this.sql``
    return alias === "k" ? this.sql`and k.superseded_by is null` : this.sql`and superseded_by is null`
  }

  async insertItems(items: NewItem[]) {
    const org = await this.orgId()
    const quality = await this.hasQuality()
    return this.sql.begin(async (tx: any) => {
      const out: KnowledgeItem[] = []
      for (const i of items) {
        const searchTitle = normalize(i.title)
        const searchBody = normalize(`${i.body} ${i.entities.map((e) => e.name).join(" ")}`)
        const [r] = quality
          ? await tx`insert into knowledge_items
            (org_id, author_id, zone, kind, title, body, entities, source, confidence, search_title, search_body, created_at, embedding, embedding_model)
          values (${org}, ${i.author_id}, ${i.zone}, ${i.kind}, ${i.title}, ${i.body}, ${tx.json(i.entities)}, ${tx.json(i.source)},
            ${i.confidence}, ${searchTitle}, ${searchBody}, ${i.created_at ?? new Date().toISOString()},
            ${i.embedding ? tx.array(i.embedding) : null}, ${i.embedding ? (i.embedding_model ?? null) : null})
          returning *`
          : await tx`insert into knowledge_items
            (org_id, author_id, zone, kind, title, body, entities, source, confidence, search_title, search_body, created_at)
          values (${org}, ${i.author_id}, ${i.zone}, ${i.kind}, ${i.title}, ${i.body}, ${tx.json(i.entities)}, ${tx.json(i.source)},
            ${i.confidence}, ${searchTitle}, ${searchBody}, ${i.created_at ?? new Date().toISOString()})
          returning *`
        for (const e of i.entities) {
          const [ent] = await tx`insert into entities (org_id, type, name, norm_name) values (${org}, ${e.type}, ${e.name}, ${normalize(e.name)})
            on conflict (org_id, type, norm_name) do update set name = excluded.name returning id`
          await tx`insert into edges (org_id, item_id, entity_id) values (${org}, ${r.id}, ${ent.id}) on conflict do nothing`
        }
        out.push(toItem(r))
      }
      return out
    }) as Promise<KnowledgeItem[]>
  }

  async searchItems(query: string, zones: string[], limit: number, opts: { authorId?: string } = {}): Promise<ScoredItem[]> {
    const terms = tsTerms(query)
    const sql = this.sql
    const author = opts.authorId && UUID_RE.test(opts.authorId) ? opts.authorId : null
    if (terms.length === 0 || (zones.length === 0 && !author)) return []
    // Readable zones, plus the author's own items (right of review), whatever their zone.
    const scope =
      zones.length && author
        ? sql`(k.zone in ${sql(zones)} or k.author_id = ${author})`
        : zones.length
          ? sql`k.zone in ${sql(zones)}`
          : sql`k.author_id = ${author}`
    // Score weighted by the share of terms found, like the file store.
    const rows = await sql`
      select k.*, ts_rank_cd(k.search, q) * (
          (select count(*) from unnest(${sql.array(terms)}::text[]) t where k.search @@ to_tsquery('simple', t))::float / ${terms.length}
        ) as score
      from knowledge_items k, to_tsquery('simple', ${terms.join(" | ")}) q
      where k.org_id = ${await this.orgId()} and ${scope} and k.search @@ q ${this.live(await this.hasQuality(), "k")}
      order by score desc, k.created_at desc
      limit ${limit}`
    return rows.map((r) => ({ ...toItem(r), score: Math.round(Number(r.score) * 1000) / 100 }))
  }

  async listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string; excludeSuperseded?: boolean }) {
    if (f.zones && f.zones.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      select * from knowledge_items
      where org_id = ${await this.orgId()}
        ${f.zones ? sql`and zone in ${sql(f.zones)}` : sql``}
        ${f.authorId ? sql`and author_id = ${f.authorId}` : sql``}
        ${f.sinceIso ? sql`and created_at >= ${f.sinceIso}` : sql``}
        ${f.excludeSuperseded ? this.live(await this.hasQuality()) : sql``}
      order by created_at desc
      limit ${f.limit ?? 1000}`
    return rows.map(toItem)
  }

  async markSuperseded(oldId: string, newId: string) {
    if (!UUID_RE.test(oldId) || !UUID_RE.test(newId)) return false
    // "Quality" migration not applied yet: the new knowledge item is already saved, ingestion does not fail because of
    // it (the computer would see a failed sync); the old one simply keeps being suggested.
    if (!(await this.hasQuality())) {
      if (!this.qualityWarned) {
        this.qualityWarned = true
        console.error(`[store] ${QUALITY_MISSING_MESSAGE} Superseded knowledge keeps being suggested in the meantime.`)
      }
      return false
    }
    const org = await this.orgId()
    const rows = await this.sql`update knowledge_items set superseded_by = ${newId} where id = ${oldId} and org_id = ${org}
      and exists (select 1 from knowledge_items n where n.id = ${newId} and n.org_id = ${org}) returning id`
    return rows.length > 0
  }

  async listItemsByEntity(f: { type: string; normName: string; zones: string[]; authorId?: string; limit?: number }) {
    const sql = this.sql
    const author = f.authorId && UUID_RE.test(f.authorId) ? f.authorId : null
    if (f.zones.length === 0 && !author) return []
    const scope = f.zones.length && author ? sql`(k.zone in ${sql(f.zones)} or k.author_id = ${author})` : f.zones.length ? sql`k.zone in ${sql(f.zones)}` : sql`k.author_id = ${author}`
    const rows = await sql`
      select distinct k.* from knowledge_items k
      join edges ed on ed.item_id = k.id
      join entities e on e.id = ed.entity_id
      where k.org_id = ${await this.orgId()} and e.type = ${f.type} and e.norm_name = ${f.normName} and ${scope} ${this.live(await this.hasQuality(), "k")}
      order by k.created_at desc
      limit ${f.limit ?? 100}`
    return rows.map(toItem)
  }

  async listEmbeddings(f: { zones: string[]; authorId?: string; limit?: number }) {
    if (!(await this.hasQuality())) return []
    const sql = this.sql
    const author = f.authorId && UUID_RE.test(f.authorId) ? f.authorId : null
    if (f.zones.length === 0 && !author) return []
    const scope = f.zones.length && author ? sql`(zone in ${sql(f.zones)} or author_id = ${author})` : f.zones.length ? sql`zone in ${sql(f.zones)}` : sql`author_id = ${author}`
    const rows = await sql`select id, embedding from knowledge_items where org_id = ${await this.orgId()} and ${scope}
      and embedding is not null and superseded_by is null order by created_at desc limit ${f.limit ?? 2000}`
    return rows.map((r) => ({ id: r.id as string, embedding: (r.embedding as number[]).map(Number) }))
  }

  async setEmbeddings(rows: { id: string; embedding: number[]; model: string }[]) {
    if (!rows.length) return
    if (!(await this.hasQuality())) throw new StoreSetupError(QUALITY_MISSING_MESSAGE)
    const org = await this.orgId()
    await this.sql.begin(async (tx: any) => {
      for (const r of rows) {
        if (!UUID_RE.test(r.id)) continue
        await tx`update knowledge_items set embedding = ${tx.array(r.embedding)}, embedding_model = ${r.model} where id = ${r.id} and org_id = ${org}`
      }
    })
  }

  async listItemsWithoutEmbedding(model: string, limit: number) {
    if (!(await this.hasQuality())) throw new StoreSetupError(QUALITY_MISSING_MESSAGE)
    const rows = await this.sql`select * from knowledge_items where org_id = ${await this.orgId()} and superseded_by is null
      and (embedding is null or embedding_model is distinct from ${model}) order by created_at desc limit ${limit}`
    return rows.map(toItem)
  }
  async getItem(id: string) {
    if (!UUID_RE.test(id)) return null
    const [r] = await this.sql`select * from knowledge_items where id = ${id} and org_id = ${await this.orgId()}`
    return r ? toItem(r) : null
  }
  async deleteItem(id: string) {
    if (!UUID_RE.test(id)) return false
    const org = await this.orgId()
    const external = await this.hasTaskExternal()
    return this.sql.begin(async (tx: any) => {
      // Before the item: the foreign key (on delete set null) would otherwise detach its tasks, which would stay on the board.
      await tx`delete from tasks where org_id = ${org} and source_item_id = ${id} ${external ? tx`and external_source is null` : tx``}`
      const rows = await tx`delete from knowledge_items where id = ${id} and org_id = ${org} returning id`
      return rows.length > 0
    }) as Promise<boolean>
  }
  async updateItem(id: string, patch: { title: string; body: string; kind: KnowledgeItem["kind"]; zone: string }) {
    if (!UUID_RE.test(id)) return false
    const org = await this.orgId()
    const quality = await this.hasQuality()
    return this.sql.begin(async (tx: any) => {
      const [cur] = await tx`select entities from knowledge_items where id = ${id} and org_id = ${org}`
      if (!cur) return false
      const entities = (cur.entities ?? []) as { name: string }[]
      const searchTitle = normalize(patch.title)
      const searchBody = normalize(`${patch.body} ${entities.map((e) => e.name).join(" ")}`)
      await tx`update knowledge_items set title = ${patch.title}, body = ${patch.body}, kind = ${patch.kind}, zone = ${patch.zone},
        search_title = ${searchTitle}, search_body = ${searchBody} where id = ${id} and org_id = ${org}`
      if (quality) await tx`update knowledge_items set embedding = null, embedding_model = null where id = ${id} and org_id = ${org}`
      await tx`update tasks set zone = ${patch.zone}, updated_at = now() where org_id = ${org} and source_item_id = ${id} and zone <> ${patch.zone}`
      return true
    }) as Promise<boolean>
  }
  async moveItems(ids: string[], zone: string) {
    const valid = ids.filter((id) => UUID_RE.test(id))
    if (valid.length === 0) return 0
    const org = await this.orgId()
    return this.sql.begin(async (tx: any) => {
      const rows = await tx`update knowledge_items set zone = ${zone} where org_id = ${org} and id in ${tx(valid)} and zone <> ${zone} returning id`
      await tx`update tasks set zone = ${zone}, updated_at = now() where org_id = ${org} and source_item_id in ${tx(valid)}`
      return rows.length
    }) as Promise<number>
  }

  async zoneStats(): Promise<ZoneStat[]> {
    const rows = await this.sql`
      select zone, count(*)::int as count, max(created_at) as last_at, count(distinct author_id)::int as contributors
      from knowledge_items where org_id = ${await this.orgId()} group by zone`
    return rows.map((r) => ({ zone: r.zone, count: r.count, last_at: isoOrNull(r.last_at), contributors: r.contributors }))
  }

  async authorZoneStats(): Promise<AuthorZoneStat[]> {
    const rows = await this.sql`
      select author_id, zone, count(*)::int as count
      from knowledge_items where org_id = ${await this.orgId()} group by author_id, zone`
    return rows.map((r) => ({ author_id: r.author_id, zone: r.zone, count: r.count }))
  }

  async topEntities(f: { zones?: string[]; authorId?: string; limit: number }): Promise<EntityStat[]> {
    if (f.zones && f.zones.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      select e.type, e.name, count(*)::int as count, array_agg(distinct k.zone) as zones
      from edges ed
      join entities e on e.id = ed.entity_id
      join knowledge_items k on k.id = ed.item_id
      where k.org_id = ${await this.orgId()}
        ${f.zones ? sql`and k.zone in ${sql(f.zones)}` : sql``}
        ${f.authorId ? sql`and k.author_id = ${f.authorId}` : sql``}
      group by e.id, e.type, e.name
      order by count desc, e.name
      limit ${f.limit}`
    return rows.map((r) => ({ type: r.type, name: r.name, count: r.count, zones: r.zones ?? [] }))
  }

  async insertEvents(events: NewEvent[]) {
    const org = await this.orgId()
    return this.sql.begin(async (tx: any) => {
      const out: AgentEvent[] = []
      for (const e of events) {
        const [r] = await tx`insert into agent_events (org_id, user_id, agent, type, zones, summary, fingerprint, session_id, at)
          values (${org}, ${e.user_id}, ${e.agent}, ${e.type}, ${tx.array(e.zones)}, ${e.summary ?? null}, ${e.fingerprint ?? null},
            ${e.session_id ?? null}, ${e.at}) returning *`
        out.push(toEvent(r))
      }
      // Wakes up the real-time streams of all instances (delivered on commit; without migration or trigger).
      if (out.length) await tx`select pg_notify(${EVENTS_CHANNEL}, ${org})`
      return out
    }) as Promise<AgentEvent[]>
  }

  async listEvents(f: { afterId?: number; sinceIso?: string; limit?: number; type?: string; userId?: string }) {
    const sql = this.sql
    const limit = f.limit ?? 100
    const where = sql`
      org_id = ${await this.orgId()}
      ${f.afterId !== undefined ? sql`and id > ${f.afterId}` : sql``}
      ${f.sinceIso ? sql`and at >= ${f.sinceIso}` : sql``}
      ${f.type ? sql`and type = ${f.type}` : sql``}
      ${f.userId ? sql`and user_id = ${f.userId}` : sql``}`
    const rows =
      f.afterId !== undefined
        ? await sql`select * from agent_events where ${where} order by id asc limit ${limit}`
        : await sql`select * from agent_events where ${where} order by id desc limit ${limit}`
    return rows.map(toEvent)
  }

  async listTasks(f: { zones?: string[]; assigneeId?: string }) {
    if (f.zones && f.zones.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      select * from tasks where org_id = ${await this.orgId()}
        ${f.zones ? sql`and zone in ${sql(f.zones)}` : sql``}
        ${f.assigneeId ? sql`and assignee_id = ${f.assigneeId}` : sql``}
      order by (status = 'open') desc, created_at desc`
    return rows.map(toTask)
  }
  async createTasks(tasks: NewTask[]) {
    const org = await this.orgId()
    const out: Task[] = []
    for (const t of tasks) {
      const [r] = await this.sql`insert into tasks (org_id, title, zone, assignee_id, status, source_item_id, created_at)
        values (${org}, ${t.title}, ${t.zone}, ${t.assignee_id ?? null}, ${t.status}, ${t.source_item_id ?? null},
          ${t.created_at ?? new Date().toISOString()}) returning *`
      out.push(toTask(r))
    }
    return out
  }
  async upsertExternalTasks(source: string, tasks: NewTask[]) {
    const org = await this.orgId()
    const sql = this.sql
    try {
      return (await sql.begin(async (tx: any) => {
        const out: Task[] = []
        const ids: string[] = []
        for (const t of tasks) {
          if (!t.external_id) continue
          ids.push(t.external_id)
          const [r] = await tx`insert into tasks (org_id, title, zone, status, external_source, external_id, external_url, created_at)
            values (${org}, ${t.title}, ${t.zone}, ${t.status}, ${source}, ${t.external_id}, ${t.external_url ?? null}, ${t.created_at ?? new Date().toISOString()})
            on conflict (org_id, external_source, external_id) where external_id is not null do update set
              title = excluded.title, zone = excluded.zone, status = excluded.status, external_url = excluded.external_url,
              updated_at = case when tasks.title is distinct from excluded.title or tasks.status is distinct from excluded.status
                or tasks.zone is distinct from excluded.zone or tasks.external_url is distinct from excluded.external_url then now() else tasks.updated_at end
            returning *`
          out.push(toTask(r))
        }
        // Closed or deleted in the tool: done here.
        const closed = await tx`update tasks set status = 'done', updated_at = now()
          where org_id = ${org} and external_source = ${source} and status = 'open' and external_id is not null
          ${ids.length ? tx`and external_id not in ${tx(ids)}` : tx``} returning *`
        for (const r of closed) out.push(toTask(r))
        return out
      })) as Task[]
    } catch (err) {
      if (missingColumn(err)) throw new StoreSetupError(TASKS_EXTERNAL_MISSING_MESSAGE)
      throw err
    }
  }

  async updateTask(id: string, patch: { status?: Task["status"]; assignee_id?: string }) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [c] = await this.sql`select * from tasks where id = ${id} and org_id = ${await this.orgId()}`
    if (!c) return null
    const [r] = await this.sql`update tasks set status = ${patch.status ?? c.status}, assignee_id = ${patch.assignee_id ?? c.assignee_id},
      updated_at = now() where id = ${id} returning *`
    return toTask(r)
  }

  /** Query on documents: missing table (migration not applied) → clear configuration error (503). */
  private async documents<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(DOCUMENTS_MISSING_MESSAGE)
      throw err
    }
  }

  async insertDocument(d: NewDocument) {
    const org = await this.orgId()
    const items = d.item_ids.filter((id) => UUID_RE.test(id))
    const [r] = await this.documents(() => this.sql`insert into documents
      (org_id, author_id, zone, name, mime, size, sha256, title, summary, pages, source, item_ids, content, text, search_title, search_body, created_at)
      values (${org}, ${d.author_id}, ${d.zone}, ${d.name}, ${d.mime}, ${d.size}, ${d.sha256}, ${d.title}, ${d.summary}, ${d.pages ?? null},
        ${this.sql.json(d.source)}, ${this.sql.array(items)}::uuid[], ${d.content}, ${d.text}, ${normalize(`${d.name} ${d.title}`)},
        ${normalize(d.text.slice(0, DOCUMENT_SEARCH_CHARS))}, ${d.created_at ?? new Date().toISOString()})
      returning ${this.sql(DOCUMENT_COLUMNS)}`)
    return toDocument(r)
  }
  async findDocumentBySha(sha256: string) {
    const org = await this.orgId()
    const [r] = await this.documents(() => this.sql`select ${this.sql(DOCUMENT_COLUMNS)} from documents where org_id = ${org} and sha256 = ${sha256}`)
    return r ? toDocument(r) : null
  }
  async getDocument(id: string) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.documents(() => this.sql`select ${this.sql(DOCUMENT_COLUMNS)}, text from documents where id = ${id} and org_id = ${org}`)
    return r ? { ...toDocument(r), text: r.text as string } : null
  }
  async getDocumentContent(id: string) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.documents(() => this.sql`select content from documents where id = ${id} and org_id = ${org}`)
    return r ? Buffer.from(r.content as Uint8Array) : null
  }
  async listDocuments(f: DocumentFilter) {
    const sql = this.sql
    const author = f.orAuthorId && UUID_RE.test(f.orAuthorId) ? f.orAuthorId : null
    if (f.zones && f.zones.length === 0 && !author) return []
    const items = f.itemIds?.filter((id) => UUID_RE.test(id))
    if (items && items.length === 0) return []
    const scope = !f.zones
      ? sql``
      : f.zones.length && author
        ? sql`and (zone in ${sql(f.zones)} or author_id = ${author})`
        : f.zones.length
          ? sql`and zone in ${sql(f.zones)}`
          : sql`and author_id = ${author}`
    const org = await this.orgId()
    const rows = await this.documents(() => sql`
      select ${sql(DOCUMENT_COLUMNS)} from documents
      where org_id = ${org} ${scope}
        ${f.zone ? sql`and zone = ${f.zone}` : sql``}
        ${items ? sql`and item_ids && ${sql.array(items)}::uuid[]` : sql``}
      order by created_at desc
      limit ${f.limit ?? 1000}`)
    return rows.map(toDocument)
  }
  async searchDocuments(query: string, zones: string[], limit: number, opts: { authorId?: string } = {}): Promise<ScoredDocument[]> {
    const terms = tsTerms(query)
    const sql = this.sql
    const author = opts.authorId && UUID_RE.test(opts.authorId) ? opts.authorId : null
    if (terms.length === 0 || (zones.length === 0 && !author)) return []
    const scope =
      zones.length && author ? sql`(d.zone in ${sql(zones)} or d.author_id = ${author})` : zones.length ? sql`d.zone in ${sql(zones)}` : sql`d.author_id = ${author}`
    const org = await this.orgId()
    const rows = await this.documents(() => sql`
      select ${sql(DOCUMENT_COLUMNS.map((c) => `d.${c}`))}, ts_rank_cd(d.search, q) * (
          (select count(*) from unnest(${sql.array(terms)}::text[]) t where d.search @@ to_tsquery('simple', t))::float / ${terms.length}
        ) as score
      from documents d, to_tsquery('simple', ${terms.join(" | ")}) q
      where d.org_id = ${org} and ${scope} and d.search @@ q
      order by score desc, d.created_at desc
      limit ${limit}`)
    return rows.map((r) => ({ ...toDocument(r), score: Math.round(Number(r.score) * 1000) / 100 }))
  }
  async linkDocument(id: string, itemIds: string[]) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const items = itemIds.filter((x) => UUID_RE.test(x))
    const [r] = await this.documents(() => this.sql`update documents
      set item_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(item_ids || ${this.sql.array(items)}::uuid[]) x)
      where id = ${id} and org_id = ${org}
      returning ${this.sql(DOCUMENT_COLUMNS)}`)
    return r ? toDocument(r) : null
  }
  async deleteDocument(id: string) {
    if (!UUID_RE.test(id)) return false
    const org = await this.orgId()
    const rows = await this.documents(() => this.sql`delete from documents where id = ${id} and org_id = ${org} returning id`)
    return rows.length > 0
  }

  async listAutomations() {
    const rows = await this.sql`select * from automation_suggestions where org_id = ${await this.orgId()}
      order by minutes_saved_per_week desc, created_at desc`
    return rows.map(toAutomation)
  }
  async upsertAutomations(cands: Parameters<BrainStore["upsertAutomations"]>[0]) {
    const org = await this.orgId()
    const out: AutomationSuggestion[] = []
    for (const c of cands) {
      const [r] = await this.sql`insert into automation_suggestions
          (org_id, key, user_id, zone, title, description, schedule, evidence, minutes_saved_per_week, source)
        values (${org}, ${c.key}, ${c.user_id ?? null}, ${c.zone ?? null}, ${c.title}, ${c.description}, ${c.schedule ?? null},
          ${this.sql.json(c.evidence)}, ${c.minutes_saved_per_week}, ${c.source})
        on conflict (org_id, key) do update set user_id = excluded.user_id, zone = excluded.zone, title = excluded.title,
          description = excluded.description, schedule = excluded.schedule, evidence = excluded.evidence,
          minutes_saved_per_week = excluded.minutes_saved_per_week
        returning *`
      out.push(toAutomation(r))
    }
    return out
  }
  async updateAutomation(id: string, patch: { status: AutomationSuggestion["status"] }) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [r] = await this.sql`update automation_suggestions set status = ${patch.status}
      where id = ${id} and org_id = ${await this.orgId()} returning *`
    return r ? toAutomation(r) : null
  }

  /** Query on skills: missing table (migration not applied) → clear configuration error (503). */
  private async skills<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(SKILLS_MISSING_MESSAGE)
      throw err
    }
  }

  async listSkills() {
    const org = await this.orgId()
    const rows = await this.skills(() => this.sql`select * from skills where org_id = ${org} order by name`)
    return rows.map(toSkill)
  }
  async getSkill(id: string) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.skills(() => this.sql`select * from skills where id = ${id} and org_id = ${org}`)
    return r ? toSkill(r) : null
  }
  async getSkillByName(name: string) {
    const org = await this.orgId()
    const [r] = await this.skills(() => this.sql`select * from skills where name = ${name} and org_id = ${org}`)
    return r ? toSkill(r) : null
  }
  async publishSkill(s: NewSkill) {
    const org = await this.orgId()
    // Same name: new version (the original author is kept), in one statement (two simultaneous publications chain).
    const [r] = await this.skills(() => this.sql`insert into skills (org_id, name, description, zone, files, author_id, updated_by)
      values (${org}, ${s.name}, ${s.description}, ${s.zone}, ${this.sql.json(s.files)}, ${s.publisher_id}, ${s.publisher_id})
      on conflict (org_id, name) do update set description = excluded.description, zone = excluded.zone, files = excluded.files,
        updated_by = excluded.updated_by, version = skills.version + 1, updated_at = now()
      returning *`)
    return toSkill(r)
  }
  async updateSkill(id: string, patch: { zone: string | null }) {
    if (!UUID_RE.test(id)) return null
    const org = await this.orgId()
    const [r] = await this.skills(() => this.sql`update skills set zone = ${patch.zone}, updated_at = now()
      where id = ${id} and org_id = ${org} returning *`)
    return r ? toSkill(r) : null
  }
  async deleteSkill(id: string) {
    if (!UUID_RE.test(id)) return false
    const org = await this.orgId()
    const rows = await this.skills(() => this.sql`delete from skills where id = ${id} and org_id = ${org} returning id`)
    return rows.length > 0
  }

  async getStatus() {
    const [r] = await this.sql`select content from company_status where org_id = ${await this.orgId()}`
    return r ? (r.content as CompanyStatus) : null
  }
  async setStatus(s: CompanyStatus) {
    await this.sql`insert into company_status (org_id, content, generated_at) values (${await this.orgId()}, ${this.sql.json(s as any)}, now())
      on conflict (org_id) do update set content = excluded.content, generated_at = now()`
  }

  async getSessionSecret() {
    if (this.secret) return this.secret
    try {
      // Several instances may start at the same time: the first insertion wins, all re-read the same value.
      await this.sql`insert into brain_settings (key, value) values ('session_secret', ${randomBytes(32).toString("hex")})
        on conflict (key) do nothing`
      const [r] = await this.sql`select value from brain_settings where key = 'session_secret'`
      this.secret = r.value as string
      return this.secret
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(SETTINGS_MISSING_MESSAGE)
      throw err
    }
  }

  /** Query on brain_settings: missing table (migration not applied) → clear configuration error (503). */
  private async settings<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(SETTINGS_MISSING_MESSAGE)
      throw err
    }
  }

  async migrationStatus() {
    try {
      const [r] = await this.sql`select count(*)::int as n, max(name) as last from brain_migrations`
      return { applied: Number(r.n), last: (r.last as string | null) ?? null }
    } catch (err) {
      if (missingTable(err)) return { applied: 0, last: null }
      throw err
    }
  }

  async isEmpty() {
    const has = await this.hasSettings()
    const [r] = await this.sql`select not exists (select 1 from profiles p where ${this.notTenant("p.org_id", has)}) as empty`
    return Boolean(r.empty)
  }

  async claimOnce(key: string) {
    const rows = await this.settings(() => this.sql`insert into brain_settings (key, value) values (${`claim:${key}`}, ${new Date().toISOString()})
      on conflict (key) do nothing returning key`)
    return rows.length === 1
  }

  async releaseClaim(key: string) {
    await this.settings(() => this.sql`delete from brain_settings where key = ${`claim:${key}`}`)
  }

  async finishClaim(key: string) {
    await this.settings(() => this.sql`update brain_settings set value = 'done' where key = ${`claim:${key}`}`)
  }

  async isClaimDone(key: string) {
    const [r] = await this.settings(() => this.sql`select value from brain_settings where key = ${`claim:${key}`}`)
    return r?.value === "done"
  }

  /** Purge and new organization in ONE transaction: no other instance ever sees the table empty. */
  async reset(org: { name: string; description: string }) {
    if (this.fixedOrgId) throw new Error("reset is only available on the root store.")
    const has = await this.hasSettings()
    const created = (await this.sql.begin(async (tx: any) => {
      await tx`select pg_advisory_xact_lock(${ORG_LOCK_KEY})`
      // Companies created from /create survive the demo reseed.
      await tx`delete from orgs where ${this.notTenant("orgs.id", has)}`
      return this.insertOrg(tx, org)
    })) as Org
    this.orgCache = { org: created, at: Date.now() }
  }

  async end() {
    if (this.fixedOrgId) return
    const st = this.listen
    if (st.handle) await st.handle.unlisten().catch(() => {})
    if (st.sql) await st.sql.end({ timeout: 5 }).catch(() => {})
    st.status = "idle"
    st.handle = null
    await this.sql.end({ timeout: 5 })
  }
}
