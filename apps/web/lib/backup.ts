// Export and import of the brain (format in @brain/core/backup): the whole brain, the skills, the clients, an
// employee's sheet.
//
// Exports follow the reader's rights: the brain and the team's sheets are for admins, the skills and clients are those
// the reader sees, an employee's sheet is for admins or the employee. Importing knowledge, zones and people is for
// admins; importing skills is for whoever can publish them. An import only adds: what is already in the brain (same
// zone, title and content; same person; same skill files) is skipped, so importing the same file twice changes nothing.

import {
  isCoreZone,
  SKILL_NAME_RE,
  classifyZones,
  clientItem,
  clientsFromCsv,
  clientsOf,
  itemKey,
  matchZone,
  newBackup,
  normalize,
  personKey,
  personSheetMarkdown,
  redactText,
  skillFileProblems,
  skillSecrets,
  slugify,
  toCsv,
  truncate,
  zoneColor,
  type Backup,
  type BackupItem,
  type BackupKind,
  type BackupPerson,
  type KnowledgeItem,
  type PersonSheet,
  type Profile,
  type Skill,
  type Zone,
} from "@brain/core"
import { canRead } from "./access"
import { hashToken, newToken, type Viewer } from "./auth"
import { getPersonContext } from "./brain"
import { embedDocuments, embeddingText } from "./embeddings"
import { searchTools } from "./search-settings"
import { canPublishSkills, canSeeSkill, listVisibleSkills, publishSkill, SkillError } from "./skills"
import { getStore } from "./store"
import type { NewItem } from "./store/types"

export class BackupError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message)
  }
}

const isAdmin = (viewer: Viewer) => viewer.real.role === "admin"
/** Every item in the brain is read at once to export or deduplicate: well above what a company produces. */
const ALL = 100_000

const today = () => new Date().toISOString().slice(0, 10)

/** Name of a downloaded file: `butine-brain-2026-10-17.json`. */
export function exportFileName(...parts: string[]): string {
  const ext = parts.pop()!
  return `${parts.map((p) => slugify(p)).filter(Boolean).join("-")}-${today()}.${ext}`
}

function backupPerson(p: Profile, zones: string[]): BackupPerson {
  return {
    ref: p.id,
    name: p.name,
    email: p.email,
    title: p.title,
    role: p.role,
    manager_ref: p.manager_id ?? null,
    can_publish_skills: p.can_publish_skills ?? false,
    zones,
  }
}

function backupItem(i: KnowledgeItem): BackupItem {
  return {
    ref: i.id,
    author_ref: i.author_id,
    zone: i.zone,
    kind: i.kind,
    title: i.title,
    body: i.body,
    entities: i.entities,
    source: { app: i.source.app, tool: i.source.tool, at: i.source.at, session_id: i.source.session_id },
    confidence: i.confidence,
    created_at: i.created_at,
  }
}

const backupSkill = (s: Skill) => ({ name: s.name, description: s.description, zone: s.zone, files: s.files })

/** The people these items come from, so that the import keeps who said what (no zone access: they are not exported). */
function authorsOf(items: { author_id: string }[], profiles: Profile[]): BackupPerson[] {
  const ids = new Set(items.map((i) => i.author_id))
  return profiles.filter((p) => ids.has(p.id)).map((p) => ({ ...backupPerson(p, []), role: "member" as const, can_publish_skills: false }))
}

/** GET /api/export?what=brain (admins): zones, people and their access, current knowledge, tasks, skills. */
export async function exportBrain(viewer: Viewer): Promise<Backup> {
  if (!isAdmin(viewer)) throw new BackupError(403, "Admins only.")
  const s = getStore()
  const [org, zones, profiles, access, items, tasks, skills] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listProfiles(),
    s.listZoneAccess(),
    s.listItems({ limit: ALL, excludeSuperseded: true }),
    s.listTasks({}),
    s.listSkills(),
  ])
  const backup = newBackup("brain", { name: org.name, description: org.description })
  backup.zones = zones
  backup.people = profiles.map((p) => backupPerson(p, access.filter((a) => a.user_id === p.id).map((a) => a.zone_id)))
  backup.items = items.map(backupItem)
  // Tasks imported from a connector (Linear, Todoist) come back with that connector, not with the file.
  backup.tasks = tasks
    .filter((t) => !t.external_source)
    .map((t) => ({ title: t.title, zone: t.zone, status: t.status, assignee_ref: t.assignee_id ?? null, item_ref: t.source_item_id ?? null, created_at: t.created_at }))
  backup.skills = skills.map(backupSkill)
  return backup
}

