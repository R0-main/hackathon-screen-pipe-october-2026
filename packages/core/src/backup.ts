// Export and import of a company brain: the whole brain, its skills, its clients, or one employee's sheet.
//
// One JSON format for every export (`format: "nos-brainer"`), so that any file can be imported back, into the same
// company or another one. People are referred to by `ref` (their id in the exporting brain): the importing brain maps
// them to its own accounts (same email, then same name) or creates them. Tokens are never exported.
// Clients can also come from a spreadsheet (CSV: name, zone, notes), and an employee sheet reads as Markdown.

import { z } from "zod"
import { normalize } from "./text"
import { ENTITY_TYPES, KNOWLEDGE_KINDS, SOURCE_TOOLS, type Entity, type KnowledgeKind, type TaskStatus, type Zone } from "./types"

export const BACKUP_FORMAT = "nos-brainer"
export const BACKUP_VERSION = 1
export const BACKUP_KINDS = ["brain", "skills", "clients", "person"] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/** Bounds of an imported file (a few thousand knowledge items is already a big company). */
export const BACKUP_MAX_ITEMS = 20_000
export const BACKUP_MAX_PEOPLE = 2_000

const ZoneSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).default(""),
  color: z.string().max(32).default(""),
  keywords: z.array(z.string().max(80)).max(100).default([]),
  position: z.number().int().min(0).max(1000).default(0),
})

const PersonSchema = z.object({
  ref: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  email: z.string().max(200).optional(),
  title: z.string().max(80).optional(),
  role: z.enum(["admin", "member"]).default("member"),
  manager_ref: z.string().max(64).nullable().optional(),
  can_publish_skills: z.boolean().optional(),
  /** Zones this person reads. */
  zones: z.array(z.string().max(64)).max(100).default([]),
})

const ItemSchema = z.object({
  ref: z.string().max(64).optional(),
  author_ref: z.string().max(64).nullable().optional(),
  zone: z.string().min(1).max(64),
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().min(1).max(300),
  body: z.string().max(8000).default(""),
  entities: z
    .array(z.object({ type: z.enum(ENTITY_TYPES), name: z.string().min(1).max(120) }))
    .max(20)
    .default([]),
  source: z
    .object({
      app: z.string().max(120).default("import"),
      tool: z.enum(SOURCE_TOOLS).default("agent"),
      at: z.string().max(40).optional(),
      session_id: z.string().max(200).optional(),
    })
    .default({ app: "import", tool: "agent" }),
  confidence: z.number().min(0).max(1).default(0.6),
  created_at: z.string().max(40).optional(),
})

const TaskSchema = z.object({
  title: z.string().min(1).max(300),
  zone: z.string().min(1).max(64),
  status: z.enum(["open", "done"]).default("open"),
  assignee_ref: z.string().max(64).nullable().optional(),
  item_ref: z.string().max(64).nullable().optional(),
  created_at: z.string().max(40).optional(),
})

const SkillSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1024).default(""),
  zone: z.string().max(64).nullable().default(null),
  files: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(200_000) }))
    .min(1)
    .max(50),
})

export const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1).max(BACKUP_VERSION),
  kind: z.enum(BACKUP_KINDS),
  exported_at: z.string().max(40).optional(),
  org: z.object({ name: z.string().max(200), description: z.string().max(4000).default("") }).optional(),
  zones: z.array(ZoneSchema).max(100).default([]),
  people: z.array(PersonSchema).max(BACKUP_MAX_PEOPLE).default([]),
  items: z.array(ItemSchema).max(BACKUP_MAX_ITEMS).default([]),
  tasks: z.array(TaskSchema).max(BACKUP_MAX_ITEMS).default([]),
  skills: z.array(SkillSchema).max(500).default([]),
})

export type Backup = z.infer<typeof BackupSchema>
export type BackupPerson = z.infer<typeof PersonSchema>
export type BackupItem = z.infer<typeof ItemSchema>
export type BackupTask = z.infer<typeof TaskSchema>
export type BackupSkill = z.infer<typeof SkillSchema>
export type BackupZone = Zone

