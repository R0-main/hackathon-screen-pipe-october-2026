// Connecteurs (Notion, Linear, Todoist, calendrier ICS) : la partie pure, sans réseau — analyse des réponses des
// outils et conversion en connaissances / tâches du cerveau. Les appels HTTP sont dans apps/web/lib/connectors.

import { extractEntities } from "./distill"
import { truncate } from "./text"
import type { Entity, KnowledgeItemInput, KnowledgeKind, TaskStatus } from "./types"

export const CONNECTOR_IDS = ["notion", "linear", "todoist", "calendar"] as const
export type ConnectorId = (typeof CONNECTOR_IDS)[number]

export function isConnectorId(v: unknown): v is ConnectorId {
  return typeof v === "string" && (CONNECTOR_IDS as readonly string[]).includes(v)
}

export type ConnectorRun = { at: string; ok: boolean; imported: number; error?: string; duration_ms?: number }

/** Réglages d'un connecteur, conservés dans les réglages de l'entreprise (jamais renvoyés avec le jeton en clair). */
export type ConnectorConfig = {
  /** Jeton d'accès (Notion, Linear, Todoist). */
  token?: string
  /** Adresse du flux (calendrier ICS). */
  url?: string
  /** Zone par défaut ; absente : classement automatique. */
  zone?: string
  enabled: boolean
  last_run?: ConnectorRun
}

export type ConnectorsConfig = Partial<Record<ConnectorId, ConnectorConfig>>

/** Ce que le dashboard reçoit : la config sans le secret, avec un témoin « renseigné ». */
export type ConnectorPublic = { id: ConnectorId; configured: boolean; enabled: boolean; zone?: string; url?: string; has_token: boolean; last_run?: ConnectorRun }

export function publicConnector(id: ConnectorId, c: ConnectorConfig | undefined): ConnectorPublic {
  const hasToken = Boolean(c?.token)
  const configured = id === "calendar" ? Boolean(c?.url) : hasToken
  return { id, configured, enabled: Boolean(c?.enabled) && configured, zone: c?.zone, url: id === "calendar" ? c?.url : undefined, has_token: hasToken, last_run: c?.last_run }
}

/** Intervalle entre deux synchronisations automatiques d'un connecteur. */
export const CONNECTOR_INTERVAL_MS = 60 * 60_000

export function connectorDue(c: ConnectorConfig | undefined, now = Date.now()): boolean {
  if (!c?.enabled) return false
  if (!c.last_run) return true
  return now - Date.parse(c.last_run.at) >= CONNECTOR_INTERVAL_MS
}

/** Tâche importée d'un outil, avant son entrée dans le cerveau (zone décidée côté serveur). */
export type ExternalTask = { external_source: ConnectorId; external_id: string; external_url?: string; title: string; status: TaskStatus; zone_hint: string }

// ---------------------------------------------------------------------------------------------------------------------
// Calendrier (ICS)

export type IcsEvent = { uid: string; summary: string; description: string; location: string; start: string; end: string | null; attendees: string[]; organizer: string | null; all_day: boolean }

/** Déplie les lignes (RFC 5545 : une ligne qui commence par un espace continue la précédente). */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) out[out.length - 1] += raw.slice(1)
    else out.push(raw)
  }
  return out
}

function unescapeIcs(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\\\/g, "\\")
}

/** « 20261017T090000Z », « 20261017T090000 » (+ TZID ignoré : heure locale de l'organisateur), « 20261017 » (journée). */
export function parseIcsDate(value: string): { iso: string; allDay: boolean } | null {
  const v = value.trim()
  const date = v.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (date) return { iso: `${date[1]}-${date[2]}-${date[3]}T00:00:00.000Z`, allDay: true }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? { iso, allDay: false } : null
}