/** GET /api/export?what=skills: the skills the reader receives, files included. */
export async function exportSkills(viewer: Viewer): Promise<Backup> {
  const s = getStore()
  const [org, zones, skills] = await Promise.all([s.getOrg(), s.listZones(), listVisibleSkills(viewer)])
  const backup = newBackup("skills", { name: org.name, description: org.description })
  const used = new Set(skills.map((sk) => sk.zone).filter(Boolean))
  backup.zones = zones.filter((z) => used.has(z.id))
  backup.skills = skills.map(backupSkill)
  return backup
}

/** GET /api/export?what=clients: every client cited in the zones the reader reads, with the knowledge about them. */
export async function exportClients(viewer: Viewer): Promise<{ backup: Backup; csv: string }> {
  const s = getStore()
  const [org, zones, profiles, all] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listProfiles(),
    s.listItems({ zones: viewer.access.readable, limit: ALL, excludeSuperseded: true }),
  ])
  const items = all.filter((i) => i.entities.some((e) => e.type === "client"))
  const backup = newBackup("clients", { name: org.name, description: org.description })
  const used = new Set(items.map((i) => i.zone))
  backup.zones = zones.filter((z) => used.has(z.id))
  backup.people = authorsOf(items, profiles)
  backup.items = items.map(backupItem)

  const zoneName = new Map(zones.map((z) => [z.id, z.name]))
  const rows = [["name", "zones", "mentions", "last_mention", "notes"]]
  for (const c of clientsOf(items)) {
    const key = normalize(c.name)
    const about = items.filter((i) => i.entities.some((e) => e.type === "client" && normalize(e.name) === key)).slice(0, 5)
    rows.push([
      c.name,
      c.zones.map((z) => zoneName.get(z) ?? z).join(" / "),
      String(c.count),
      c.last_at?.slice(0, 10) ?? "",
      about.map((i) => truncate(i.title.replace(/\s+/g, " "), 140)).join(" | "),
    ])
  }
  return { backup, csv: toCsv(rows) }
}

// ---------- Employee sheets ----------

