// Logique métier du cerveau : ingestion, requêtes des agents, événements (néons), état, automatisations.

import {
  DEFAULT_TIMEZONE,
  classifyZones,
  detectAutomations,
  heuristicStatus,
  promptFingerprint,
  redactText,
  truncate,
  type AgentEvent,
  type AgentEventInput,
  type AgentName,
  type KnowledgeItem,
  type KnowledgeItemInput,
  type Zone,
} from "@brain/core"
import { summarizeStatus } from "@brain/core/claude"
import { getStore } from "./store"
import { canRead, redactEvent } from "./access"
import type { Viewer } from "./auth"
import { getClaude } from "./ai"

const store = () => getStore()

function clampDate(at: string | undefined): string {
  const now = Date.now()
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t) || t > now + 60_000) return new Date(now).toISOString()
  return new Date(t).toISOString()
}

function resolveZone(zone: string, text: string, zones: Zone[]): string {
  if (zones.some((z) => z.id === zone)) return zone
  return classifyZones(text, zones, 1)[0] ?? zones[0]?.id ?? zone
}

/** POST /api/ingest — les connaissances distillées sur le poste entrent dans le cerveau. */
export async function ingestItems(viewer: Viewer, items: KnowledgeItemInput[], agent: AgentName = "brain-sync") {
  const zones = await store().listZones()
  const authorId = viewer.real.id
  const prepared = items.map((i) => {
    // Défense en profondeur : on re-masque côté serveur même si le poste l'a déjà fait.
    const title = redactText(i.title)
    const body = redactText(i.body)
    return {
      ...i,
      title,
      body,
      zone: resolveZone(i.zone, `${title} ${body}`, zones),
      source: { ...i.source, at: clampDate(i.source.at) },
      author_id: authorId,
    }
  })
  const inserted = await store().insertItems(prepared)
  const tasks = inserted
    .filter((i) => i.kind === "task")
    .map((i) => ({ title: i.title, zone: i.zone, status: "open" as const, assignee_id: authorId, source_item_id: i.id }))
  if (tasks.length) await store().createTasks(tasks)
  const touched = [...new Set(inserted.map((i) => i.zone))]
  await store().insertEvents([
    {
      user_id: authorId,
      agent,
      type: "write",
      zones: touched,
      summary: `${inserted.length} connaissance${inserted.length > 1 ? "s" : ""} ajoutée${inserted.length > 1 ? "s" : ""} : ${truncate(inserted[0]?.title ?? "", 80)}`,
      at: new Date().toISOString(),
    },
  ])
  return { inserted: inserted.length, ids: inserted.map((i) => i.id), zones: touched }
}

/** POST /api/events — hooks Claude Code, MCP, brain-sync. */
export async function recordEvents(viewer: Viewer, inputs: AgentEventInput[]) {
  const zones = await store().listZones()
  const known = new Set(zones.map((z) => z.id))
  const events = inputs.map((e) => {
    const summary = e.summary ? truncate(redactText(e.summary), 200) : undefined
    let eventZones = (e.zones ?? []).filter((z) => known.has(z))
    if (eventZones.length === 0 && summary && e.type !== "started" && e.type !== "stopped") eventZones = classifyZones(summary, zones, 2)
    return {
      user_id: viewer.real.id,
      agent: e.agent,
      type: e.type,
      zones: eventZones,
      summary,
      fingerprint: e.fingerprint,
      session_id: e.session_id,
      at: clampDate(e.at),
    }
  })
  return store().insertEvents(events)
}

