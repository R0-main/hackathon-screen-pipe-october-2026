// Stockage fichier : tout le cerveau dans un JSON. Zéro configuration, idéal pour la démo sur un laptop.

import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
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
  type Task,
  type Zone,
  type ZoneAccess,
} from "@brain/core"
import type { BrainStore, EntityStat, NewEvent, NewItem, NewProfile, NewTask, ProfilePatch, ZoneStat } from "./types"

type StoredProfile = Profile & { token_hash: string }

type Data = {
  version: 1
  org: Org
  profiles: StoredProfile[]
  zones: Zone[]
  zone_access: ZoneAccess[]
  items: KnowledgeItem[]
  events: AgentEvent[]
  tasks: Task[]
  automations: AutomationSuggestion[]
  status: CompanyStatus | null
  seq: { event: number }
}

const MAX_EVENTS = 20000
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 10_000

/** Pause synchrone : le verrou entoure du code synchrone (lecture, modification, écriture). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Identité d'une version du fichier : chaque écriture fait un rename, donc un nouvel inode. */
function versionKey(st: fs.Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`
}

function emptyData(org?: { name: string; description: string }): Data {
  return {
    version: 1,
    org: { id: randomUUID(), name: org?.name ?? "Mon entreprise", description: org?.description ?? "", created_at: new Date().toISOString() },
    profiles: [],
    zones: DEFAULT_ZONES,
    zone_access: [],
    items: [],
    events: [],
    tasks: [],
    automations: [],
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

  /** Dernière version du fichier (relu s'il a été remplacé par un autre processus : seed, simulateur, smoke). */
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
   * Verrou inter-processus (fichier créé en O_EXCL) : le serveur, le simulateur et les scripts écrivent le même JSON
   * sans perdre les écritures des autres ni réutiliser des identifiants d'événements.
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
        // Verrou abandonné (processus tué en pleine écriture) : on le retire.
        if (Date.now() - fs.statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(this.lockFile, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Cerveau verrouillé par un autre processus (${this.lockFile}).`)
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
    // Sous verrou : le fichier est forcément celui qu'on vient d'écrire.
    this.version = versionKey(fs.statSync(this.file))
  }

  /** Lecture de la dernière version, modification et écriture, le tout sous verrou. */
  private mutate<T>(fn: (d: Data) => T): T {
    return this.withLock(() => {
      try {
        const out = fn(this.load())
        this.save()
        return out
      } catch (err) {
        // Mémoire possiblement modifiée à moitié : on relira le fichier.
        this.data = null
        this.version = ""
        throw err
      }
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
      const prof: StoredProfile = { id: randomUUID(), org_id: d.org.id, created_at: new Date().toISOString(), ...p }
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
    return [...this.load().zones].sort((a, b) => a.position - b.position)
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

  async insertItems(items: NewItem[]) {
    return this.mutate((d) =>
      items.map((i) => {
        const item: KnowledgeItem = { ...i, id: randomUUID(), org_id: d.org.id, created_at: i.created_at ?? new Date().toISOString() }
        d.items.push(item)
        return item
      }),
    )
  }

  async searchItems(query: string, zones: string[], limit: number, opts: { authorId?: string } = {}): Promise<ScoredItem[]> {
    const q = [...new Set(tokenize(query))]
    if (q.length === 0) return []
    const allowed = new Set(zones)
    const now = Date.now()
    const matches = (tokens: string[], t: string) => tokens.some((x) => x === t || (t.length >= 4 && x.startsWith(t)))
    const scored: ScoredItem[] = []
    for (const item of this.load().items) {
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
      scored.push({ ...item, score: Math.round(score * 100) / 100 })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  async listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string }) {
    const zones = f.zones ? new Set(f.zones) : null
    return this.load()
      .items.filter(
        (i) => (!zones || zones.has(i.zone)) && (!f.authorId || i.author_id === f.authorId) && (!f.sinceIso || i.created_at >= f.sinceIso),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, f.limit ?? 1000)
  }
  async getItem(id: string) {
    return this.load().items.find((i) => i.id === id) ?? null
  }
  async deleteItem(id: string) {
    return this.mutate((d) => {
      const before = d.items.length
      d.items = d.items.filter((i) => i.id !== id)
      return d.items.length < before
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
    return this.mutate((d) =>
      events.map((e) => {
        const ev: AgentEvent = { ...e, id: ++d.seq.event, org_id: d.org.id }
        d.events.push(ev)
        return ev
      }),
    )
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
  async updateTask(id: string, patch: { status?: Task["status"]; assignee_id?: string }) {
    return this.mutate((d) => {
      const t = d.tasks.find((x) => x.id === id)
      if (!t) return null
      Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updated_at: new Date().toISOString() })
      return t
    })
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

  async getStatus() {
    return this.load().status
  }
  async setStatus(s: CompanyStatus) {
    this.mutate((d) => {
      d.status = s
    })
  }

  async isEmpty() {
    return (await this.listProfiles()).length === 0
  }

  async claimOnce(key: string) {
    // Création exclusive (O_EXCL) : un seul processus gagne, même avec plusieurs serveurs sur le même dossier.
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
      // Créé une seule fois, atomiquement (lien dur : jamais de fichier à moitié écrit), lisible du seul propriétaire.
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
          // Fichier invalide (vide, tronqué) ou liens durs non pris en charge : on le remplace.
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
  }
}