/** An employee's sheet (admins, or the employee): who they are, where they work, what they brought to the brain. */
export async function personSheet(viewer: Viewer, personId: string): Promise<{ sheet: PersonSheet; markdown: string; backup: Backup } | null> {
  if (!isAdmin(viewer) && viewer.real.id !== personId) throw new BackupError(403, "Admins only.")
  const s = getStore()
  const ctx = await getPersonContext(viewer, personId)
  if (!ctx) return null
  const own = personId === viewer.profile.id
  const scope = own ? undefined : viewer.access.readable
  const [org, zones, profiles, access, items, tasks, skills, reports] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listProfiles(),
    s.listZoneAccess(personId),
    s.listItems({ authorId: personId, zones: scope, limit: ALL, excludeSuperseded: true }),
    s.listTasks({ assigneeId: personId }),
    s.listSkills(),
    s.listSyncReports({ userId: personId, limit: 1 }),
  ])
  const person = ctx.person
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id
  const visibleTasks = tasks.filter((t) => own || canRead(viewer.access, t.zone))
  const totalWeight = ctx.zones.reduce((n, z) => n + z.weight, 0) || 1
  const count = (k: string) => items.filter((i) => i.kind === k).length
  const dates = items.map((i) => i.created_at).sort()
  const sheet: PersonSheet = {
    company: org.name,
    person: { name: person.name, title: person.title, email: person.email, role: person.role, since: person.created_at },
    manager: profiles.find((p) => p.id === person.manager_id)?.name ?? null,
    reports: profiles.filter((p) => p.manager_id === person.id).map((p) => p.name),
    zones: ctx.zones
      .filter((z) => z.weight > 0)
      .map((z) => ({ name: zoneName(z.zone), share: Math.round((z.weight / totalWeight) * 100), items: items.filter((i) => i.zone === z.zone).length })),
    readable_zones: person.role === "admin" ? zones.map((z) => z.name) : access.map((a) => zoneName(a.zone_id)),
    totals: {
      items: items.length,
      decisions: count("decision"),
      procedures: count("procedure"),
      facts: count("fact"),
      questions: count("question"),
      tasks_open: visibleTasks.filter((t) => t.status === "open").length,
      tasks_done: visibleTasks.filter((t) => t.status === "done").length,
    },
    first_at: dates[0] ?? null,
    last_at: dates[dates.length - 1] ?? null,
    last_sync: reports[0] ? { at: reports[0].at, ok: reports[0].ok } : null,
    items: items.map((i) => ({ kind: i.kind, title: i.title, body: i.body, zone: zoneName(i.zone), created_at: i.created_at })),
    tasks: visibleTasks.map((t) => ({ title: t.title, zone: zoneName(t.zone), status: t.status, updated_at: t.updated_at })),
    topics: ctx.entities.map((e) => ({ type: e.type, name: e.name, count: e.count })),
    prompts: ctx.frequent_prompts.map((p) => ({ summary: p.summary, count: p.count })),
    skills: skills.filter((sk) => sk.author_id === person.id && canSeeSkill(viewer, sk)).map((sk) => ({ name: sk.name, description: sk.description, version: sk.version })),
    generated_at: new Date().toISOString(),
    partial: !own && !viewer.access.isAdmin,
  }

  const backup = newBackup("person", { name: org.name, description: org.description })
  const used = new Set([...items.map((i) => i.zone), ...visibleTasks.map((t) => t.zone), ...access.map((a) => a.zone_id)])
  backup.zones = zones.filter((z) => used.has(z.id))
  backup.people = [backupPerson(person, access.map((a) => a.zone_id))]
  backup.items = items.map(backupItem)
  backup.tasks = visibleTasks
    .filter((t) => !t.external_source)
    .map((t) => ({ title: t.title, zone: t.zone, status: t.status, assignee_ref: person.id, item_ref: t.source_item_id ?? null, created_at: t.created_at }))
  return { sheet, markdown: personSheetMarkdown(sheet), backup }
}

/** Every employee's sheet in one Markdown document (admins). */
export async function teamSheets(viewer: Viewer): Promise<string> {
  if (!isAdmin(viewer)) throw new BackupError(403, "Admins only.")
  const profiles = (await getStore().listProfiles()).sort((a, b) => a.name.localeCompare(b.name))
  const parts: string[] = []
  for (const p of profiles) {
    const sheet = await personSheet(viewer, p.id)
    if (sheet) parts.push(sheet.markdown.trimEnd())
  }
  return `${parts.join("\n\n\n")}\n`
}

// ---------- Import ----------

export type ImportReport = {
  dry_run: boolean
  kind: BackupKind
  zones: { added: string[]; matched: number }
  people: { created: string[]; matched: number }
  items: { added: number; skipped: number }
  tasks: { added: number; skipped: number }
  skills: { published: string[]; unchanged: string[]; refused: { name: string; reason: string }[] }
  warnings: string[]
}

function clampDate(at: string | undefined): string {
  const t = at ? Date.parse(at) : NaN
  const now = Date.now()
  return new Date(Number.isFinite(t) && t <= now + 60_000 ? t : now).toISOString()
}

const sameFiles = (a: { path: string; content: string }[], b: { path: string; content: string }[]) => {
  const key = (fs: { path: string; content: string }[]) => JSON.stringify(fs.map((f) => [f.path, f.content.replace(/\r\n/g, "\n")]).sort())
  return key(a) === key(b)
}

