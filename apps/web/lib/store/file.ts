// File store: the whole brain in one JSON file. Zero configuration, ideal for the demo on a laptop.

import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import {
  CORE_ZONE,
  DEFAULT_ZONES,
  normalize,
  sessionOf,
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
import { SYNC_REPORTS_KEEP, type BrainStore, type DocumentFilter, type EntityStat, type JoinRequest, type JoinStatus, type NewEvent, type NewItem, type NewDocument, type NewJoinRequest, type NewProfile, type NewSkill, type NewTask, type NewTenantOrg, type ProfilePatch, type ZoneStat, type ZoneUsage, type AuthorZoneStat } from "./types"
import { newJoinCode } from "./codes"

type StoredProfile = Profile & { token_hash: string }
/** An item in the file also carries its semantic vector (never returned to callers). */
type StoredItem = KnowledgeItem & { embedding?: number[]; embedding_model?: string }

function publicItem({ embedding: _e, embedding_model: _m, ...i }: StoredItem): KnowledgeItem {
  return i
}
type StoredJoinRequest = JoinRequest & { token_hash: string }

type Data = {
  version: 1
  org: Org
  profiles: StoredProfile[]
  zones: Zone[]
  zone_access: ZoneAccess[]
  items: StoredItem[]
  events: AgentEvent[]
  tasks: Task[]
  automations: AutomationSuggestion[]
  /** Missing from files written before skills. */
  skills?: Skill[]
  /** Documents' metadata (their text and bytes are files of the documents/ folder). Missing from older files. */
  documents?: BrainDocument[]
  status: CompanyStatus | null
  seq: { event: number }
  /** Added with the team message: missing from older files. */
  join_code?: string
  join_requests?: StoredJoinRequest[]
  settings?: Record<string, string>
  /** Workstation sync reports (monitoring), most recent at the end. */
  sync_reports?: SyncReportRow[]
}

const MAX_EVENTS = 20000
const ORG_ID_RE = /^[0-9a-f-]{36}$/i

/**
 * Real-time stream subscribers, per company, shared through globalThis: in `next dev`, two copies of this module (and two
 * store instances) may coexist; an insertion by one must wake up the streams opened by the other.
 */
const listeners = ((globalThis as unknown as { __brainFileListeners?: Map<string, Set<() => void>> }).__brainFileListeners ??= new Map())

function notifyOrg(orgId: string) {
  const set = listeners.get(orgId)
  if (!set) return
  // After writing the file, outside the locked section: a subscriber re-reading right away sees the events.
  queueMicrotask(() => {
    for (const fn of [...set]) {
      try {
        fn()
      } catch (err) {
        console.error("[store] stream subscriber:", err)
      }
    }
  })
}
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 10_000

/** Synchronous pause: the lock wraps synchronous code (read, change, write). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Identity of a version of the file: each write does a rename, hence a new inode. */
function versionKey(st: fs.Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`
}

function emptyData(org?: { name: string; description: string }): Data {
  return {
    version: 1,
    org: { id: randomUUID(), name: org?.name ?? "My company", description: org?.description ?? "", created_at: new Date().toISOString() },
    profiles: [],
    zones: DEFAULT_ZONES,
    zone_access: [],
    items: [],
    events: [],
    tasks: [],
    automations: [],
    skills: [],
    documents: [],
    status: null,
    seq: { event: 0 },
  }
}

function strip({ token_hash: _t, ...p }: StoredProfile): Profile {
  return p
}

export class FileStore implements BrainStore {
  readonly kind = "file" as const
  private dir: string
  private file: string
  private lockFile: string
  private data: Data | null = null
  private version = ""
  private locked = false
  private secret: string | null = null
  /** Companies created from /create: one folder each, under <dir>/orgs/<id>/ (root store only). */
  private tenants = new Map<string, FileStore>()

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.dir = dir
    this.file = path.join(dir, "brain.json")
    this.lockFile = `${this.file}.lock`
  }

  private stat(): fs.Stats | null {
    try {
      return fs.statSync(this.file)
    } catch {
      return null
    }
  }

  private readFile() {
    const fd = fs.openSync(this.file, "r")
    try {
      const st = fs.fstatSync(fd)
      this.data = JSON.parse(fs.readFileSync(fd, "utf8")) as Data
      this.version = versionKey(st)
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Latest version of the file (re-read if another process replaced it: seed, simulator, smoke). */
  private load(): Data {
    const st = this.stat()
    if (st) {
      if (!this.data || versionKey(st) !== this.version) this.readFile()
    } else if (!this.data) {
      this.withLock(() => {
        if (this.stat()) this.readFile()
        else {
          this.data = emptyData()
          this.save()
        }
      })
    }
    return this.data!
  }

  /**
   * Inter-process lock (file created with O_EXCL): the server, the simulator and the scripts write the same JSON
   * without losing each other's writes or reusing event ids.
   */
  private withLock<T>(fn: () => T): T {
    if (this.locked) return fn()
    const started = Date.now()
    let fd: number | undefined
    while (fd === undefined) {
      try {
        fd = fs.openSync(this.lockFile, "wx")
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
      try {
        // Abandoned lock (process killed mid-write): remove it.
        if (Date.now() - fs.statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(this.lockFile, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Brain locked by another process (${this.lockFile}).`)
      sleepSync(4 + Math.random() * 12)
    }
    this.locked = true
    try {
      fs.writeSync(fd, String(process.pid))
      return fn()
    } finally {
      this.locked = false
      fs.closeSync(fd)
      fs.rmSync(this.lockFile, { force: true })
    }
  }

  private save() {
    if (!this.data) return
    if (this.data.events.length > MAX_EVENTS) this.data.events = this.data.events.slice(-MAX_EVENTS)
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data))
    fs.renameSync(tmp, this.file)
    // Under lock: the file is necessarily the one just written.
    this.version = versionKey(fs.statSync(this.file))
  }

  /** Read the latest version, change and write, all under lock. */
  private mutate<T>(fn: (d: Data) => T): T {
    return this.withLock(() => {
      try {
        const out = fn(this.load())
        this.save()
        return out
      } catch (err) {
        // Memory possibly half-changed: the file will be re-read.
        this.data = null
        this.version = ""
        throw err
      }
    })
  }

  private get tenantsDir() {
    return path.join(this.dir, "orgs")
  }

  private tenantIds(): string[] {
    try {
      return fs.readdirSync(this.tenantsDir).filter((id) => ORG_ID_RE.test(id) && fs.existsSync(path.join(this.tenantsDir, id, "brain.json")))
    } catch {
      return []
    }
  }

  forOrg(orgId: string): BrainStore {
    if (orgId === this.load().org.id) return this
    let t = this.tenants.get(orgId)
    if (!t) {
      // Never a folder created for an unknown id: only createTenantOrg creates one.
      if (!ORG_ID_RE.test(orgId) || !fs.existsSync(path.join(this.tenantsDir, orgId, "brain.json"))) throw new Error("Company not found.")
      t = new FileStore(path.join(this.tenantsDir, orgId))
      this.tenants.set(orgId, t)
    }
    return t
  }

  async createTenantOrg(o: NewTenantOrg) {
    const id = randomUUID()
    const t = new FileStore(path.join(this.tenantsDir, id))
    const org: Org = { id, name: o.name, description: o.description, created_at: new Date().toISOString() }
    t.withLock(() => {
      t.data = { ...emptyData(), org, zones: o.zones }
      t.save()
    })
    this.tenants.set(id, t)
    return org
  }

  async countTenantOrgs() {
    return this.tenantIds().length
  }

  async listOrgIds() {
    return [this.load().org.id, ...this.tenantIds()]
  }

  async findUserOrg(by: { id: string } | { tokenHash: string }) {
    const match = (p: StoredProfile) => ("id" in by ? p.id === by.id : p.token_hash === by.tokenHash)
    const root = this.load()
    if (root.profiles.some(match)) return root.org.id
    for (const id of this.tenantIds()) {
      const t = this.forOrg(id) as FileStore
      if (t.load().profiles.some(match)) return id
    }
    return null
  }

  async findOrgByJoinCode(code: string) {
    const root = this.load()
    if (root.join_code === code) return root.org.id
    for (const id of this.tenantIds()) if ((this.forOrg(id) as FileStore).load().join_code === code) return id
    return null
  }

  async findJoinRequestOrg(id: string) {
    const has = (d: Data) => (d.join_requests ?? []).some((r) => r.id === id)
    const root = this.load()
    if (has(root)) return root.org.id
    for (const org of this.tenantIds()) if (has((this.forOrg(org) as FileStore).load())) return org
    return null
  }

  async getOrgSetting(name: string) {
    return this.load().settings?.[name] ?? null
  }

  async setOrgSetting(name: string, value: string | null) {
    this.mutate((d) => {
      d.settings ??= {}
      if (value === null) delete d.settings[name]
      else d.settings[name] = value
    })
  }

  async getJoinCode() {
    const current = this.load().join_code
    if (current) return current
    return this.mutate((d) => (d.join_code ??= newJoinCode()))
  }

  async rotateJoinCode() {
    return this.mutate((d) => (d.join_code = newJoinCode()))
  }

  async createJoinRequest(r: NewJoinRequest) {
    return this.mutate((d) => {
      const req: StoredJoinRequest = {
        id: randomUUID(),
        org_id: d.org.id,
        name: r.name ?? null,
        title: r.title ?? null,
        email: r.email ?? null,
        hostname: r.hostname ?? null,
        token_hash: r.token_hash,
        status: "pending",
        profile_id: null,
        created_at: new Date().toISOString(),
        decided_at: null,
      }
      ;(d.join_requests ??= []).push(req)
      const { token_hash: _t, ...out } = req
      return out
    })
  }

  async listJoinRequests(f: { status?: JoinStatus; limit?: number } = {}) {
    return (this.load().join_requests ?? [])
      .filter((r) => !f.status || r.status === f.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 100)
      .map(({ token_hash: _t, ...r }) => r)
  }

  async getJoinRequest(id: string) {
    return (this.load().join_requests ?? []).find((r) => r.id === id) ?? null
  }

  async decideJoinRequest(id: string, dec: { status: Exclude<JoinStatus, "pending">; profile_id?: string }) {
    return this.mutate((d) => {
      const r = (d.join_requests ?? []).find((x) => x.id === id && x.status === "pending")
      if (!r) return null
      r.status = dec.status
      r.profile_id = dec.profile_id ?? null
      r.decided_at = new Date().toISOString()
      const { token_hash: _t, ...out } = r
      return out
    })
  }

  async getOrg() {
    return this.load().org
  }
  async updateOrg(patch: Partial<Pick<Org, "name" | "description">>) {
    return this.mutate((d) => (d.org = { ...d.org, ...patch }))
  }

  async getProfileByTokenHash(hash: string) {
    const p = this.load().profiles.find((x) => x.token_hash === hash)
    return p ? strip(p) : null
  }
  async getProfile(id: string) {
    const p = this.load().profiles.find((x) => x.id === id)
    return p ? strip(p) : null
  }
  async getTokenHash(userId: string) {
    return this.load().profiles.find((x) => x.id === userId)?.token_hash ?? null
  }
  async listProfiles() {
    return this.load().profiles.map(strip)
  }
  async createProfile(p: NewProfile) {
    return this.mutate((d) => {
      const prof: StoredProfile = { id: randomUUID(), org_id: d.org.id, created_at: new Date().toISOString(), ...p, can_publish_skills: p.can_publish_skills ?? false }
      d.profiles.push(prof)
      return strip(prof)
    })
  }
  async updateProfile(id: string, patch: ProfilePatch) {
    return this.mutate((d) => {
      const p = d.profiles.find((x) => x.id === id)
      if (!p) return null
      Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))
      return strip(p)
    })
  }

  async listZones() {
    // Every brain has its core: created the first time it is missing.
    const hasCore = (d: Data) => d.zones.some((z) => z.id === CORE_ZONE.id)
    if (!hasCore(this.load())) this.mutate((d) => hasCore(d) || d.zones.push({ ...CORE_ZONE }))
    // The core comes after the other zones: the first zone stays a team's (the fallback of a classification).
    const last = (z: Zone) => (z.id === CORE_ZONE.id ? 1 : 0)
    return [...this.load().zones].sort((a, b) => last(a) - last(b) || a.position - b.position)
  }
  async upsertZone(z: Zone) {
    return this.mutate((d) => {
      const i = d.zones.findIndex((x) => x.id === z.id)
      if (i >= 0) d.zones[i] = z
      else d.zones.push(z)
      return z
    })
  }
  async listZoneAccess(userId?: string) {
    const all = this.load().zone_access
    return userId ? all.filter((a) => a.user_id === userId) : all
  }
  async setZoneAccess(userId: string, access: { zone_id: string; can_write: boolean }[]) {
    this.mutate((d) => {
      d.zone_access = d.zone_access.filter((a) => a.user_id !== userId).concat(access.map((a) => ({ user_id: userId, ...a })))
    })
  }

  async zoneUsage(id: string): Promise<ZoneUsage> {
    const d = this.load()
    const n = (rows: { zone?: string | null }[] | undefined) => (rows ?? []).filter((r) => r.zone === id).length
    return { items: n(d.items), tasks: n(d.tasks), documents: n(d.documents), skills: n(d.skills) }
  }
  async deleteZone(id: string) {
    return this.mutate((d) => {
      const before = d.zones.length
      d.zones = d.zones.filter((z) => z.id !== id)
      if (d.zones.length === before) return false
      d.zone_access = d.zone_access.filter((a) => a.zone_id !== id)
      for (const a of d.automations) if (a.zone === id) delete a.zone
      return true
    })
  }

  async insertItems(items: NewItem[]) {
    return this.mutate((d) =>
      items.map((i) => {
        const item: StoredItem = { ...i, id: randomUUID(), org_id: d.org.id, created_at: i.created_at ?? new Date().toISOString(), superseded_by: null }
        d.items.push(item)
        return publicItem(item)
      }),
    )
  }

  async markSuperseded(oldId: string, newId: string) {
    return this.mutate((d) => {
      const old = d.items.find((i) => i.id === oldId)
      if (!old || !d.items.some((i) => i.id === newId)) return false
      old.superseded_by = newId
      return true
    })
  }

  async listItemsByEntity(f: { type: string; normName: string; zones: string[]; authorId?: string; limit?: number }) {
    const allowed = new Set(f.zones)
    return this.load()
      .items.filter(
        (i) =>
          !i.superseded_by &&
          (allowed.has(i.zone) || (f.authorId && i.author_id === f.authorId)) &&
          i.entities.some((e) => e.type === f.type && normalize(e.name) === f.normName),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 100)
      .map(publicItem)
  }

  async listEmbeddings(f: { zones: string[]; authorId?: string; limit?: number }) {
    const allowed = new Set(f.zones)
    return (this.load().items as StoredItem[])
      .filter((i) => !i.superseded_by && Array.isArray(i.embedding) && (allowed.has(i.zone) || (f.authorId && i.author_id === f.authorId)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 2000)
      .map((i) => ({ id: i.id, embedding: i.embedding as number[] }))
  }

  async setEmbeddings(rows: { id: string; embedding: number[]; model: string }[]) {
    if (!rows.length) return
    this.mutate((d) => {
      const by = new Map(rows.map((r) => [r.id, r]))
      for (const i of d.items as StoredItem[]) {
        const r = by.get(i.id)
        if (r) {
          i.embedding = r.embedding
          i.embedding_model = r.model
        }
      }
    })
  }

  async listItemsWithoutEmbedding(model: string, limit: number) {
    return (this.load().items as StoredItem[])
      .filter((i) => !i.superseded_by && (!Array.isArray(i.embedding) || i.embedding_model !== model))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(publicItem)
  }

  async searchItems(query: string, zones: string[], limit: number, opts: { authorId?: string } = {}): Promise<ScoredItem[]> {
    const q = [...new Set(tokenize(query))]
    if (q.length === 0) return []
    const allowed = new Set(zones)
    const now = Date.now()
    const matches = (tokens: string[], t: string) => tokens.some((x) => x === t || (t.length >= 4 && x.startsWith(t)))
    const scored: ScoredItem[] = []
    for (const item of this.load().items) {
      if (item.superseded_by) continue
      if (!allowed.has(item.zone) && !(opts.authorId && item.author_id === opts.authorId)) continue
      const title = tokenize(item.title)
      const body = tokenize(item.body)
      const ents = item.entities.flatMap((e) => tokenize(e.name))
      let score = 0
      let hits = 0
      for (const t of q) {
        const s = (matches(title, t) ? 3 : 0) + (matches(ents, t) ? 2 : 0) + (matches(body, t) ? 1 : 0)
        if (s > 0) hits++
        score += s
      }
      if (score === 0) continue
      const ageDays = (now - new Date(item.created_at).getTime()) / 86400_000
      score = score * (hits / q.length) * (1 + 0.15 * Math.max(0, 1 - ageDays / 30))
      scored.push({ ...publicItem(item), score: Math.round(score * 100) / 100 })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  async listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string; excludeSuperseded?: boolean }) {
    const zones = f.zones ? new Set(f.zones) : null
    return this.load()
      .items.filter(
        (i) =>
          (!zones || zones.has(i.zone)) &&
          (!f.authorId || i.author_id === f.authorId) &&
          (!f.sinceIso || i.created_at >= f.sinceIso) &&
          (!f.excludeSuperseded || !i.superseded_by),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 1000)
      .map(publicItem)
  }
  async getItem(id: string) {
    const i = this.load().items.find((x) => x.id === id)
    return i ? publicItem(i) : null
  }
  async deleteItem(id: string) {
    return this.mutate((d) => {
      const before = d.items.length
      d.items = d.items.filter((i) => i.id !== id)
      if (d.items.length === before) return false
      d.tasks = d.tasks.filter((t) => t.source_item_id !== id || Boolean(t.external_source))
      return true
    })
  }
  async updateItem(id: string, patch: { title: string; body: string; kind: KnowledgeItem["kind"]; zone: string }) {
    return this.mutate((d) => {
      const i = (d.items as StoredItem[]).find((x) => x.id === id)
      if (!i) return false
      const moved = i.zone !== patch.zone
      Object.assign(i, patch)
      delete i.embedding
      delete i.embedding_model
      if (moved) {
        const now = new Date().toISOString()
        for (const t of d.tasks) if (t.source_item_id === id) Object.assign(t, { zone: patch.zone, updated_at: now })
      }
      return true
    })
  }
  async listItemsBySessions(authorId: string, sessionIds: string[]) {
    const wanted = new Set(sessionIds)
    return this.load()
      .items.filter((i) => i.author_id === authorId && typeof i.source?.session_id === "string" && wanted.has(sessionOf(i.source.session_id)))
      .map((i) => ({ id: i.id, zone: i.zone, session_id: sessionOf(i.source.session_id!) }))
  }

  async moveItems(ids: string[], zone: string) {
    const wanted = new Set(ids)
    return this.mutate((d) => {
      let moved = 0
      for (const i of d.items) {
        if (!wanted.has(i.id) || i.zone === zone) continue
        i.zone = zone
        moved++
      }
      const now = new Date().toISOString()
      for (const t of d.tasks) if (t.source_item_id && wanted.has(t.source_item_id)) Object.assign(t, { zone, updated_at: now })
      return moved
    })
  }

  async zoneStats(): Promise<ZoneStat[]> {
    const stats = new Map<string, { count: number; last_at: string | null; authors: Set<string> }>()
    for (const i of this.load().items) {
      const s = stats.get(i.zone) ?? { count: 0, last_at: null, authors: new Set<string>() }
      s.count++
      if (!s.last_at || i.created_at > s.last_at) s.last_at = i.created_at
      s.authors.add(i.author_id)
      stats.set(i.zone, s)
    }
    return [...stats.entries()].map(([zone, s]) => ({ zone, count: s.count, last_at: s.last_at, contributors: s.authors.size }))
  }

  async authorZoneStats(): Promise<AuthorZoneStat[]> {
    const counts = new Map<string, AuthorZoneStat>()
    for (const i of this.load().items) {
      const key = `${i.author_id}|${i.zone}`
      const c = counts.get(key) ?? { author_id: i.author_id, zone: i.zone, count: 0 }
      c.count++
      counts.set(key, c)
    }
    return [...counts.values()]
  }

  async topEntities(f: { zones?: string[]; authorId?: string; limit: number }): Promise<EntityStat[]> {
    const zones = f.zones ? new Set(f.zones) : null
    const agg = new Map<string, EntityStat>()
    for (const i of this.load().items) {
      if ((zones && !zones.has(i.zone)) || (f.authorId && i.author_id !== f.authorId)) continue
      for (const e of i.entities) {
        const key = `${e.type}:${normalize(e.name)}`
        const s = agg.get(key) ?? { type: e.type, name: e.name, count: 0, zones: [] }
        s.count++
        if (!s.zones.includes(i.zone)) s.zones.push(i.zone)
        agg.set(key, s)
      }
    }
    return [...agg.values()].sort((a, b) => b.count - a.count).slice(0, f.limit)
  }

  async insertEvents(events: NewEvent[]) {
    const out = this.mutate((d) =>
      events.map((e) => {
        const ev: AgentEvent = { ...e, id: ++d.seq.event, org_id: d.org.id }
        d.events.push(ev)
        return ev
      }),
    )
    if (out.length) notifyOrg(out[0].org_id)
    return out
  }

  onEvents(orgId: string, listener: () => void) {
    let set = listeners.get(orgId)
    if (!set) listeners.set(orgId, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(orgId)
    }
  }

  eventNotifyMode() {
    return "local" as const
  }

  async saveSyncReport(userId: string, report: SyncReport) {
    return this.mutate((d) => {
      const row: SyncReportRow = { ...report, id: randomUUID(), org_id: d.org.id, user_id: userId }
      const all = (d.sync_reports ?? []).concat(row)
      // History bounded per workstation.
      const mine = all.filter((r) => r.user_id === userId)
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - SYNC_REPORTS_KEEP)).map((r) => r.id))
      d.sync_reports = drop.size ? all.filter((r) => !drop.has(r.id)) : all
      return row
    })
  }

  async latestSyncReports() {
    const latest = new Map<string, SyncReportRow>()
    for (const r of this.load().sync_reports ?? []) {
      const prev = latest.get(r.user_id)
      if (!prev || r.at > prev.at) latest.set(r.user_id, r)
    }
    return [...latest.values()].sort((a, b) => b.at.localeCompare(a.at))
  }

  async listSyncReports(f: { userId?: string; limit?: number }) {
    return (this.load().sync_reports ?? [])
      .filter((r) => !f.userId || r.user_id === f.userId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, f.limit ?? 100)
  }

  async listEvents(f: { afterId?: number; sinceIso?: string; limit?: number; type?: string; userId?: string }) {
    const limit = f.limit ?? 100
    const filtered = this.load().events.filter(
      (e) =>
        (f.afterId === undefined || e.id > f.afterId) &&
        (!f.sinceIso || e.at >= f.sinceIso) &&
        (!f.type || e.type === f.type) &&
        (!f.userId || e.user_id === f.userId),
    )
    if (f.afterId !== undefined) return filtered.slice(0, limit)
    return filtered.slice(-limit).reverse()
  }

  async listTasks(f: { zones?: string[]; assigneeId?: string }) {
    const zones = f.zones ? new Set(f.zones) : null
    return this.load()
      .tasks.filter((t) => (!zones || zones.has(t.zone)) && (!f.assigneeId || t.assignee_id === f.assigneeId))
      .sort((a, b) => (a.status === b.status ? b.created_at.localeCompare(a.created_at) : a.status === "open" ? -1 : 1))
  }
  async createTasks(tasks: NewTask[]) {
    return this.mutate((d) =>
      tasks.map((t) => {
        const now = new Date().toISOString()
        const task: Task = { ...t, id: randomUUID(), created_at: t.created_at ?? now, updated_at: now }
        d.tasks.push(task)
        return task
      }),
    )
  }
  async upsertExternalTasks(source: string, tasks: NewTask[]) {
    return this.mutate((d) => {
      const now = new Date().toISOString()
      const seen = new Set<string>()
      const out: Task[] = []
      for (const t of tasks) {
        if (!t.external_id) continue
        seen.add(t.external_id)
        const prev = d.tasks.find((x) => x.external_source === source && x.external_id === t.external_id)
        if (prev) {
          const changed = prev.title !== t.title || prev.status !== t.status || prev.zone !== t.zone || prev.external_url !== t.external_url
          if (changed) Object.assign(prev, { title: t.title, status: t.status, zone: t.zone, external_url: t.external_url, updated_at: now })
          out.push(prev)
        } else {
          const task: Task = { ...t, external_source: source, id: randomUUID(), created_at: t.created_at ?? now, updated_at: now }
          d.tasks.push(task)
          out.push(task)
        }
      }
      for (const x of d.tasks) {
        if (x.external_source === source && x.external_id && !seen.has(x.external_id) && x.status === "open") {
          x.status = "done"
          x.updated_at = now
          out.push(x)
        }
      }
      return out
    })
  }

  async updateTask(id: string, patch: { status?: Task["status"]; assignee_id?: string }) {
    return this.mutate((d) => {
      const t = d.tasks.find((x) => x.id === id)
      if (!t) return null
      Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updated_at: new Date().toISOString() })
      return t
    })
  }

  private get documentsDir() {
    return path.join(this.dir, "documents")
  }
  private documentPath(id: string, ext: "bin" | "txt") {
    return path.join(this.documentsDir, `${id}.${ext}`)
  }
  private documentText(id: string): string {
    try {
      return fs.readFileSync(this.documentPath(id, "txt"), "utf8")
    } catch {
      return ""
    }
  }

  async insertDocument(doc: NewDocument) {
    const { content, text, ...meta } = doc
    const id = randomUUID()
    // The files first: the metadata never points to a document whose bytes are missing.
    fs.mkdirSync(this.documentsDir, { recursive: true })
    fs.writeFileSync(this.documentPath(id, "bin"), content)
    fs.writeFileSync(this.documentPath(id, "txt"), text)
    try {
      return this.mutate((d) => {
        const stored: BrainDocument = { ...meta, id, org_id: d.org.id, created_at: doc.created_at ?? new Date().toISOString() }
        ;(d.documents ??= []).push(stored)
        return stored
      })
    } catch (err) {
      fs.rmSync(this.documentPath(id, "bin"), { force: true })
      fs.rmSync(this.documentPath(id, "txt"), { force: true })
      throw err
    }
  }
  async findDocumentBySha(sha256: string) {
    return this.load().documents?.find((x) => x.sha256 === sha256) ?? null
  }
  async getDocument(id: string) {
    const doc = this.load().documents?.find((x) => x.id === id)
    return doc ? { ...doc, text: this.documentText(id) } : null
  }
  async getDocumentContent(id: string) {
    if (!this.load().documents?.some((x) => x.id === id)) return null
    try {
      return fs.readFileSync(this.documentPath(id, "bin"))
    } catch {
      return null
    }
  }
  async listDocuments(f: DocumentFilter) {
    const zones = f.zones ? new Set(f.zones) : null
    const items = f.itemIds ? new Set(f.itemIds) : null
    return (this.load().documents ?? [])
      .filter(
        (x) =>
          (!zones || zones.has(x.zone) || (f.orAuthorId !== undefined && x.author_id === f.orAuthorId)) &&
          (!f.zone || x.zone === f.zone) &&
          (!items || x.item_ids.some((i) => items.has(i))),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 1000)
  }
  async searchDocuments(query: string, zones: string[], limit: number, opts: { authorId?: string } = {}): Promise<ScoredDocument[]> {
    const q = [...new Set(tokenize(query))]
    if (q.length === 0) return []
    const allowed = new Set(zones)
    const matches = (tokens: Set<string>, t: string) => tokens.has(t) || (t.length >= 4 && [...tokens].some((x) => x.startsWith(t)))
    const scored: ScoredDocument[] = []
    for (const doc of this.load().documents ?? []) {
      if (!allowed.has(doc.zone) && !(opts.authorId && doc.author_id === opts.authorId)) continue
      const head = new Set(tokenize(`${doc.name} ${doc.title}`))
      const body = new Set(tokenize(this.documentText(doc.id)))
      let score = 0
      let hits = 0
      for (const t of q) {
        const s = (matches(head, t) ? 3 : 0) + (matches(body, t) ? 1 : 0)
        if (s > 0) hits++
        score += s
      }
      if (score === 0) continue
      scored.push({ ...doc, score: Math.round(score * (hits / q.length) * 100) / 100 })
    }
    return scored.sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, limit)
  }
  async linkDocument(id: string, itemIds: string[]) {
    return this.mutate((d) => {
      const doc = d.documents?.find((x) => x.id === id)
      if (!doc) return null
      doc.item_ids = [...new Set([...doc.item_ids, ...itemIds])]
      return doc
    })
  }
  async deleteDocument(id: string) {
    const deleted = this.mutate((d) => {
      const before = d.documents?.length ?? 0
      d.documents = (d.documents ?? []).filter((x) => x.id !== id)
      return d.documents.length < before
    })
    if (deleted) {
      fs.rmSync(this.documentPath(id, "bin"), { force: true })
      fs.rmSync(this.documentPath(id, "txt"), { force: true })
    }
    return deleted
  }

  async listAutomations() {
    return [...this.load().automations].sort((a, b) => b.minutes_saved_per_week - a.minutes_saved_per_week)
  }
  async upsertAutomations(cands: Parameters<BrainStore["upsertAutomations"]>[0]) {
    return this.mutate((d) =>
      cands.map((c) => {
        const existing = d.automations.find((a) => a.key === c.key)
        if (existing) {
          Object.assign(existing, c, { status: existing.status })
          return existing
        }
        const a: AutomationSuggestion = { ...c, id: randomUUID(), status: "proposed", created_at: new Date().toISOString() }
        d.automations.push(a)
        return a
      }),
    )
  }
  async updateAutomation(id: string, patch: { status: AutomationSuggestion["status"] }) {
    return this.mutate((d) => {
      const a = d.automations.find((x) => x.id === id)
      if (!a) return null
      a.status = patch.status
      return a
    })
  }

  async listSkills() {
    return [...(this.load().skills ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  }
  async getSkill(id: string) {
    return this.load().skills?.find((x) => x.id === id) ?? null
  }
  async getSkillByName(name: string) {
    return this.load().skills?.find((x) => x.name === name) ?? null
  }
  async publishSkill(s: NewSkill) {
    return this.mutate((d) => {
      const skills = (d.skills ??= [])
      const now = new Date().toISOString()
      const existing = skills.find((x) => x.name === s.name)
      if (existing) {
        Object.assign(existing, { description: s.description, zone: s.zone, files: s.files, updated_by: s.publisher_id, version: existing.version + 1, updated_at: now })
        return existing
      }
      const skill: Skill = {
        id: randomUUID(),
        name: s.name,
        description: s.description,
        zone: s.zone,
        files: s.files,
        author_id: s.publisher_id,
        updated_by: s.publisher_id,
        version: 1,
        created_at: now,
        updated_at: now,
      }
      skills.push(skill)
      return skill
    })
  }
  async updateSkill(id: string, patch: { zone: string | null }) {
    return this.mutate((d) => {
      const skill = d.skills?.find((x) => x.id === id)
      if (!skill) return null
      skill.zone = patch.zone
      skill.updated_at = new Date().toISOString()
      return skill
    })
  }
  async deleteSkill(id: string) {
    return this.mutate((d) => {
      const before = d.skills?.length ?? 0
      d.skills = (d.skills ?? []).filter((x) => x.id !== id)
      return d.skills.length < before
    })
  }

  async getStatus() {
    return this.load().status
  }
  async setStatus(s: CompanyStatus) {
    this.mutate((d) => {
      d.status = s
    })
  }

  async migrationStatus() {
    return null
  }

  async isEmpty() {
    return (await this.listProfiles()).length === 0
  }

  async claimOnce(key: string) {
    // Exclusive creation (O_EXCL): only one process wins, even with several servers on the same folder.
    try {
      fs.closeSync(fs.openSync(path.join(this.dir, `claim-${key.replace(/[^a-z0-9_-]/gi, "_")}`), "wx"))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
      throw err
    }
  }

  async releaseClaim(key: string) {
    fs.rmSync(path.join(this.dir, `claim-${key.replace(/[^a-z0-9_-]/gi, "_")}`), { force: true })
  }

  async finishClaim(key: string) {
    fs.writeFileSync(path.join(this.dir, `claim-${key.replace(/[^a-z0-9_-]/gi, "_")}`), "done")
  }

  async isClaimDone(key: string) {
    try {
      return fs.readFileSync(path.join(this.dir, `claim-${key.replace(/[^a-z0-9_-]/gi, "_")}`), "utf8") === "done"
    } catch {
      return false
    }
  }

  async getSessionSecret() {
    if (this.secret) return this.secret
    const file = path.join(this.dir, "session-secret")
    const read = () => {
      try {
        const v = fs.readFileSync(file, "utf8").trim()
        return v.length >= 32 ? v : null
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
      }
    }
    let secret = read()
    if (!secret) {
      // Created only once, atomically (hard link: never a half-written file), readable by the owner only.
      const candidate = randomBytes(32).toString("hex")
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
      fs.writeFileSync(tmp, candidate, { mode: 0o600 })
      try {
        fs.linkSync(tmp, file)
        secret = candidate
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EEXIST") secret = read()
        if (!secret) {
          // Invalid file (empty, truncated) or hard links not supported: replace it.
          fs.renameSync(tmp, file)
          secret = candidate
        }
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
    try {
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
    } catch {}
    this.secret = secret
    return secret
  }

  async reset(org: { name: string; description: string }) {
    this.withLock(() => {
      this.data = emptyData(org)
      this.save()
    })
    fs.rmSync(this.documentsDir, { recursive: true, force: true })
  }
}
