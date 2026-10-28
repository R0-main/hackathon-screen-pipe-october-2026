// The brain's MCP tools, shared by the computer's MCP server (brain.mjs mcp, stdio) and the brain's MCP endpoint
// (/api/mcp/<company>/<token>, HTTP): same names, same descriptions, same markdown answers. Each one provides
// access to the API (HTTP for the computer, internal calls for the brain).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AgentName, Entity, EntityType, KnowledgeItemInput, KnowledgeKind, Profile, Zone } from "./types"
import type { GraphVia } from "./graph"
import type { BrainDocument, DocumentRef } from "./documents"
import { formatBytes } from "./documents"
import { ENTITY_TYPES, KNOWLEDGE_KINDS } from "./types"
import { DEFAULT_ZONES, classifyZones } from "./zones"
import { extractEntities, type ZoneHint } from "./distill"
import { redactText } from "./privacy"
import { normalize, truncate } from "./text"
import { keywordsOf } from "./keywords"

// --- API responses read by the tools -----------------------------------------------------------------------------------

export type ApiZone = Zone & { readable: boolean; count?: number }

export type WhoAmI = {
  /** `id`: missing from an older brain. */
  org: { id?: string; name: string; description: string }
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
  /** Documents (PDF, Word, Excel…) attached to the knowledge, among those the user can open. */
  documents?: DocumentRef[]
  /** Brought by the knowledge graph, not by the words of the query: the entity it shares with which result. */
  via?: GraphVia
}

/** A document found by a search or listed in a zone. */
export type ApiDocument = DocumentRef & { title: string; summary: string; author?: string; created_at: string; score?: number }

/** POST /api/query: a search, its phrasings and its filters (QueryPayloadSchema). */
export type QueryInput = {
  query: string
  phrasings?: string[]
  zones?: string[]
  limit?: number
  agent?: AgentName
  since?: string
  until?: string
  author?: string
}

export type QueryResult = {
  query: string
  /** The agent's other phrasings, searched with the query. */
  phrasings?: string[]
  /** The filter applied (dates as ISO strings, the people `author` named); missing from an older brain. */
  filter?: { since?: string; until?: string; authors?: string[] }
  zones_searched: string[]
  zones_hit: string[]
  zones_restricted: string[]
  items: ApiItem[]
  /** Missing from an older brain. */
  documents?: ApiDocument[]
  /** How the company wants agents to receive the results (its Settings); missing from an older brain. */
  format?: { detail: "compact" | "full"; documents: number }
}

/**
 * GET /api/entities?name=…: an entity's place in the knowledge graph, in the zones the user reads: the knowledge that
 * cites it and the entities most often cited with it. `entity` null: nothing cites that name, `suggestions` are close ones.
 */
export type EntityResult = {
  entity: { type: string; name: string } | null
  /** Knowledge items citing it, when more than `items` were returned. */
  total?: number
  zones: string[]
  items: ApiItem[]
  related: { type: string; name: string; count: number }[]
  suggestions: { type: string; name: string; count: number }[]
}