/** POST /api/query — un agent cherche du contexte. La zone trouvée s'allume. */
export async function queryBrain(viewer: Viewer, input: { query: string; zones?: string[]; limit?: number; agent?: AgentName }) {
  const allZones = await store().listZones()
  const readable = viewer.access.readable
  const searched = input.zones?.length ? input.zones.filter((z) => readable.includes(z)) : readable
  const results = await store().searchItems(input.query, searched, input.limit ?? 8)
  let hit = [...new Set(results.slice(0, 3).map((r) => r.zone))]
  if (hit.length === 0) hit = classifyZones(input.query, allZones, 2).filter((z) => readable.includes(z))
  const restricted = classifyZones(input.query, allZones, 2).filter((z) => !readable.includes(z))
  await store().insertEvents([
    {
      user_id: viewer.real.id,
      agent: input.agent ?? "mcp",
      type: "query",
      zones: hit,
      summary: truncate(redactText(input.query), 200),
      at: new Date().toISOString(),
    },
  ])
  const names = new Map((await store().listProfiles()).map((p) => [p.id, p.name]))
  return {
    query: input.query,
    zones_searched: searched,
    zones_hit: hit,
    /** Zones qui auraient pu répondre mais que l'utilisateur ne peut pas lire (on ne dit rien de leur contenu). */
    zones_restricted: restricted,
    items: results.map((r) => ({ ...r, author: names.get(r.author_id) ?? "?" })),
  }
}

export type ZoneView = Zone & {
  count: number
  last_at: string | null
  contributors: number
  locked: boolean
  entities: { name: string; type: string; count: number }[]
}

/** GET /api/state — instantané du dashboard, filtré selon les droits du spectateur. */
export async function getState(viewer: Viewer) {
  const s = store()
  const [org, zones, stats, profiles, events, status, automations, entities] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.zoneStats(),
    s.listProfiles(),
    s.listEvents({ limit: 60 }),
    s.getStatus(),
    s.listAutomations(),
    s.topEntities({ limit: 250 }),
  ])
  const { access, profile } = viewer
  const readable = access.readable
  const [tasks, recentItems] = await Promise.all([s.listTasks({ zones: readable }), s.listItems({ zones: readable, limit: 30 })])
  const statsBy = new Map(stats.map((x) => [x.zone, x]))

  const zoneViews: ZoneView[] = zones.map((z) => {
    const st = statsBy.get(z.id)
    const locked = !canRead(access, z.id)
    return {
      ...z,
      count: st?.count ?? 0,
      last_at: st?.last_at ?? null,
      contributors: st?.contributors ?? 0,
      locked,
      entities: locked
        ? []
        : entities
            .filter((e) => e.zones.includes(z.id))
            .slice(0, 8)
            .map((e) => ({ name: e.name, type: e.type, count: e.count })),
    }
  })

  // Synapses : deux zones partagent des entités (même client, même outil, même projet…).
  const pairs = new Map<string, { a: string; b: string; weight: number; via: string[] }>()
  for (const e of entities) {
    const zs = [...e.zones].sort()
    for (let i = 0; i < zs.length; i++)
      for (let j = i + 1; j < zs.length; j++) {
        const key = `${zs[i]}|${zs[j]}`
        const p = pairs.get(key) ?? { a: zs[i], b: zs[j], weight: 0, via: [] }
        p.weight += e.count
        if (p.via.length < 3) p.via.push(e.name)
        pairs.set(key, p)
      }
  }
  const synapses = [...pairs.values()].map((p) =>
    canRead(access, p.a) && canRead(access, p.b) ? p : { ...p, via: [] as string[] },
  )

  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]))
  const since24h = Date.now() - 86400_000
  const activeUsers = new Set(events.filter((e) => Date.parse(e.at) > since24h).map((e) => e.user_id))

  return {
    org,
    me: { ...profile, access },
    real: viewer.real,
    impersonating: viewer.real.id !== profile.id,
    people: profiles.map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role })),
    names,
    zones: zoneViews,
    synapses,
    events: events.map((e) => redactEvent(e, access, profile.id)),
    status: status ? { ...status, zones: status.zones.filter((z) => canRead(access, z.zone)) } : null,
    automations: automations.filter((a) => access.isAdmin || a.user_id === profile.id),
    tasks: tasks.slice(0, 40),
    items: recentItems,
    totals: {
      items: stats.reduce((n, x) => n + x.count, 0),
      contributors: new Set(profiles.map((p) => p.id)).size,
      active_24h: activeUsers.size,
    },
    claude: Boolean(getClaude()),
  }
}