/** Événements d'un flux ICS (une occurrence par VEVENT ; les RRULE ne sont pas développées). */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let cur: Partial<IcsEvent> | null = null
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = { attendees: [], description: "", location: "", summary: "", organizer: null, end: null, all_day: false }
      continue
    }
    if (line === "END:VEVENT") {
      if (cur?.uid && cur.start) events.push(cur as IcsEvent)
      cur = null
      continue
    }
    if (!cur) continue
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const left = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [name, ...params] = left.split(";")
    switch (name.toUpperCase()) {
      case "UID":
        cur.uid = value.trim()
        break
      case "SUMMARY":
        cur.summary = unescapeIcs(value).trim()
        break
      case "DESCRIPTION":
        cur.description = unescapeIcs(value).trim()
        break
      case "LOCATION":
        cur.location = unescapeIcs(value).trim()
        break
      case "DTSTART": {
        const d = parseIcsDate(value)
        if (d) {
          cur.start = d.iso
          cur.all_day = d.allDay
        }
        break
      }
      case "DTEND": {
        const d = parseIcsDate(value)
        if (d) cur.end = d.iso
        break
      }
      case "ATTENDEE":
      case "ORGANIZER": {
        const cn = params.find((p) => p.toUpperCase().startsWith("CN="))?.slice(3).replace(/^"|"$/g, "")
        const mail = value.replace(/^mailto:/i, "").trim()
        const who = cn && cn.trim() ? cn.trim() : mail.split("@")[0]
        if (name.toUpperCase() === "ORGANIZER") cur.organizer = who
        else if (who && !cur.attendees!.includes(who)) cur.attendees!.push(who)
        break
      }
    }
  }
  return events
}

export const CALENDAR_PAST_DAYS = 7
export const CALENDAR_FUTURE_DAYS = 14

/** Les événements de la fenêtre (7 jours en arrière, 14 en avant), sans ceux dont le titre est vide. */
export function calendarWindow(events: IcsEvent[], now = Date.now()): IcsEvent[] {
  const from = now - CALENDAR_PAST_DAYS * 86400_000
  const to = now + CALENDAR_FUTURE_DAYS * 86400_000
  return events.filter((e) => e.summary && Date.parse(e.start) >= from && Date.parse(e.start) <= to).sort((a, b) => a.start.localeCompare(b.start))
}

function dayLabel(iso: string, allDay: boolean): string {
  const d = new Date(iso)
  const date = d.toISOString().slice(0, 10)
  return allDay ? date : `${date} ${d.toISOString().slice(11, 16)} UTC`
}

