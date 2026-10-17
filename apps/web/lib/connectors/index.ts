// Connecteurs : Notion, Linear, Todoist et un calendrier ICS. Les réglages (jeton, zone) sont dans les réglages de
// l'entreprise (clé `connectors`, lus et écrits par l'API seulement). Chaque synchro importe dans le cerveau au nom de
// l'admin qui a branché l'outil, dans la zone choisie (ou classée automatiquement), puis note son résultat.
// Les appels réseau vont vers des hôtes fixes (Notion, Linear, Todoist) ; l'adresse du calendrier, fournie par
// l'utilisateur, passe par le récupérateur protégé contre le SSRF de l'onboarding.

import {
  CONNECTOR_IDS,
  calendarEventToItem,
  calendarWindow,
  classifyZones,
  connectorDue,
  linearIssueToTask,
  notionBlocksToText,
  notionPageToItem,
  parseIcs,
  publicConnector,
  todoistTaskToTask,
  truncate,
  type ConnectorConfig,
  type ConnectorId,
  type ConnectorPublic,
  type ConnectorRun,
  type ConnectorsConfig,
  type ExternalTask,
  type KnowledgeItemInput,
  type Zone,
} from "@brain/core"
import { ingestItems } from "../brain"
import type { Viewer } from "../auth"
import { recordIncident, sendAlert } from "../monitoring"
import { scrapeUrl } from "../scrape"
import { getStore } from "../store"
import type { NewTask } from "../store/types"

const SETTING = "connectors"
const TIMEOUT_MS = 20_000
/** Pages Notion relues par synchro (les plus récemment modifiées d'abord). */
const NOTION_PAGES = 40
const LINEAR_ISSUES = 100
const ICS_MAX_CHARS = 2_000_000

export async function loadConnectors(): Promise<ConnectorsConfig> {
  const raw = await getStore().getOrgSetting(SETTING)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as ConnectorsConfig
    return typeof parsed === "object" && parsed ? parsed : {}
  } catch {
    return {}
  }
}

async function saveConnectors(cfg: ConnectorsConfig) {
  await getStore().setOrgSetting(SETTING, JSON.stringify(cfg))
}

export async function listConnectors(): Promise<ConnectorPublic[]> {
  const cfg = await loadConnectors()
  return CONNECTOR_IDS.map((id) => publicConnector(id, cfg[id]))
}

export type ConnectorPatch = { token?: string; url?: string; zone?: string | null; enabled?: boolean }

/** Met à jour les réglages d'un connecteur ; un jeton vide garde le jeton enregistré. */
export async function updateConnector(id: ConnectorId, patch: ConnectorPatch): Promise<ConnectorPublic> {
  const cfg = await loadConnectors()
  const prev: ConnectorConfig = cfg[id] ?? { enabled: true }
  const next: ConnectorConfig = { ...prev }
  if (patch.token !== undefined && patch.token.trim()) next.token = patch.token.trim()
  if (patch.url !== undefined) next.url = patch.url.trim() || undefined
  if (patch.zone !== undefined) next.zone = patch.zone || undefined
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  cfg[id] = next
  await saveConnectors(cfg)
  return publicConnector(id, next)
}

export async function removeConnector(id: ConnectorId): Promise<void> {
  const cfg = await loadConnectors()
  delete cfg[id]
  await saveConnectors(cfg)
}

/** Zone d'un contenu importé : celle du connecteur si réglée, sinon classement par mots-clés, sinon la première zone. */
function zoneFor(text: string, zones: Zone[], fixed: string | undefined): string {
  if (fixed && zones.some((z) => z.id === fixed)) return fixed
  return classifyZones(text, zones, 1)[0] ?? zones[0]?.id ?? "general"
}

async function getJson<T>(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)
    if (res.status === 401 || res.status === 403) throw new Error(`jeton refusé (${res.status})`)
    throw new Error(`HTTP ${res.status}${text ? ` : ${text}` : ""}`)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------------------------------------------------

async function fetchNotion(c: ConnectorConfig, zones: Zone[]): Promise<KnowledgeItemInput[]> {
  const headers = { authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "content-type": "application/json" }
  type Page = { id: string; url?: string; last_edited_time?: string; properties?: Record<string, { type?: string; title?: unknown }> }
  const search = await getJson<{ results?: (Page & { object?: string })[] }>("https://api.notion.com/v1/search", headers, {
    method: "POST",
    body: JSON.stringify({ filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: NOTION_PAGES }),
  })
  const items: KnowledgeItemInput[] = []
  for (const page of (search.results ?? []).filter((p) => p.object === "page")) {
    const blocks = await getJson<{ results?: Record<string, unknown>[] }>(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, headers)
    const text = notionBlocksToText((blocks.results ?? []) as { type?: string }[])
    const item = notionPageToItem(page, text, "")
    if (item) items.push({ ...item, zone: zoneFor(`${item.title} ${item.body}`, zones, c.zone) })
  }
  return items
}