/** An empty backup of this kind, to fill in. */
export function newBackup(kind: BackupKind, org?: { name: string; description: string }): Backup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, kind, exported_at: new Date().toISOString(), org, zones: [], people: [], items: [], tasks: [], skills: [] }
}

/** Reads a backup file: the backup, or the first readable problems. */
export function parseBackup(raw: unknown): { backup: Backup } | { problems: string[] } {
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== BACKUP_FORMAT)
    return { problems: ["This is not a NOS Brainer export (the \"format\" field is missing)."] }
  const parsed = BackupSchema.safeParse(raw)
  if (parsed.success) return { backup: parsed.data }
  return { problems: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "file"}: ${i.message}`) }
}

/** Same person in two brains: same email, otherwise same name (accents and case ignored). */
export function personKey(p: { name: string; email?: string | null }): { email: string | null; name: string } {
  return { email: p.email?.trim().toLowerCase() || null, name: normalize(p.name).replace(/\s+/g, " ").trim() }
}

/** Identity of a knowledge item for deduplication at import: zone, normalized title and content. */
export function itemKey(i: { zone: string; title: string; body: string }): string {
  const t = (s: string) => normalize(s).replace(/\s+/g, " ").trim()
  return JSON.stringify([i.zone, t(i.title), t(i.body)])
}

// ---------- Clients as a spreadsheet ----------

/** One client of a spreadsheet: its name, the zone it belongs to (optional) and what is known about it. */
export type ClientRow = { name: string; zone?: string; notes: string }

/** Splits CSV text (comma or semicolon, quotes doubled inside quoted fields) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "")
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ""
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ","
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === "") quoted = true
    else if (c === sep) {
      row.push(cell)
      cell = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += c
  }
  if (cell !== "" || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

const csvCell = (s: string) => (/[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function toCsv(rows: string[][]): string {
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`
}

const NAME_HEADERS = ["name", "client", "customer", "company", "nom", "societe", "entreprise", "account"]
const ZONE_HEADERS = ["zone", "team", "department", "equipe", "service"]
const NOTES_HEADERS = ["notes", "note", "description", "summary", "details", "comment", "comments", "commentaire", "resume", "knowledge"]

/**
 * Clients of a spreadsheet. The first row is a header when it names a column (name / client / company…, zone,
 * notes / description…); otherwise the columns are read as name, zone, notes. Every other column is appended to the
 * notes as "column: value" (contact, city, contract…).
 */
export function clientsFromCsv(text: string): { clients: ClientRow[]; problems: string[] } {
  const rows = parseCsv(text)
  if (rows.length === 0) return { clients: [], problems: ["The file is empty."] }
  const header = rows[0].map((h) => normalize(h).replace(/[^a-z0-9]+/g, " ").trim())
  const find = (names: string[]) => header.findIndex((h) => names.includes(h))
  let nameCol = find(NAME_HEADERS)
  const hasHeader = nameCol >= 0
  if (!hasHeader) nameCol = 0
  const zoneCol = hasHeader ? find(ZONE_HEADERS) : rows[0].length > 2 ? 1 : -1
  const notesCol = hasHeader ? find(NOTES_HEADERS) : rows[0].length > 2 ? 2 : 1
  const extra = hasHeader ? rows[0].map((h, i) => ({ h: h.trim(), i })).filter(({ i }) => i !== nameCol && i !== zoneCol && i !== notesCol) : []
  const clients: ClientRow[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [n, r] of (hasHeader ? rows.slice(1) : rows).entries()) {
    const name = (r[nameCol] ?? "").trim().slice(0, 120)
    if (!name) {
      problems.push(`Row ${n + (hasHeader ? 2 : 1)}: no client name, skipped.`)
      continue
    }
    const key = normalize(name)
    if (seen.has(key)) continue
    seen.add(key)
    const notes = [
      (notesCol >= 0 ? r[notesCol] : "")?.trim() ?? "",
      ...extra.map(({ h, i }) => ((r[i] ?? "").trim() ? `${h}: ${r[i].trim()}` : "")),
    ]
      .filter(Boolean)
      .join("\n")
    const zone = zoneCol >= 0 ? (r[zoneCol] ?? "").trim() : ""
    clients.push({ name, zone: zone || undefined, notes: notes.slice(0, 8000) })
  }
  return { clients, problems: problems.slice(0, 10) }
}

