// Stockage Postgres (Supabase ou autre). Schéma : supabase/migrations/.
// Une instance = une organisation : la racine sert la plus ancienne de la table `orgs` (hors entreprises créées depuis
// /creer), `forOrg` sert une entreprise donnée en partageant la même connexion.

import { randomBytes } from "node:crypto"
import postgres from "postgres"
import {
  DEFAULT_ZONES,
  normalize,
  tokenize,
  type AgentEvent,
  type AutomationSuggestion,
  type CompanyStatus,
  type KnowledgeItem,
  type Org,
  type Profile,
  type ScoredItem,
  type Skill,
  type Task,
  type Zone,
  type ZoneAccess,
} from "@brain/core"
import type { BrainStore, EntityStat, JoinRequest, JoinStatus, NewEvent, NewItem, NewJoinRequest, NewProfile, NewSkill, NewTask, NewTenantOrg, ProfilePatch, ZoneStat, AuthorZoneStat } from "./types"
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
  return { id: r.id, name: r.name, description: r.description, color: r.color, keywords: r.keywords ?? [], position: r.position }
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
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
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

/** Table skills absente : la migration des skills n'a pas été appliquée. */
const SKILLS_MISSING_MESSAGE =
  "Base de données à mettre à jour : la table skills est absente. Appliquez les migrations (npm run db:migrate)."

const UUID_RE = /^[0-9a-f-]{36}$/i
/** L'organisation est relue régulièrement : un reseed (ou un onboarding servi par une autre instance) est vu sans redémarrage. */
const ORG_TTL_MS = 5_000
/** Verrou consultatif (transaction) qui sérialise la création de l'organisation et le reset. */
const ORG_LOCK_KEY = 7_204_331_117

/** Termes de recherche : préfixe seulement à partir de 4 caractères (comme le stockage fichier : « pr » ne doit pas trouver « produit »). */
function tsTerms(query: string): string[] {
  const tokens = [...new Set(tokenize(query))].filter((t) => /^[a-z0-9]+$/.test(t)).slice(0, 12)
  return tokens.map((t) => (t.length >= 4 ? `${t}:*` : t))
}

/** Une entreprise créée depuis /creer est marquée par une ligne `tenant:<id>` de brain_settings (pas de migration). */
const TENANT_PREFIX = "tenant:"
/** Code du message d'équipe d'une entreprise : `join:<org_id>` → `cj_…` dans brain_settings. */
const JOIN_PREFIX = "join:"

export class PostgresStore implements BrainStore {
  readonly kind = "postgres" as const
  private sql: Sql
  private orgCache: { org: Org; at: number } | null = null
  private orgPending: Promise<Org> | null = null
  private secret: string | null = null
  /** Entreprise servie par cette instance ; absent sur la racine (organisation de la base). */
  private readonly fixedOrgId: string | null
  private tenants = new Map<string, PostgresStore>()
  private settingsReady = false

  constructor(url: string | { sql: Sql; orgId: string }) {
    if (typeof url !== "string") {
      this.sql = url.sql
      this.fixedOrgId = url.orgId
      return
    }
    this.fixedOrgId = null
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
    const ssl = process.env.DATABASE_SSL === "disable" || local ? false : "require"
    // prepare: false → compatible avec le pooler Supabase en mode transaction (port 6543).
    this.sql = postgres(url, { prepare: false, max: Number(process.env.DATABASE_POOL_MAX ?? 5), idle_timeout: 20, ssl, onnotice: () => {} })
  }

  /** brain_settings existe-t-elle ? Sans elle (migration non appliquée), il n'y a simplement aucune entreprise créée. */
  private async hasSettings(): Promise<boolean> {
    if (this.settingsReady) return true
    const [r] = await this.sql`select to_regclass('brain_settings') is not null as ok`
    this.settingsReady = Boolean(r.ok)
    return this.settingsReady
  }

  /**
   * Fragment SQL « cette organisation n'est pas une entreprise créée depuis /creer ». Synchrone exprès : une fonction
   * async qui renvoie un fragment postgres.js l'exécuterait (c'est un thenable) au lieu de le renvoyer.
   */
  private notTenant(col: string, hasSettings: boolean) {
    if (!hasSettings) return this.sql`true`
    return this.sql`not exists (select 1 from brain_settings s where s.key = ${TENANT_PREFIX} || ${this.sql(col)}::text)`
  }