/** GET /api/documents/:id: the document, its text, and the knowledge it backs. */
export type DocumentResult = {
  document: BrainDocument & { text: string; author?: string }
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
  /** Missing from an older brain. */
  documents?: ApiDocument[]
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
export type IngestResult = {
  inserted: number
  skipped?: number
  ids: string[]
  zones: string[]
  per_zone?: Record<string, number>
  /** For each item sent, in order: the id it got, or that of the knowledge it duplicates (null: none). Missing from an older brain. */
  item_ids?: (string | null)[]
}

/** Tools of the company's MCP connectors that are open to agents (GET /api/connected-tools). */
export type ConnectedTools = {
  connectors: { id: string; name: string; mode: "read" | "all" | "off"; tools: { name: string; title?: string; description?: string; input_schema: Record<string, unknown>; read_only: boolean }[] }[]
}

export type ConnectedCall = { text: string; is_error: boolean }

/** What the tools need: the brain's API routes, with the access rights of the person's token. */
export interface BrainToolsApi {
  whoami(): Promise<WhoAmI>
  zones(): Promise<ApiZone[]>
  zone(id: string): Promise<ZoneSummary>
  status(): Promise<CompanyStatusResult>
  query(input: QueryInput): Promise<QueryResult>
  ingest(items: KnowledgeItemInput[], agent?: AgentName): Promise<IngestResult>
  /** A document and its text (the zone lights up for `agent`). */
  document?(id: string, agent?: AgentName): Promise<DocumentResult>
  /** One knowledge item the user can read, by id (search_brain gives them); missing from an older brain. */
  item?(id: string): Promise<{ item: ApiItem }>
  /** An entity's neighborhood in the knowledge graph (its zones light up for `agent`); missing from an older brain. */
  entity?(input: { name: string; type?: EntityType }, agent?: AgentName): Promise<EntityResult>
  /** Connector tools (Notion, Linear, GitHub…) the admin opened to agents. */
  connectedTools?(input: { connector?: string; query?: string }): Promise<ConnectedTools>
  callConnectedTool?(input: { connector: string; tool: string; arguments: Record<string, unknown> }): Promise<ConnectedCall>
}

/** List readable by the model: one connector per section, one tool per line, input schema as compact JSON. */
export function formatConnectedTools(r: ConnectedTools, withSchemas: boolean): string {
  const usable = r.connectors.filter((c) => c.tools.length)
  if (!usable.length)
    return r.connectors.length
      ? "No tool matches: try without `query`, or another connector."
      : "No connector is open to agents in this company (an admin connects them in Connectors)."
  return usable
    .map((c) => {
      const head = `## ${c.name} (\`connector: "${c.id}"\`) — ${c.mode === "all" ? "read and write" : "read-only"}`
      const lines = c.tools.map((t) => {
        const desc = truncate((t.description ?? t.title ?? "").replace(/\s+/g, " "), withSchemas ? 400 : 160)
        const schema = withSchemas ? `\n  arguments : ${truncate(JSON.stringify(t.input_schema), 1500)}` : ""
        return `- \`${t.name}\`${t.read_only ? "" : " (changes data)"}: ${desc}${schema}`
      })
      return [head, ...lines].join("\n")
    })
    .join("\n\n")
}

/**
 * How an agent rewords a question for search_brain (`phrasings`): the evaluation writes its rewordings with this same
 * text (scripts/eval-data/prompts), so what it measures is what agents are asked to do.
 */
export const PHRASINGS_GUIDANCE =
  "Optional but recommended: 1 to 3 other phrasings of the same question, searched with it, to find knowledge written in " +
  "other words. In English (the brain is written in English), with the terms the team would write rather than the " +
  "user's (\"payroll\" for \"who pays salaries\", \"ship to production\" for \"put online\"). Keep every number, date, " +
  "amount and proper noun (customer, tool, project, person) exactly as given; add no fact the question does not state."

// --- Formatting (markdown) ------------------------------------------------------------------------------------------

const KIND_LABELS: Record<string, string> = { fact: "fact", decision: "decision", task: "task", procedure: "procedure", question: "question" }

export type ZoneNamer = (id: string) => string

export function shortDate(iso: string | undefined): string {
  if (!iso) return "?"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Paris" })
}

function itemBlock(i: ApiItem, n: number, zoneName: ZoneNamer): string {
  const meta = [
    `Zone: ${zoneName(i.zone)}`,
    `Type: ${KIND_LABELS[i.kind] ?? i.kind}`,
    `By: ${i.author ?? "?"}`,
    `Date: ${shortDate(i.source?.at ?? i.created_at)}`,
    sourceLabel(i.source),
  ]
    .filter(Boolean)
    .join(" · ")
  const ents = i.entities?.length ? `\nEntities: ${i.entities.map((e) => e.name).join(", ")}` : ""
  const docs = i.documents?.length ? `\nDocuments: ${i.documents.map(docLabel).join(", ")}` : ""
  const via = i.via ? `\nLinked through the knowledge graph: shares ${i.via.entity.name} (${i.via.entity.type}) with "${i.via.from.title}".` : ""
  return `### ${n}. ${i.title}\n${meta}\n\n${i.body.trim()}${ents}${docs}${via}`
}

/** Where a knowledge item comes from: "Source: claude-code in Terminal", the tool alone, or nothing. */
function sourceLabel(src: ApiItem["source"] | undefined): string {
  const app = src?.app && src.app !== "unknown" ? src.app : ""
  if (!src?.tool) return app ? `Source: ${app}` : ""
  return `Source: ${src.tool}${app && normalize(app) !== normalize(src.tool) ? ` in ${app}` : ""}`
}

/** The filter of a search, in words: "by Sarah Cohen, from 01 Oct 2026, until 20 Oct 2026". */
function filterLabel(f: QueryResult["filter"]): string {
  if (!f) return ""
  const parts = [
    f.authors ? (f.authors.length ? `by ${f.authors.join(" or ")}` : "by nobody of that name") : "",
    f.since ? `from ${shortDate(f.since)}` : "",
    f.until ? `before ${shortDate(f.until)}` : "",
  ].filter(Boolean)
  return parts.length ? `; filter: ${parts.join(", ")}` : ""
}

/** "revenus-T3.pdf (20 KB, id `…`)": the id is what get_document takes. */
function docLabel(d: DocumentRef): string {
  return `${d.name} (${formatBytes(d.size)}, id \`${d.id}\`)`
}

function documentsBlock(docs: ApiDocument[], zoneName: ZoneNamer, heading: string): string {
  const lines = docs.map((d) => `- **${d.title}** — ${docLabel(d)} · Zone: ${zoneName(d.zone)}${d.author ? ` · By: ${d.author}` : ""} · ${shortDate(d.created_at)}${d.summary ? `\n  ${truncate(d.summary, 240)}` : ""}`)
  return `### ${heading}\n${lines.join("\n")}\n\nOpen one with get_document (its id) to read its full text.`
}

/** get_knowledge's answer: each item in full, or a line saying it cannot be read (`null`, in the ids' order). */
export function formatKnowledge(items: (ApiItem | null)[], ids: string[], zoneName: ZoneNamer): string {
  return items
    .map((i, n) => (i ? itemBlock(i, n + 1, zoneName) : `### ${n + 1}. Not found\nNo knowledge you can read has the id \`${ids[n]}\`.`))
    .join("\n\n---\n\n")
}

/** One line for a result past the first ones: what it is, who, when, and the id get_knowledge reads it by. */
function itemLine(i: ApiItem, n: number, zoneName: ZoneNamer): string {
  const via = i.via ? ` · linked through ${i.via.entity.name} (${i.via.entity.type})` : ""
  return `${n}. ${i.title} — ${zoneName(i.zone)}, ${KIND_LABELS[i.kind] ?? i.kind}, ${i.author ?? "?"}, ${shortDate(i.source?.at ?? i.created_at)}${via} · id \`${i.id}\``
}

/**
 * How search_brain answers. `full`: the first results in full (the others in one line each, read with
 * get_knowledge); `documents`: matching documents listed at most. Without options, everything in full.
 */
export type QueryFormat = { full?: number; documents?: number }

/** search_brain by default: the 3 best results in full, the next ones in one line, 2 documents at most. */
export const COMPACT_FORMAT: Required<QueryFormat> = { full: 3, documents: 2 }

/**
 * search_brain's format: what the agent asked (`detail`), otherwise what the company chose in its Settings (the
 * brain's `format`), otherwise compact. Documents: the company's number, 2 by default.
 */
export function agentFormat(detail: "compact" | "full" | undefined, company?: QueryResult["format"]): QueryFormat {
  const documents = company?.documents ?? COMPACT_FORMAT.documents
  return (detail ?? company?.detail ?? "compact") === "full" ? { documents } : { full: COMPACT_FORMAT.full, documents }
}

export function formatQuery(r: QueryResult, zoneName: ZoneNamer, format: QueryFormat = {}): string {
  const searched = r.zones_searched.length ? r.zones_searched.map(zoneName).join(", ") : "none"
  const restricted = r.zones_restricted?.length
    ? "\n\nNote: zones you do not have access to might know more (ask an admin or the person concerned)."
    : ""
  if (!r.items.length) {
    return (
      `No knowledge found in the brain for "${r.query}" (zones searched: ${searched}${filterLabel(r.filter)}).\n` +
      `Try other keywords (customer, tool or project name) or list_zones to see the available areas.${restricted}`
    )
  }
  const linked = r.items.filter((i) => i.via).length
  const graph = linked ? `, ${linked} of them linked through the knowledge graph` : ""
  const head = `## Company brain — "${r.query}"\n${r.items.length} result${r.items.length > 1 ? "s" : ""} (zones searched: ${searched}${filterLabel(r.filter)}${graph})`
  const shownDocs = r.documents?.slice(0, format.documents ?? Infinity) ?? []
  const moreDocs = (r.documents?.length ?? 0) - shownDocs.length
  const docs = shownDocs.length
    ? `\n\n${documentsBlock(shownDocs, zoneName, "Matching documents")}${moreDocs > 0 ? ` ${moreDocs} more document${moreDocs > 1 ? "s" : ""} match: narrow the search to see them.` : ""}`
    : ""
  const full = r.items.slice(0, format.full ?? r.items.length)
  const rest = r.items.slice(full.length)
  const lines = rest.length
    ? `\n\n---\n\n### Also relevant (read one with get_knowledge and its id)\n${rest.map((i, n) => itemLine(i, full.length + n + 1, zoneName)).join("\n")}`
    : ""
  return `${head}\n\n${full.map((i, n) => itemBlock(i, n + 1, zoneName)).join("\n\n---\n\n")}${lines}${docs}${restricted}`
}

/** Knowledge listed by explore_entity: the most recent, each in a few lines (search_brain gives the full text). */
export const ENTITY_ITEMS_FOR_AGENT = 12

export function formatEntity(r: EntityResult, asked: string, zoneName: ZoneNamer): string {
  if (!r.entity) {
    const close = r.suggestions.length
      ? `\n\nClosest names in the brain: ${r.suggestions.map((e) => `${e.name} (${e.type})`).join(", ")}. Try explore_entity with one of them.`
      : "\n\nTry search_brain with words instead, or list_zones to see the available areas."
    return `Nothing in the brain cites "${asked}" in the zones you can read.${close}`
  }
  const e = r.entity
  const shown = r.items.slice(0, ENTITY_ITEMS_FOR_AGENT)
  const lines = shown.map((i) => {
    const meta = [zoneName(i.zone), KIND_LABELS[i.kind] ?? i.kind, i.author ?? "?", shortDate(i.source?.at ?? i.created_at)].join(" · ")
    return `- **${i.title}** (${meta})\n  ${truncate(i.body.replace(/\s+/g, " ").trim(), 280)}`
  })
  const total = Math.max(r.total ?? 0, r.items.length)
  const more = total > shown.length ? `\n- …and ${total - shown.length} more (search_brain "${e.name}" for the full text).` : ""
  const related = r.related.length
    ? `\n\n### Often cited with it\n${r.related.slice(0, 10).map((x) => `- ${x.name} (${x.type}), ${x.count} time${x.count > 1 ? "s" : ""}`).join("\n")}\n\nWalk on with explore_entity on one of them.`
    : ""
  const zones = r.zones.length ? r.zones.map(zoneName).join(", ") : "none you can read"
  return (
    `## ${e.name} (${e.type}) in the company brain\n${total} knowledge item${total > 1 ? "s" : ""} cite${total > 1 ? "" : "s"} it (zones: ${zones})\n\n` +
    `${lines.join("\n")}${more}${related}`
  )
}

/** Text given to the agent: enough for a quarterly report or a price list, bounded for its context. */
export const DOCUMENT_TEXT_FOR_AGENT = 40_000

export function formatDocument(r: DocumentResult, zoneName: ZoneNamer): string {
  const d = r.document
  const meta = [
    `Zone: ${zoneName(d.zone)}`,
    `By: ${d.author ?? "?"}`,
    `Added: ${shortDate(d.created_at)}`,
    `${d.name}, ${formatBytes(d.size)}${d.pages ? `, ${d.pages} page${d.pages > 1 ? "s" : ""}` : ""}`,
  ].join(" · ")
  const text = d.text.trim()
  const body = text
    ? `${text.slice(0, DOCUMENT_TEXT_FOR_AGENT)}${text.length > DOCUMENT_TEXT_FOR_AGENT ? `\n\n[… text cut: ${text.length - DOCUMENT_TEXT_FOR_AGENT} more characters, ask the person for the file itself]` : ""}`
    : "(no readable text: a scan or an image; the file can be downloaded from the dashboard)"
  const linked = r.items.length ? `\n\n### Knowledge it backs\n${r.items.map((i) => `- [${KIND_LABELS[i.kind] ?? i.kind}] ${i.title} (${zoneName(i.zone)}, ${shortDate(i.source?.at ?? i.created_at)})`).join("\n")}` : ""
  return `## Document — ${d.title}\n${meta}\n\n### Text\n${body}${linked}`
}

export function formatZones(zones: ApiZone[]): string {
  const lines = zones
    .sort((a, b) => a.position - b.position)
    .map((z) => `- **${z.name}** (\`${z.id}\`): ${z.description}${z.readable ? ` — accessible, ${z.count ?? 0} knowledge item${(z.count ?? 0) === 1 ? "" : "s"}` : " — not accessible"}`)
  return `## Brain zones\n${lines.join("\n")}\n\nUse the id between backticks with get_zone_summary or in the zones filter of search_brain.`
}

export function formatZoneSummary(s: ZoneSummary): string {
  const parts = [`## Zone ${s.zone.name} (\`${s.zone.id}\`)`, s.zone.description]
  if (s.status) {
    parts.push(`### Status\n${s.status.summary}\nProgress: ${s.status.progress}`)
    if (s.status.objectives.length) parts.push(`Goals:\n${s.status.objectives.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.next_steps.length) parts.push(`Next steps:\n${s.status.next_steps.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.who_did_what.length) parts.push(`Who did what:\n${s.status.who_did_what.map((w) => `- ${w.person}: ${w.did}`).join("\n")}`)
  }
  const recent = s.items.slice(0, 12)
  parts.push(
    recent.length
      ? `### Recent knowledge\n${recent.map((i) => `- [${KIND_LABELS[i.kind] ?? i.kind}] ${i.title} — ${i.author ?? "?"}, ${shortDate(i.source?.at ?? i.created_at)}`).join("\n")}`
      : "### Recent knowledge\n(none for now)",
  )
  const open = s.tasks.filter((t) => t.status !== "done").slice(0, 10)
  if (open.length) parts.push(`### Open tasks\n${open.map((t) => `- ${t.title}${t.assignee ? ` (${t.assignee})` : ""}`).join("\n")}`)
  if (s.entities.length) parts.push(`### Most cited entities\n${s.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
  if (s.documents?.length) parts.push(documentsBlock(s.documents.slice(0, 10), (id) => (id === s.zone.id ? s.zone.name : id), "Documents"))
  return parts.join("\n\n")
}

export function formatWhoami(w: WhoAmI, zoneName: ZoneNamer): string {
  const p = w.profile
  const parts = [
    `## ${p.name}${p.title ? ` — ${p.title}` : ""} (${w.org.name})`,
    `Role: ${p.role === "admin" ? "admin" : "member"} · Readable zones: ${w.access.readable.map(zoneName).join(", ") || "none"} · Writable zones: ${w.access.writable.map(zoneName).join(", ") || "none"}`,
  ]
  const c = w.context
  if (c) {
    if (c.zones.length) parts.push(`### Zones most used by this computer\n${c.zones.slice(0, 6).map((z) => `- ${zoneName(z.zone)} (weight ${z.weight})`).join("\n")}`)
    if (c.entities.length) parts.push(`### Main entities\n${c.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
    const prompts = dedupePrompts(c.frequent_prompts)
    if (prompts.length) parts.push(`### Frequent prompts\n${prompts.map((f) => `- "${f.summary}" (${f.count} time${f.count === 1 ? "" : "s"}, last on ${shortDate(f.last)})`).join("\n")}`)
    if (c.decisions.length) parts.push(`### Recent decisions\n${c.decisions.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)}, ${shortDate(i.created_at)})`).join("\n")}`)
    if (c.procedures.length) parts.push(`### Procedures\n${c.procedures.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)})`).join("\n")}`)
    parts.push("Useful for a handover: search_brain then opens the details of each subject.")
  }
  return parts.join("\n\n")
}

function dedupePrompts(list: { summary: string; count: number; last: string }[]) {
  const seen = new Map<string, { summary: string; count: number; last: string }>()
  for (const f of list) {
    const k = f.summary.trim().toLowerCase()
    const prev = seen.get(k)
    if (!prev) seen.set(k, { ...f })
    else {
      prev.count = Math.max(prev.count, f.count)
      if (f.last > prev.last) prev.last = f.last
    }
  }
  return [...seen.values()].slice(0, 8)
}

export function formatStatus(s: CompanyStatusResult, zoneName: ZoneNamer): string {
  if (!s || !s.headline) return "The company status has not been generated yet (an admin can refresh it from the dashboard, or with `brain.mjs refresh-status`)."
  const zones = (s.zones ?? []).map((z) => {
    const lines = [`### ${zoneName(z.zone)}`, z.summary, `Progress: ${z.progress}`]
    if (z.objectives.length) lines.push(`Goals: ${z.objectives.join("; ")}`)
    if (z.next_steps.length) lines.push(`Next steps: ${z.next_steps.join("; ")}`)
    if (z.who_did_what.length) lines.push(`Who did what: ${z.who_did_what.map((w) => `${w.person} — ${w.did}`).join("; ")}`)
    return lines.join("\n")
  })
  return `## Where does the company stand?\n${s.headline}\n\n${zones.join("\n\n")}\n\n(generated on ${shortDate(s.generated_at)}, ${s.generator === "claude" ? "by Claude" : "automatically"})`
}

// --- MCP server ------------------------------------------------------------------------------------------------------

/** Known zones of a company (readable names, remember's classification) and the computer's access rights. */
export type ZoneCache = {
  updated_at?: string
  zones?: (Pick<Zone, "id" | "name" | "description" | "keywords"> & { readable: boolean })[]
  whoami?: { readable: string[]; writable: string[] }
}

/** The company targeted by a tool call. `key` identifies its zone cache; `header` comes before each answer. */
export type BrainMcpTarget = { api: BrainToolsApi; key: string; header?: string; cache?: () => ZoneCache | null }

export type BrainMcpOptions = {
  version?: string
  /** The server's instruction (which company, when to query it). */
  instructions?: string
  /** Description of the `company` parameter (computer connected to several companies); missing: no parameter. */
  companyParam?: string
  /** The company of a call (`company` asked for, otherwise the default one); throws if it is unknown. */
  open: (company?: string) => BrainMcpTarget
  /** Redaction of the text saved by remember (redactText by default): the computer adds its own secrets to it. */
  clean?: (text: string) => string
  /** `source.app` of the knowledge saved by remember. */
  sourceApp?: string
  /** Address of the brain serving the logo (the icon clients show next to the server, and its site); missing: none. */
  baseUrl?: string
}

/** The server's logo, served by the brain (apps/web: app/icon.svg, public/icon.png); the PNG for clients without SVG. */
export function brainIcons(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "")
  return [
    { src: `${base}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    { src: `${base}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
  ]
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

function zoneHints(cache: ZoneCache | null): ZoneHint[] {
  return cache?.zones?.length ? cache.zones : DEFAULT_ZONES
}

function zoneName(cache: ZoneCache | null, id: string): string {
  return cache?.zones?.find((z) => z.id === id)?.name ?? DEFAULT_ZONES.find((z) => z.id === id)?.name ?? id
}

/** The "company-brain" MCP server and its tools, on the company `open` gives. */
export function createBrainMcpServer(opts: BrainMcpOptions): McpServer {
  const identity = opts.baseUrl ? { icons: brainIcons(opts.baseUrl), websiteUrl: opts.baseUrl.replace(/\/+$/, "") } : {}
  const server = new McpServer(
    { name: "company-brain", title: "NOS Brainer", version: opts.version ?? "0.1.0", ...identity },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  )
  // Zones of each company, by key: start from the cache provided, completed on the first call.
  const caches = new Map<string, ZoneCache | null>()

  type Ctx = { api: BrainToolsApi; key: string; header: string }
  const open = (wanted?: string): Ctx => {
    const t = opts.open(wanted)
    if (!caches.has(t.key)) caches.set(t.key, t.cache?.() ?? null)
    return { api: t.api, key: t.key, header: t.header ?? "" }
  }
  const cacheOf = (c: Ctx) => caches.get(c.key) ?? null
  const keepZones = (c: Ctx, zones: ApiZone[]) =>
    caches.set(c.key, {
      ...(cacheOf(c) ?? { updated_at: new Date().toISOString() }),
      zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords, readable: z.readable })),
    })
  const namer = (c: Ctx) => (id: string) => zoneName(cacheOf(c), id)
  /** Accepts a zone id or its name ("Finance", "finance"…). */
  const resolveZone = (c: Ctx, z: string): string => {
    const n = normalize(z.trim())
    const found = cacheOf(c)?.zones?.find((x) => x.id === z || normalize(x.id) === n || normalize(x.name) === n)
    return found?.id ?? z.trim()
  }
  const guard = async (company: string | undefined, fn: (c: Ctx) => Promise<string>): Promise<ToolResult> => {
    try {
      const c = open(company)
      return ok(c.header + (await fn(c)))
    } catch (err) {
      return fail(`Company brain error: ${(err as Error).message}`)
    }
  }
  // Refreshes the zone cache on the first call if needed (readable names, classification).
  const ensureZones = async (c: Ctx) => {
    if (cacheOf(c)?.zones?.length) return
    try {
      keepZones(c, await c.api.zones())
    } catch {
      // no big deal: the ids will be shown
    }
  }
  // `company` parameter, only if the computer has several companies (otherwise nothing to choose). Typed as always
  // present: it is optional, the tools receive it `undefined` when it is missing from the schema.
  const companyParam = (opts.companyParam ? { company: z.string().max(120).optional().describe(opts.companyParam) } : {}) as {
    company: z.ZodOptional<z.ZodString>
  }

  server.registerTool(
    "search_brain",
    {
      title: "Search the company brain",
      description:
        "Searches the company's shared brain: decisions, procedures (deployment, closing, support…), facts about customers, " +
        "projects and tools, open tasks and questions, fed by the whole team's AI sessions, and the documents (PDF, Word, " +
        "Excel…) that back them (read one with get_document). Use it BEFORE guessing " +
        "whenever a question touches the company's context (\"how do we deploy?\", \"what did we decide for X?\", \"who handles customer Y?\"). " +
        "The last results can come from the knowledge graph: knowledge that cites the same customer, project or tool as the " +
        "best results, even without the query's words (each says which entity links it). " +
        "Each result says who wrote it, when, and from which tool and app. " +
        "Only the zones the user has access to are searched.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("The question as the user asked it, in their language (e.g. \"comment on déploie en prod ?\")."),
        phrasings: z.array(z.string().min(1).max(500)).max(4).optional().describe(PHRASINGS_GUIDANCE),
        zones: z.array(z.string()).max(20).optional().describe("Optional: limit to some zones (ids from list_zones, e.g. [\"dev\"])."),
        since: z.string().max(40).optional().describe("Optional: only knowledge dated from this day (ISO, e.g. \"2026-10-01\")."),
        until: z.string().max(40).optional().describe("Optional: only knowledge dated up to this day included (ISO)."),
        author: z.string().max(120).optional().describe("Optional: only knowledge written by this person (name or first name, e.g. \"Sarah\")."),
        detail: z
          .enum(["compact", "full"])
          .optional()
          .describe("compact (the default, unless the company chose otherwise): the 3 best results in full, the next ones in one line (get_knowledge reads them); full: every result in full."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (the company's number by default, 8 unless changed)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, phrasings, zones, since, until, author, detail, limit, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        const r = await c.api.query({ query, phrasings, zones: zones?.map((x) => resolveZone(c, x)), since, until, author, limit, agent: "mcp" })
        return formatQuery(r, namer(c), agentFormat(detail, r.format))
      }),
  )

  server.registerTool(
    "get_knowledge",
    {
      title: "Read knowledge by id",
      description:
        "Reads in full the knowledge items search_brain lists in one line (its \"Also relevant\" part), by their ids: the " +
        "text, who wrote it, when, its entities and documents. Only knowledge the user can read is returned.",
      inputSchema: { ids: z.array(z.string().min(1).max(64)).min(1).max(8).describe("Ids as given by search_brain."), ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ids, company }) =>
      guard(company, async (c) => {
        if (!c.api.item) return "This brain cannot read knowledge by id yet: update the server, or search_brain with detail \"full\"."
        await ensureZones(c)
        const found = await Promise.all(ids.map((id) => c.api.item!(id.trim()).then((r) => r.item).catch(() => null)))
        return formatKnowledge(found, ids, namer(c))
      }),
  )

  server.registerTool(
    "explore_entity",
    {
      title: "Explore a customer, project, tool or person",
      description:
        "Walks the company brain's knowledge graph from one entity (a customer, a project, a tool, a person or a document): " +
        "everything the team knows that cites it, and the entities most often cited with it, to explore further. Use it to " +
        "gather the whole context around a name (\"what do we know about Kalia Santé?\", \"everything about the CSR report\"). " +
        "Only the zones the user has access to are read.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("The entity's name, as the team writes it (e.g. \"Kalia Santé\", \"Supabase\")."),
        type: z.enum(ENTITY_TYPES).optional().describe("Optional: client, project, tool, person or doc, when a name has several (otherwise the most cited)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, type, company }) =>
      guard(company, async (c) => {
        if (!c.api.entity) return "This brain does not know explore_entity yet: update the server."
        await ensureZones(c)
        return formatEntity(await c.api.entity({ name: name.trim(), type }, "mcp"), name.trim(), namer(c))
      }),
  )

  server.registerTool(
    "get_document",
    {
      title: "Read a company document",
      description:
        "Reads a document kept in the company brain (PDF, Word, Excel, PowerPoint, CSV…): the quarterly revenue report behind " +
        "a figure, a price list, a contract template, a spec. search_brain and get_zone_summary give the documents' ids next " +
        "to the knowledge they back. Returns its full text and the knowledge it backs; only documents of the zones the user " +
        "can read are opened.",
      inputSchema: { id: z.string().min(1).max(64).describe("Id of the document, as given by search_brain or get_zone_summary."), ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, company }) =>
      guard(company, async (c) => {
        if (!c.api.document) return "This brain does not keep documents yet."
        await ensureZones(c)
        return formatDocument(await c.api.document(id.trim(), "mcp"), namer(c))
      }),
  )

  server.registerTool(
    "get_zone_summary",
    {
      title: "Zone summary",
      description:
        "Gives the state of one of the company's knowledge zones (dev, product, sales, finance…): summary, goals, next steps, " +
        "who did what, recent knowledge, open tasks and key entities. Useful to catch up on an area.",
      inputSchema: { zone: z.string().min(1).max(64).describe("Id or name of the zone (see list_zones), e.g. \"dev\"."), ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ zone, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatZoneSummary(await c.api.zone(resolveZone(c, zone)))
      }),
  )

  server.registerTool(
    "list_zones",
    {
      title: "List the zones",
      description: "Lists the company's knowledge zones (id, description, number of knowledge items) and shows those the user has access to.",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        const zones = await c.api.zones()
        keepZones(c, zones)
        return formatZones(zones)
      }),
  )

  server.registerTool(
    "whoami_context",
    {
      title: "My computer's context",
      description:
        "Describes the signed-in user's role: role, accessible zones, the zones and entities they use the most, frequent prompts, " +
        "recent decisions and procedures. Useful for a handover, a replacement, or to adapt an answer to the user's role.",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatWhoami(await c.api.whoami(), namer(c))
      }),
  )

  server.registerTool(
    "company_status",
    {
      title: "Where does the company stand?",
      description: "Summary of the company's state per zone: goals, progress, next steps and who did what (limited to accessible zones).",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatStatus(await c.api.status(), namer(c))
      }),
  )

  server.registerTool(
    "remember",
    {
      title: "Save to the brain",
      description:
        "Saves a reusable knowledge item to the company brain: a decision made (and why), a procedure that works, " +
        "a lasting fact about a customer/project/tool, a task to do or an open question. Use it when the user asks for it " +
        "or when an important decision has just been made. Never secrets or personal data (they are redacted anyway).",
      inputSchema: {
        title: z.string().min(3).max(200).describe("Short, precise title (≤ 120 characters)."),
        body: z.string().min(1).max(4000).describe("1 to 5 sentences a colleague can understand, with the why."),
        kind: z.enum(KNOWLEDGE_KINDS).describe("fact | decision | task | procedure | question"),
        zone: z.string().max(64).optional().describe("Optional: zone id; otherwise classified automatically (the answer gives the zone chosen)."),
        keywords: z
          .array(z.string().max(60))
          .max(16)
          .optional()
          .describe(
            "Recommended: 6 to 14 search terms a colleague might type to find it that the title and body do not contain: other " +
              "words for the same thing, the question it answers, the user's own words and the French for the key terms. " +
              "Never a fact or name that is not in the item.",
          ),
        ...companyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, body, kind, zone, keywords, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        const cache = cacheOf(c)
        const name = namer(c)
        const hints = zoneHints(cache)
        const zoneIds = new Set(hints.map((z) => z.id))
        const asked = zone ? resolveZone(c, zone) : undefined
        const classified = classifyZones(`${title} ${body}`, hints, 1)[0]
        const chosen = (asked && zoneIds.has(asked) ? asked : undefined) ?? classified ?? cache?.whoami?.writable[0] ?? hints[0]?.id ?? "general"
        const how =
          asked && chosen === asked
            ? "zone requested"
            : `zone chosen automatically from the content${asked ? ` ("${zone}" does not exist)` : ""}; give \`zone\` to choose another one`
        const clean = (t: string) => (opts.clean ?? ((x: string) => redactText(x)))(t).trim()
        const cleanTitle = truncate(clean(title), 140)
        const cleanBody = truncate(clean(body), 4000)
        const item: KnowledgeItemInput = {
          zone: chosen,
          kind,
          title: cleanTitle,
          body: cleanBody,
          entities: extractEntities(`${cleanTitle}\n${cleanBody}`),
          source: { app: opts.sourceApp ?? "claude-code", tool: "agent", at: new Date().toISOString() },
          confidence: 0.8,
          ...keywordsOf(keywords?.map(clean), cleanTitle),
        }
        const r = await c.api.ingest([item], "mcp")
        const where = r.zones[0] ?? chosen
        const label = `${name(where)} (\`${where}\`)`
        if (!r.inserted && r.skipped) {
          return `Already in the brain: a knowledge item with the same title and the same content already exists in the ${label} zone ("${cleanTitle}"). Nothing new was saved.`
        }
        const readable = cache?.zones?.find((z) => z.id === where)?.readable ?? cache?.whoami?.readable.includes(where)
        const readableIds = cache?.zones?.length ? cache.zones.filter((z) => z.readable).map((z) => z.id) : (cache?.whoami?.readable ?? [])
        const mine = readableIds.map(name).join(", ")
        const visibility =
          readable === false
            ? "Note: this zone is not one of your readable zones. Only the people who have access to it will see it; " +
              "since you saved it, you find it in your own searches and in \"My context\" (where you can delete it). " +
              `To file it elsewhere, call remember again with \`zone\`${mine ? ` (your zones: ${mine})` : ""}.`
            : "It can now be found by search_brain for the people who have access to this zone."
        return `Knowledge saved in the ${label} zone — ${how}${where !== chosen ? `; the brain filed it here rather than in "${name(chosen)}"` : ""}.\n"${cleanTitle}" (${kind}). ${visibility}`
      }),
  )

  server.registerTool(
    "connected_tools",
    {
      title: "Company connector tools",
      description:
        "Lists the tools of the company's apps connected to the brain (Notion, Linear, GitHub, Jira, Slack, Stripe…) that you can " +
        "use: search a page or an issue, read a document and, if the admin allowed it, create or update. Call it when a request " +
        "is about the content of these apps, then use_connected_tool. Filter by `connector` or `query`; argument schemas are " +
        "given when the list is filtered.",
      inputSchema: {
        connector: z.string().max(80).optional().describe("Optional: connector id or name (e.g. \"notion\", \"linear\")."),
        query: z.string().max(200).optional().describe("Optional: keyword in the tool's name or description (e.g. \"search\", \"issue\")."),
        ...companyParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ connector, query, company }) =>
      guard(company, async (c) => {
        if (!c.api.connectedTools) return "This brain does not offer connector tools yet."
        const r = await c.api.connectedTools({ connector, query })
        return formatConnectedTools(r, Boolean(connector || query) || r.connectors.reduce((n, x) => n + x.tools.length, 0) <= 15)
      }),
  )

  server.registerTool(
    "use_connected_tool",
    {
      title: "Use a connector tool",
      description:
        "Calls a tool of one of the company's connectors (listed by connected_tools) with the account the admin connected, and " +
        "returns its answer. Tools that change data only go through if the admin opened them to agents.",
      inputSchema: {
        connector: z.string().min(1).max(80).describe("Connector id, as given by connected_tools (e.g. \"notion\")."),
        tool: z.string().min(1).max(200).describe("Exact tool name (e.g. \"search\")."),
        arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, following its schema (JSON object)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ connector, tool, arguments: args, company }) => {
      try {
        const c = open(company)
        if (!c.api.callConnectedTool) return fail("This brain does not offer connector tools yet.")
        const r = await c.api.callConnectedTool({ connector, tool, arguments: args ?? {} })
        const text = c.header + (opts.clean ?? ((x: string) => x))(r.text)
        return r.is_error ? fail(text) : ok(text)
      } catch (err) {
        return fail(`Company brain error: ${(err as Error).message}`)
      }
    },
  )

  return server
}