/** A zone written by hand in a spreadsheet ("Sales", "sales", "Ventes"…) → the id of a known zone, if one matches. */
export function matchZone(written: string | undefined, zones: Pick<Zone, "id" | "name">[]): string | null {
  if (!written) return null
  const w = normalize(written).trim()
  return zones.find((z) => z.id === w || normalize(z.name).trim() === w)?.id ?? null
}

/** The knowledge item that introduces a client of a spreadsheet to the brain. */
export function clientItem(c: ClientRow, zone: string, at = new Date().toISOString()): BackupItem {
  return {
    zone,
    kind: "fact",
    title: `Client: ${c.name}`.slice(0, 300),
    body: c.notes || `${c.name} is a client of the company.`,
    entities: [{ type: "client", name: c.name }],
    source: { app: "import", tool: "agent", at },
    confidence: 0.8,
    created_at: at,
  }
}

/** Clients cited by these items, with how often, in which zones, and when last. */
export function clientsOf(items: { zone: string; entities: Entity[]; created_at?: string }[]) {
  const out = new Map<string, { name: string; count: number; zones: Set<string>; last_at: string | null }>()
  for (const i of items)
    for (const e of i.entities) {
      if (e.type !== "client") continue
      const key = normalize(e.name)
      const c = out.get(key) ?? { name: e.name, count: 0, zones: new Set<string>(), last_at: null }
      c.count++
      c.zones.add(i.zone)
      if (i.created_at && (!c.last_at || i.created_at > c.last_at)) c.last_at = i.created_at
      out.set(key, c)
    }
  return [...out.values()].map((c) => ({ ...c, zones: [...c.zones] })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

// ---------- Employee sheet ----------

export type SheetItem = { kind: KnowledgeKind; title: string; body: string; zone: string; created_at: string }

/** What an employee sheet says about a person: who they are, where they work, and what they did. */
export type PersonSheet = {
  company: string
  person: { name: string; title?: string; email?: string; role: "admin" | "member"; since: string }
  manager: string | null
  reports: string[]
  /** Zones by share of activity (knowledge and agent events). */
  zones: { name: string; share: number; items: number }[]
  readable_zones: string[]
  totals: { items: number; decisions: number; procedures: number; facts: number; questions: number; tasks_open: number; tasks_done: number }
  first_at: string | null
  last_at: string | null
  last_sync: { at: string; ok: boolean } | null
  items: SheetItem[]
  tasks: { title: string; zone: string; status: TaskStatus; updated_at: string }[]
  topics: { type: string; name: string; count: number }[]
  prompts: { summary: string; count: number }[]
  skills: { name: string; description: string; version: number }[]
  generated_at: string
  /** True when the reader does not see every zone: the sheet only covers what they read. */
  partial: boolean
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "-")
const line = (s: string) => s.replace(/\s+/g, " ").trim()
const KIND_TITLES: Record<KnowledgeKind, string> = {
  decision: "Decisions",
  procedure: "Procedures",
  fact: "Facts",
  task: "Tasks noted in sessions",
  question: "Open questions",
}

/** The employee sheet in Markdown: readable as is, pasted in a doc, or handed to whoever takes over. */
export function personSheetMarkdown(s: PersonSheet): string {
  const out: string[] = []
  const p = s.person
  out.push(`# ${p.name}${p.title ? `, ${p.title}` : ""}`, "")
  out.push(`Employee sheet from the ${s.company} brain, generated on ${day(s.generated_at)}.`)
  if (s.partial) out.push("It only covers the zones the reader has access to.")
  out.push("")
  out.push("## Identity", "")
  out.push(`- Role: ${p.role === "admin" ? "admin" : "member"}`)
  if (p.email) out.push(`- Email: ${p.email}`)
  if (s.manager) out.push(`- Reports to: ${s.manager}`)
  if (s.reports.length) out.push(`- Manages: ${s.reports.join(", ")}`)
  out.push(`- In the brain since: ${day(p.since)}`)
  out.push(`- Reads the zones: ${s.readable_zones.length ? s.readable_zones.join(", ") : "none"}`)
  if (s.last_sync) out.push(`- Last sync of their computer: ${day(s.last_sync.at)}${s.last_sync.ok ? "" : " (failed)"}`)
  out.push("")

  out.push("## Summary", "")
  const t = s.totals
  if (t.items === 0) out.push("No knowledge from this person yet.")
  else {
    const main = s.zones[0]
    out.push(
      `${p.name} brought ${t.items} piece${t.items === 1 ? "" : "s"} of knowledge to the brain between ${day(s.first_at)} and ${day(s.last_at)}: ` +
        `${t.decisions} decision${t.decisions === 1 ? "" : "s"}, ${t.procedures} procedure${t.procedures === 1 ? "" : "s"}, ${t.facts} fact${t.facts === 1 ? "" : "s"}` +
        `${t.questions ? `, ${t.questions} open question${t.questions === 1 ? "" : "s"}` : ""}.` +
        (main ? ` Most of the work happens in ${main.name} (${main.share}%).` : ""),
    )
  }
  if (t.tasks_open + t.tasks_done) out.push("", `Tasks: ${t.tasks_open} open, ${t.tasks_done} done.`)
  out.push("")

  if (s.zones.length) {
    out.push("## Where the work happens", "", "| Zone | Share | Knowledge |", "| --- | ---: | ---: |")
    for (const z of s.zones) out.push(`| ${z.name} | ${z.share}% | ${z.items} |`)
    out.push("")
  }

  out.push("## Who did what", "")
  const kinds: KnowledgeKind[] = ["decision", "procedure", "fact", "task", "question"]
  let any = false
  for (const k of kinds) {
    const list = s.items.filter((i) => i.kind === k)
    if (!list.length) continue
    any = true
    out.push(`### ${KIND_TITLES[k]}`, "")
    for (const i of list) {
      out.push(`- **${line(i.title)}** (${i.zone}, ${day(i.created_at)})`)
      const body = line(i.body)
      if (body && body !== line(i.title)) out.push(`  ${body.length > 400 ? `${body.slice(0, 399)}…` : body}`)
    }
    out.push("")
  }
  if (!any) out.push("Nothing yet.", "")

  if (s.tasks.length) {
    out.push("## Tasks", "")
    for (const task of s.tasks) out.push(`- [${task.status === "done" ? "x" : " "}] ${line(task.title)} (${task.zone})`)
    out.push("")
  }

  if (s.topics.length) {
    out.push("## Recurring clients, projects and tools", "")
    for (const e of s.topics) out.push(`- ${e.name} (${e.type}, ${e.count})`)
    out.push("")
  }

  if (s.prompts.length) {
    out.push("## Most frequent prompts", "")
    for (const pr of s.prompts) out.push(`- ${pr.count}× ${line(pr.summary)}`)
    out.push("")
  }

  if (s.skills.length) {
    out.push("## Skills published", "")
    for (const sk of s.skills) out.push(`- ${sk.name} (v${sk.version}): ${line(sk.description)}`)
    out.push("")
  }

  out.push("---", "", "Only distilled knowledge is in this sheet, never raw conversations or screen captures.", "")
  return out.join("\n")
}