  forOrg(orgId: string): BrainStore {
    if (this.fixedOrgId) throw new Error("forOrg n'est disponible que sur le stockage racine.")
    if (!UUID_RE.test(orgId)) throw new Error("Entreprise introuvable.")
    let t = this.tenants.get(orgId)
    if (!t) {
      t = new PostgresStore({ sql: this.sql, orgId })
      this.tenants.set(orgId, t)
    }
    return t
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

  async findUserOrg(by: { id: string } | { tokenHash: string }) {
    if ("id" in by && !UUID_RE.test(by.id)) return null
    const [r] =
      "id" in by
        ? await this.sql`select org_id from profiles where id = ${by.id}`
        : await this.sql`select org_id from profiles where token_hash = ${by.tokenHash}`
    return r ? (r.org_id as string) : null
  }

  /**
   * L'organisation de cette base : la plus ancienne qui a des comptes (une org vide créée par erreur est ignorée).
   * Une org n'est créée QUE si la table est vide, au premier chargement de cette instance, jamais lors d'un
   * rafraîchissement du cache : une table vide pendant un rafraîchissement est transitoire (reset) ou anormale.
   */
  private async org(): Promise<Org> {
    const cached = this.orgCache
    if (cached && Date.now() - cached.at < ORG_TTL_MS) return cached.org
    if (!this.orgPending) {
      this.orgPending = (async () => {
        if (this.fixedOrgId) {
          const [r] = await this.sql`select * from orgs where id = ${this.fixedOrgId}`
          if (!r) throw new Error("Entreprise introuvable.")
          this.orgCache = { org: toOrg(r), at: Date.now() }
          return this.orgCache.org
        }
        let org = await this.selectOrg()
        if (!org && !cached) org = (await this.createOrgIfNone({ name: "Mon entreprise", description: "" })) ?? (await this.selectOrg())
        if (!org) {
          // Rafraîchissement sur une table vide : on garde l'org connue, sans prolonger le cache (relue au prochain appel).
          if (cached) return cached.org
          throw new Error("Aucune organisation dans la base.")
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

  /** Base neuve : crée l'org (et ses zones par défaut) seulement si la table est vide, en une instruction atomique. */
  private async createOrgIfNone(o: { name: string; description: string }): Promise<Org | null> {
    const has = await this.hasSettings()
    return this.sql.begin(async (tx: any) => {
      // Deux instances qui démarrent ensemble : la seconde attend, puis ne trouve plus la table vide.
      await tx`select pg_advisory_xact_lock(${ORG_LOCK_KEY})`
      const [org] = await tx`insert into orgs (name, description)
        select ${o.name}, ${o.description} where not exists (select 1 from orgs o where ${this.notTenant("o.id", has)}) returning *`
      if (!org) return null
      await this.insertDefaultZones(tx, org.id)
      return toOrg(org)
    }) as Promise<Org | null>
  }

  /** Nouvelle organisation et ses zones par défaut, dans la transaction `tx`. */
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

  /** Requête sur join_requests : table absente (migration non appliquée) → erreur de configuration claire (503). */
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
    // Insertion « une seule fois » : deux admins qui ouvrent la page ensemble voient le même code.
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
    const rows = await this.sql`select * from zones where org_id = ${await this.orgId()} order by position, id`
    return rows.map(toZone)
  }
  async upsertZone(z: Zone) {
    await this.sql`insert into zones (org_id, id, name, description, color, keywords, position)
      values (${await this.orgId()}, ${z.id}, ${z.name}, ${z.description}, ${z.color}, ${this.sql.array(z.keywords)}, ${z.position})
      on conflict (org_id, id) do update set name = excluded.name, description = excluded.description,
        color = excluded.color, keywords = excluded.keywords, position = excluded.position`
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

  async insertItems(items: NewItem[]) {
    const org = await this.orgId()
    return this.sql.begin(async (tx: any) => {
      const out: KnowledgeItem[] = []
      for (const i of items) {
        const searchTitle = normalize(i.title)
        const searchBody = normalize(`${i.body} ${i.entities.map((e) => e.name).join(" ")}`)
        const [r] = await tx`insert into knowledge_items
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
    // Zones lisibles, plus les items de l'auteur lui-même (droit de regard), quelle que soit leur zone.
    const scope =
      zones.length && author
        ? sql`(k.zone in ${sql(zones)} or k.author_id = ${author})`
        : zones.length
          ? sql`k.zone in ${sql(zones)}`
          : sql`k.author_id = ${author}`
    // Score pondéré par la part des termes trouvés, comme le stockage fichier.
    const rows = await sql`
      select k.*, ts_rank_cd(k.search, q) * (
          (select count(*) from unnest(${sql.array(terms)}::text[]) t where k.search @@ to_tsquery('simple', t))::float / ${terms.length}
        ) as score
      from knowledge_items k, to_tsquery('simple', ${terms.join(" | ")}) q
      where k.org_id = ${await this.orgId()} and ${scope} and k.search @@ q
      order by score desc, k.created_at desc
      limit ${limit}`
    return rows.map((r) => ({ ...toItem(r), score: Math.round(Number(r.score) * 1000) / 100 }))
  }

  async listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string }) {
    if (f.zones && f.zones.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      select * from knowledge_items
      where org_id = ${await this.orgId()}
        ${f.zones ? sql`and zone in ${sql(f.zones)}` : sql``}
        ${f.authorId ? sql`and author_id = ${f.authorId}` : sql``}
        ${f.sinceIso ? sql`and created_at >= ${f.sinceIso}` : sql``}
      order by created_at desc
      limit ${f.limit ?? 1000}`
    return rows.map(toItem)
  }
  async getItem(id: string) {
    if (!UUID_RE.test(id)) return null
    const [r] = await this.sql`select * from knowledge_items where id = ${id} and org_id = ${await this.orgId()}`
    return r ? toItem(r) : null
  }
  async deleteItem(id: string) {
    if (!UUID_RE.test(id)) return false
    const rows = await this.sql`delete from knowledge_items where id = ${id} and org_id = ${await this.orgId()} returning id`
    return rows.length > 0
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
  async updateTask(id: string, patch: { status?: Task["status"]; assignee_id?: string }) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [c] = await this.sql`select * from tasks where id = ${id} and org_id = ${await this.orgId()}`
    if (!c) return null
    const [r] = await this.sql`update tasks set status = ${patch.status ?? c.status}, assignee_id = ${patch.assignee_id ?? c.assignee_id},
      updated_at = now() where id = ${id} returning *`
    return toTask(r)
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

  /** Requête sur skills : table absente (migration non appliquée) → erreur de configuration claire (503). */
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
    // Même nom : nouvelle version (l'auteur d'origine est gardé), en une instruction (deux publications simultanées s'enchaînent).
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
      // Plusieurs instances peuvent démarrer en même temps : la première insertion gagne, toutes relisent la même valeur.
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

  /** Requête sur brain_settings : table absente (migration non appliquée) → erreur de configuration claire (503). */
  private async settings<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (missingTable(err)) throw new StoreSetupError(SETTINGS_MISSING_MESSAGE)
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

  /** Purge et nouvelle organisation dans UNE transaction : aucune autre instance ne voit jamais la table vide. */
  async reset(org: { name: string; description: string }) {
    if (this.fixedOrgId) throw new Error("reset n'est disponible que sur le stockage racine.")
    const has = await this.hasSettings()
    const created = (await this.sql.begin(async (tx: any) => {
      await tx`select pg_advisory_xact_lock(${ORG_LOCK_KEY})`
      // Les entreprises créées depuis /creer survivent au reseed de la démo.
      await tx`delete from orgs where ${this.notTenant("orgs.id", has)}`
      return this.insertOrg(tx, org)
    })) as Org
    this.orgCache = { org: created, at: Date.now() }
  }

  async end() {
    if (this.fixedOrgId) return
    await this.sql.end({ timeout: 5 })
  }
}