/** Une réunion → une connaissance « fait » : qui, quand, de quoi (description masquée côté serveur à l'ingestion). */
export function calendarEventToItem(ev: IcsEvent, zone: string, now = Date.now()): KnowledgeItemInput {
  const future = Date.parse(ev.start) > now
  const people = [...new Set([ev.organizer, ...ev.attendees].filter((x): x is string => Boolean(x)))].slice(0, 8)
  const lines = [
    `${future ? "Réunion prévue" : "Réunion"} le ${dayLabel(ev.start, ev.all_day)}${ev.end && !ev.all_day ? ` (fin ${new Date(ev.end).toISOString().slice(11, 16)} UTC)` : ""}.`,
    people.length ? `Participants : ${people.join(", ")}.` : "",
    ev.location ? `Lieu : ${ev.location}.` : "",
    ev.description ? truncate(ev.description, 1500) : "",
  ].filter(Boolean)
  const entities: Entity[] = people.slice(0, 6).map((name) => ({ type: "person", name }))
  return {
    zone,
    kind: "fact",
    title: truncate(`${future ? "À venir" : "Réunion"} : ${ev.summary} (${dayLabel(ev.start, true)})`, 200),
    body: lines.join("\n"),
    entities,
    source: { app: "Calendrier", tool: "connector", at: ev.start, session_id: `calendar:${ev.uid}` },
    confidence: 0.7,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Notion

type RichText = { plain_text?: string }
type NotionBlock = { type?: string; has_children?: boolean; [k: string]: unknown }

const NOTION_TEXT_BLOCKS: Record<string, string> = {
  paragraph: "",
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "1. ",
  to_do: "[ ] ",
  toggle: "",
  quote: "> ",
  callout: "",
  code: "",
}

function richText(v: unknown): string {
  return Array.isArray(v) ? (v as RichText[]).map((r) => r.plain_text ?? "").join("") : ""
}

/** Texte lisible d'une liste de blocs Notion (GET /v1/blocks/:id/children). Les tableaux et bases sont ignorés. */
export function notionBlocksToText(blocks: NotionBlock[]): string {
  const lines: string[] = []
  for (const b of blocks) {
    const type = String(b.type ?? "")
    if (!(type in NOTION_TEXT_BLOCKS)) continue
    const payload = b[type] as { rich_text?: unknown; checked?: boolean } | undefined
    const text = richText(payload?.rich_text).trim()
    if (!text) continue
    const prefix = type === "to_do" ? (payload?.checked ? "[x] " : "[ ] ") : NOTION_TEXT_BLOCKS[type]
    lines.push(prefix + text)
  }
  return lines.join("\n")
}

/** Titre d'une page Notion (la propriété de type `title`), ou « Sans titre ». */
export function notionPageTitle(page: { properties?: Record<string, { type?: string; title?: unknown }> }): string {
  for (const p of Object.values(page.properties ?? {})) if (p?.type === "title") return richText(p.title).trim() || "Sans titre"
  return "Sans titre"
}

const PROCEDURE_RE = /\b(proc[ée]dure|process|how[- ]to|checklist|runbook|guide|tuto|étapes|steps|playbook|onboarding)\b/i
const DECISION_RE = /\b(d[ée]cision|adr|arbitrage|rfc|choix)\b/i

export function notionKind(title: string): KnowledgeKind {
  if (PROCEDURE_RE.test(title)) return "procedure"
  if (DECISION_RE.test(title)) return "decision"
  return "fact"
}

export function notionPageToItem(page: { id: string; url?: string; last_edited_time?: string; properties?: Record<string, { type?: string; title?: unknown }> }, text: string, zone: string): KnowledgeItemInput | null {
  const title = notionPageTitle(page)
  const body = text.trim()
  if (!body) return null
  return {
    zone,
    kind: notionKind(title),
    title: truncate(title, 200),
    body: truncate(body, 4000),
    entities: extractEntities(`${title}\n${body}`).slice(0, 12),
    source: { app: "Notion", tool: "connector", at: page.last_edited_time ?? new Date().toISOString(), session_id: `notion:${page.id}`, screenpipe_ref: page.url },
    confidence: 0.75,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Linear et Todoist

export type LinearIssue = { id: string; identifier?: string; title: string; url?: string; description?: string | null; state?: { name?: string; type?: string } | null; team?: { name?: string } | null; project?: { name?: string } | null; labels?: { nodes?: { name: string }[] } | null }

export function linearIssueToTask(issue: LinearIssue): ExternalTask {
  const done = issue.state?.type === "completed" || issue.state?.type === "canceled"
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name)
  return {
    external_source: "linear",
    external_id: issue.id,
    external_url: issue.url,
    title: truncate(`${issue.identifier ? `${issue.identifier} ` : ""}${issue.title}`.trim(), 300),
    status: done ? "done" : "open",
    zone_hint: [issue.title, issue.team?.name, issue.project?.name, ...labels, truncate(issue.description ?? "", 400)].filter(Boolean).join(" "),
  }
}

export type TodoistTask = { id: string; content: string; description?: string; url?: string; is_completed?: boolean; labels?: string[]; project_id?: string }

export function todoistTaskToTask(task: TodoistTask, projectName?: string): ExternalTask {
  return {
    external_source: "todoist",
    external_id: task.id,
    external_url: task.url,
    title: truncate(task.content.trim(), 300),
    status: task.is_completed ? "done" : "open",
    zone_hint: [task.content, projectName, ...(task.labels ?? []), truncate(task.description ?? "", 400)].filter(Boolean).join(" "),
  }
}