async function fetchCalendar(c: ConnectorConfig, zones: Zone[]): Promise<KnowledgeItemInput[]> {
  const page = await scrapeUrl(c.url ?? "", { maxChars: ICS_MAX_CHARS })
  if (page.error) throw new Error(page.error)
  if (!/BEGIN:VCALENDAR/i.test(page.text)) throw new Error("ce n'est pas un flux iCalendar (BEGIN:VCALENDAR absent)")
  return calendarWindow(parseIcs(page.text)).map((ev) => {
    const item = calendarEventToItem(ev, "")
    return { ...item, zone: zoneFor(`${ev.summary} ${ev.description}`, zones, c.zone) }
  })
}

async function fetchLinear(c: ConnectorConfig): Promise<ExternalTask[]> {
  const query = `query { issues(first: ${LINEAR_ISSUES}, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { id identifier title url description state { name type } team { name } project { name } labels { nodes { name } } } } }`
  const data = await getJson<{ data?: { issues?: { nodes?: Parameters<typeof linearIssueToTask>[0][] } }; errors?: { message: string }[] }>("https://api.linear.app/graphql", { authorization: c.token ?? "", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ query }) })
  if (data.errors?.length) throw new Error(data.errors[0].message)
  return (data.data?.issues?.nodes ?? []).map(linearIssueToTask)
}

async function fetchTodoist(c: ConnectorConfig): Promise<ExternalTask[]> {
  const headers = { authorization: `Bearer ${c.token}` }
  const [tasks, projects] = await Promise.all([
    getJson<Parameters<typeof todoistTaskToTask>[0][]>("https://api.todoist.com/rest/v2/tasks", headers),
    getJson<{ id: string; name: string }[]>("https://api.todoist.com/rest/v2/projects", headers).catch(() => [] as { id: string; name: string }[]),
  ])
  const names = new Map(projects.map((p) => [p.id, p.name]))
  return tasks.map((t) => todoistTaskToTask(t, t.project_id ? names.get(t.project_id) : undefined))
}

// ---------------------------------------------------------------------------------------------------------------------

export type RunResult = ConnectorRun & { id: ConnectorId }

/**
 * Lance la synchro d'un connecteur au nom de `viewer` (l'admin qui l'a branché ou qui clique) : importe, note le
 * résultat dans les réglages, prévient par webhook en cas d'échec. Ne lève pas : le résultat dit si ça a marché.
 */
export async function runConnector(viewer: Viewer, id: ConnectorId): Promise<RunResult> {
  const started = Date.now()
  const cfg = await loadConnectors()
  const c = cfg[id]
  const finish = async (run: ConnectorRun) => {
    const latest = await loadConnectors()
    latest[id] = { ...(latest[id] ?? c ?? { enabled: true }), last_run: run }
    await saveConnectors(latest)
    return { id, ...run }
  }
  if (!publicConnector(id, c).configured || !c) return finish({ at: new Date().toISOString(), ok: false, imported: 0, error: "connecteur non configuré", duration_ms: 0 })
  try {
    const store = getStore()
    const zones = await store.listZones()
    let imported = 0
    if (id === "notion" || id === "calendar") {
      const items = id === "notion" ? await fetchNotion(c, zones) : await fetchCalendar(c, zones)
      if (items.length) imported = (await ingestItems(viewer, items, "job")).inserted
    } else {
      const tasks = id === "linear" ? await fetchLinear(c) : await fetchTodoist(c)
      const rows: NewTask[] = tasks.map((t) => ({
        title: t.title,
        zone: zoneFor(t.zone_hint, zones, c.zone),
        status: t.status,
        external_id: t.external_id,
        external_url: t.external_url,
        external_source: t.external_source,
      }))
      imported = (await store.upsertExternalTasks(id, rows)).length
    }
    return finish({ at: new Date().toISOString(), ok: true, imported, duration_ms: Date.now() - started })
  } catch (err) {
    const message = truncate((err instanceof Error ? err.message : String(err)).replace(/\s+/g, " "), 300)
    recordIncident(`connector:${id}`, err)
    void sendAlert(`connector:${id}`, `Connecteur ${id} en échec : ${message}`)
    return finish({ at: new Date().toISOString(), ok: false, imported: 0, error: message, duration_ms: Date.now() - started })
  }
}

const running = new Set<string>()

/**
 * Synchros automatiques : appelé en arrière-plan quand un admin consulte l'état (GET /api/state) ; chaque connecteur
 * actif tourne au plus une fois par heure, une seule exécution à la fois par entreprise et par connecteur.
 */
export async function runDueConnectors(viewer: Viewer): Promise<void> {
  if (viewer.real.role !== "admin") return
  const cfg = await loadConnectors()
  for (const id of CONNECTOR_IDS) {
    const key = `${viewer.real.org_id}:${id}`
    if (!connectorDue(cfg[id]) || running.has(key)) continue
    running.add(key)
    try {
      await runConnector(viewer, id)
    } finally {
      running.delete(key)
    }
  }
}