/** Writes in batches: a Postgres transaction per batch, not one for 20,000 items. */
const BATCH = 200

/**
 * POST /api/import — adds the content of a backup to the current company. `dryRun`: says what would be added,
 * without writing anything. Knowledge keeps its date and its author (matched by email, then by name; created
 * otherwise, with a token to regenerate from the org chart to install their computer).
 */
export async function importBackup(viewer: Viewer, backup: Backup, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const dry = opts.dryRun === true
  if ((backup.people.length || backup.items.length || backup.tasks.length) && !isAdmin(viewer))
    throw new BackupError(403, "Importing knowledge or people is for admins.")
  if (backup.skills.length && !canPublishSkills(viewer)) throw new BackupError(403, "Importing skills requires the right to publish them: ask an admin for it.")

  const s = getStore()
  const report: ImportReport = {
    dry_run: dry,
    kind: backup.kind,
    zones: { added: [], matched: 0 },
    people: { created: [], matched: 0 },
    items: { added: 0, skipped: 0 },
    tasks: { added: 0, skipped: 0 },
    skills: { published: [], unchanged: [], refused: [] },
    warnings: [],
  }

  // 1. Zones: same id or same name → the existing zone; otherwise created, by an admin only.
  const zones: Zone[] = await s.listZones()
  const zoneMap = new Map<string, string>()
  for (const z of backup.zones) {
    const found = zones.find((x) => x.id === z.id) ?? zones.find((x) => normalize(x.name).trim() === normalize(z.name).trim())
    if (found) {
      zoneMap.set(z.id, found.id)
      report.zones.matched++
      continue
    }
    if (!isAdmin(viewer)) continue
    const position = zones.reduce((m, x) => Math.max(m, x.position + 1), 0)
    const zone: Zone = { ...z, color: z.color || zoneColor(position), position }
    if (!dry) await s.upsertZone(zone)
    zones.push(zone)
    zoneMap.set(z.id, zone.id)
    report.zones.added.push(zone.name)
  }
  /** Zone of an imported item: the mapped one, a zone with that name, otherwise the closest one by its content. */
  const zoneFor = (id: string, text: string): string => {
    const mapped = zoneMap.get(id) ?? (zones.some((z) => z.id === id) ? id : matchZone(id, zones))
    if (mapped) return mapped
    const guess = classifyZones(text, zones, 1)[0] ?? zones[0]?.id
    if (!guess) throw new BackupError(400, "The brain has no zone yet: create one before importing.")
    return guess
  }

  // 2. People: same email, then same name, then same id (re-import into the same brain); otherwise created.
  const profiles = await s.listProfiles()
  const people = new Map<string, string>()
  const created: { ref: string; id: string; p: BackupPerson }[] = []
  for (const p of backup.people) {
    const k = personKey(p)
    const found =
      (k.email && profiles.find((x) => personKey(x).email === k.email)) ||
      profiles.find((x) => personKey(x).name === k.name) ||
      profiles.find((x) => x.id === p.ref && personKey(x).name === k.name)
    if (found) {
      people.set(p.ref, found.id)
      report.people.matched++
      continue
    }
    // Only a whole brain's file brings back admins and publishing rights: a sheet or a client list brings members.
    const role = backup.kind === "brain" ? p.role : "member"
    let id = `new:${p.ref}`
    if (!dry) {
      const profile = await s.createProfile({
        name: p.name,
        email: p.email || undefined,
        title: p.title,
        role,
        manager_id: null,
        can_publish_skills: backup.kind === "brain" ? (p.can_publish_skills ?? false) : false,
        // A token nobody knows: the admin regenerates it from the org chart to install this person's computer.
        token_hash: hashToken(newToken()),
      })
      id = profile.id
      profiles.push(profile)
      const readable = [...new Set(p.zones.map((z) => zoneMap.get(z) ?? (zones.some((x) => x.id === z) ? z : null)).filter((z): z is string => z !== null))]
      if (readable.length) await s.setZoneAccess(id, readable.map((zone_id) => ({ zone_id, can_write: true })))
    }
    people.set(p.ref, id)
    created.push({ ref: p.ref, id, p })
    report.people.created.push(p.name)
  }
  if (!dry)
    for (const c of created) {
      const manager = c.p.manager_ref ? (people.get(c.p.manager_ref) ?? profiles.find((x) => x.id === c.p.manager_ref)?.id) : undefined
      if (manager && manager !== c.id) await s.updateProfile(c.id, { manager_id: manager })
    }
  if (report.people.created.length && !dry)
    report.warnings.push(
      `${report.people.created.length} new ${report.people.created.length === 1 ? "person has" : "people have"} no computer yet: regenerate their token from the org chart to send them their install prompt.`,
    )
  const authorFor = (ref: string | null | undefined) => (ref ? people.get(ref) : undefined) ?? viewer.real.id

  // 3. Knowledge: redacted again, deduplicated against the whole brain (and within the file).
  const existing = await s.listItems({ limit: ALL })
  const known = new Map(existing.map((i) => [itemKey(i), i.id]))
  const itemIds = new Map<string, string>()
  const prepared: { ref?: string; item: NewItem }[] = []
  for (const i of backup.items) {
    const title = redactText(i.title)
    const body = redactText(i.body)
    const zone = zoneFor(i.zone, `${title} ${body}`)
    const key = itemKey({ zone, title, body })
    const dup = known.get(key)
    if (dup) {
      if (i.ref) itemIds.set(i.ref, dup)
      report.items.skipped++
      continue
    }
    known.set(key, `pending:${prepared.length}`)
    const at = clampDate(i.created_at ?? i.source.at)
    prepared.push({
      ref: i.ref,
      item: {
        zone,
        kind: i.kind,
        title,
        body,
        entities: i.entities,
        source: { app: i.source.app, tool: i.source.tool, at: clampDate(i.source.at ?? at), ...(i.source.session_id ? { session_id: i.source.session_id } : {}) },
        confidence: i.confidence,
        author_id: authorFor(i.author_ref),
        created_at: at,
      },
    })
  }
  report.items.added = prepared.length
  const touched = new Map<string, number>()
  if (!dry && prepared.length) {
    const provider = (await searchTools()).embeddings
    for (let n = 0; n < prepared.length; n += BATCH) {
      const batch = prepared.slice(n, n + BATCH)
      if (provider) {
        try {
          const vectors = await embedDocuments(batch.map((b) => embeddingText(b.item)), provider)
          if (vectors) batch.forEach((b, k) => Object.assign(b.item, { embedding: vectors[k], embedding_model: provider.model }))
        } catch (err) {
          // Vectors are caught up later (scripts/embed-backfill.ts): a provider outage never blocks an import.
          console.error("[embeddings] import without vectors:", err instanceof Error ? err.message : err)
        }
      }
      const inserted = await s.insertItems(batch.map((b) => b.item))
      inserted.forEach((it, k) => {
        const ref = batch[k].ref
        if (ref) itemIds.set(ref, it.id)
        touched.set(it.zone, (touched.get(it.zone) ?? 0) + 1)
      })
    }
  } else for (const p of prepared) touched.set(p.item.zone, (touched.get(p.item.zone) ?? 0) + 1)

  // 4. Tasks: same zone and same title as a task already there → skipped.
  if (backup.tasks.length) {
    const taskKey = (zone: string, title: string) => `${zone}|${normalize(title).replace(/\s+/g, " ").trim()}`
    const knownTasks = new Set((await s.listTasks({})).map((t) => taskKey(t.zone, t.title)))
    const newTasks = []
    for (const t of backup.tasks) {
      const title = redactText(t.title)
      const zone = zoneFor(t.zone, title)
      const k = taskKey(zone, title)
      if (knownTasks.has(k)) {
        report.tasks.skipped++
        continue
      }
      knownTasks.add(k)
      const assignee = t.assignee_ref ? people.get(t.assignee_ref) : undefined
      const source = t.item_ref ? itemIds.get(t.item_ref) : undefined
      newTasks.push({
        title,
        zone,
        status: t.status,
        assignee_id: assignee && !assignee.startsWith("new:") ? assignee : undefined,
        source_item_id: source && !source.startsWith("pending:") ? source : undefined,
        created_at: clampDate(t.created_at),
      })
    }
    report.tasks.added = newTasks.length
    if (!dry) for (let n = 0; n < newTasks.length; n += BATCH) await s.createTasks(newTasks.slice(n, n + BATCH))
  }

  // 5. Skills: published like from the Skills tab (checks, secrets, cortex rights); identical files → unchanged.
  for (const sk of backup.skills) {
    if (!SKILL_NAME_RE.test(sk.name)) {
      report.skills.refused.push({ name: sk.name, reason: "invalid name (lowercase, digits and dashes)" })
      continue
    }
    const zone = sk.zone ? (zoneMap.get(sk.zone) ?? (zones.some((z) => z.id === sk.zone) ? sk.zone : matchZone(sk.zone, zones))) : null
    if (sk.zone && !zone) report.warnings.push(`Skill ${sk.name}: cortex "${sk.zone}" not found, given to the whole company.`)
    const current = await s.getSkillByName(sk.name)
    if (current && canSeeSkill(viewer, current) && sameFiles(current.files, sk.files)) {
      report.skills.unchanged.push(sk.name)
      continue
    }
    if (dry) {
      const problems = [...skillFileProblems(sk.files), ...skillSecrets(sk.files).map((x) => `${x.path}: ${x.kinds.join(", ")}`)]
      if (problems.length) report.skills.refused.push({ name: sk.name, reason: problems.slice(0, 3).join("; ") })
      else report.skills.published.push(sk.name)
      continue
    }
    try {
      await publishSkill(viewer, { name: sk.name, description: sk.description, zone: zone ?? null, files: sk.files, agent: "dashboard" })
      report.skills.published.push(sk.name)
    } catch (err) {
      if (!(err instanceof SkillError)) throw err
      report.skills.refused.push({ name: sk.name, reason: [err.message, ...(err.details ?? [])].join(" ") })
    }
  }

  // Neon: the zones that received knowledge light up.
  if (!dry && touched.size) {
    const at = new Date().toISOString()
    await s.insertEvents(
      [...touched.entries()].map(([zone, n]) => ({
        user_id: viewer.real.id,
        agent: "dashboard" as const,
        type: "write" as const,
        zones: [zone],
        summary: `Import: ${n} item${n === 1 ? "" : "s"} added`,
        at,
      })),
    )
  }
  return report
}