export type DashboardState = Awaited<ReturnType<typeof getState>>

/** Régénère l'écran « où en est la boîte » (Claude si dispo, sinon heuristique). */
export async function refreshStatus(viewer: Viewer) {
  const s = store()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const [zones, items, tasks, profiles, org] = await Promise.all([
    s.listZones(),
    s.listItems({ sinceIso: since, limit: 600 }),
    s.listTasks({}),
    s.listProfiles(),
    s.getOrg(),
  ])
  await s.insertEvents([
    {
      user_id: viewer.real.id,
      agent: "job",
      type: "query",
      zones: zones.map((z) => z.id),
      summary: "Mise à jour de l'état de l'entreprise",
      at: new Date().toISOString(),
    },
  ])
  const claude = getClaude()
  const status =
    (claude && (await summarizeStatus(claude, { zones, items, tasks, profiles, companyName: org.name }))) ||
    heuristicStatus({ zones, items, tasks, profiles })
  await s.setStatus(status)
  return status
}

/** Détecte les tâches répétitives et met à jour les suggestions d'automatisation. */
export async function runAutomationDetection() {
  const s = store()
  const since = new Date(Date.now() - 21 * 86400_000).toISOString()
  const [events, profiles] = await Promise.all([s.listEvents({ sinceIso: since, type: "query", limit: 20000 }), s.listProfiles()])
  const candidates = detectAutomations(events, profiles, { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE })
  return candidates.length ? s.upsertAutomations(candidates) : []
}

/** Contexte d'un poste (passation) : zones, entités et sujets les plus utilisés par une personne. */
export async function getPersonContext(viewer: Viewer, personId: string) {
  const s = store()
  const person = await s.getProfile(personId)
  if (!person) return null
  const readable = viewer.access.readable
  const [items, entities, events] = await Promise.all([
    s.listItems({ authorId: personId, zones: readable, limit: 200 }),
    s.topEntities({ authorId: personId, zones: readable, limit: 15 }),
    s.listEvents({ userId: personId, limit: 500 }),
  ])
  const zoneCounts = new Map<string, number>()
  for (const i of items) zoneCounts.set(i.zone, (zoneCounts.get(i.zone) ?? 0) + 1)
  for (const e of events) for (const z of e.zones) if (readable.includes(z)) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 0.5)
  const prompts = new Map<string, { summary: string; count: number; last: string }>()
  for (const e of events) {
    // Les prompts saisis par la personne (hooks), pas les recherches faites par ses agents.
    if (e.type !== "query" || (e.agent !== "claude-code" && e.agent !== "codex")) continue
    if (!e.summary || !e.zones.some((z) => readable.includes(z))) continue
    const key = e.fingerprint || promptFingerprint(e.summary)
    const p = prompts.get(key) ?? { summary: e.summary, count: 0, last: e.at }
    p.count++
    if (e.at > p.last) p.last = e.at
    prompts.set(key, p)
  }
  return {
    person,
    zones: [...zoneCounts.entries()].sort((a, b) => b[1] - a[1]).map(([zone, weight]) => ({ zone, weight: Math.round(weight) })),
    entities,
    frequent_prompts: [...prompts.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    items: items.slice(0, 40),
    decisions: items.filter((i) => i.kind === "decision").slice(0, 10),
    procedures: items.filter((i) => i.kind === "procedure").slice(0, 10),
  }
}

export function visibleEvent(viewer: Viewer, e: AgentEvent) {
  return redactEvent(e, viewer.access, viewer.profile.id)
}

export function itemAuthorOrAdmin(viewer: Viewer, item: KnowledgeItem): boolean {
  return viewer.real.role === "admin" || item.author_id === viewer.real.id
}