/**
 * A spreadsheet of clients (CSV: name, zone, notes, other columns) → one knowledge item per client, filed in the zone
 * written in the file, otherwise `defaultZone`, otherwise the closest zone. Imported as a "clients" backup.
 */
export async function clientsCsvBackup(csv: string, defaultZone?: string | null): Promise<{ backup: Backup; problems: string[] }> {
  const { clients, problems } = clientsFromCsv(csv)
  if (clients.length === 0) throw new BackupError(400, "No client found in the file: the first column must hold their names.", problems)
  const s = getStore()
  const [org, zones] = await Promise.all([s.getOrg(), s.listZones()])
  if (zones.every((z) => isCoreZone(z.id))) throw new BackupError(400, "The brain has no zone yet: create one before importing.")
  const fallback = (defaultZone && zones.some((z) => z.id === defaultZone) ? defaultZone : null) ?? matchZone("sales", zones)
  const backup = newBackup("clients", { name: org.name, description: org.description })
  const at = new Date().toISOString()
  const unknownZones = new Set<string>()
  backup.items = clients.map((c) => {
    const zone = matchZone(c.zone, zones)
    if (c.zone && !zone) unknownZones.add(c.zone)
    return clientItem(c, zone ?? fallback ?? classifyZones(`client ${c.name} ${c.notes}`, zones, 1)[0] ?? zones[0].id, at)
  })
  for (const z of unknownZones) problems.push(`Zone "${z}" not found: its clients go to the default zone.`)
  return { backup, problems }
}
