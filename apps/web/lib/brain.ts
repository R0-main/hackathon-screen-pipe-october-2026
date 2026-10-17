// The brain's business logic: ingestion, agent queries, events (neons), state, automations.

import {
  DEFAULT_TIMEZONE,
  STATUS_MAX_ITEMS,
  STATUS_WINDOW_DAYS,
  buildStatusInput,
  classifyZones,
  detectAutomations,
  expandQuery,
  heuristicStatus,
  likeness,
  looksPersonal,
  matchStrength,
  normalize,
  promptFingerprint,
  redactText,
  rrf,
  scoreZones,
  strongEnough,
  truncate,
  type AgentEvent,
  type AgentEventInput,
  type AgentName,
  type CompanyStatus,
  type KnowledgeItem,
  type KnowledgeItemInput,
  type Profile,
  type ScoredItem,
  type StatusInput,
  type Zone,
  type ZoneStatus,
} from "@brain/core"
import { summarizeStatus } from "@brain/core/claude"
import { getStore, isStoreSetupError } from "./store"
import type { AuthorZoneStat, NewItem } from "./store/types"
import { canRead, canSeeEventContent, redactEvent } from "./access"
import type { Viewer } from "./auth"
import { getClaude } from "./ai"
import { claudeKeyInfo } from "./claude-key"
import { embedDocuments, embedQuery, embeddingText, getEmbeddings, rankBySimilarity } from "./embeddings"
import { canPublishSkills, canSeeSkill } from "./skills"

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

/** Deduplication window at ingestion (same author, same zone, same normalized title and content). */
const DEDUPE_DAYS = 30
/** Window for matching against knowledge already in place (near-duplicates, replacements), all people included. */
const LIKENESS_DAYS = 90
const LIKENESS_MAX_ITEMS = 400

const dedupeText = (s: string) => normalize(s).replace(/\s+/g, " ").trim()

/**
 * An identical title is not enough: the same window (conversation title) produces several successive facts.
 * Only an identical item (title AND content, after redaction) is a duplicate.
 */
function dedupeKey(zone: string, title: string, body: string): string {
  return JSON.stringify([zone, dedupeText(title), dedupeText(body)])
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * POST /api/ingest — the knowledge distilled on the workstation enters the brain.
 * Everyone feeds the brain: any existing zone is accepted (only reading is restricted),
 * the author always keeps control over their items (getPersonContext, queryBrain, deletion).
 * Idempotent: an item already received from this same author, in the same zone, with the same title and the same content
 * (normalized) within 30 days is ignored.
 */
export async function ingestItems(viewer: Viewer, items: KnowledgeItemInput[], agent: AgentName = "brain-sync") {
  const zones = await store().listZones()
  const authorId = viewer.real.id
  const since = new Date(Date.now() - DEDUPE_DAYS * 86400_000).toISOString()
  const seen = new Set((await store().listItems({ authorId, sinceIso: since, limit: 100_000 })).map((i) => dedupeKey(i.zone, i.title, i.body)))
  // Recent knowledge in the zone (all people): a near-duplicate is dropped, a more recent version of the
  // same subject (revised decision, updated procedure) replaces the old one.
  const recent = await store().listItems({ sinceIso: new Date(Date.now() - LIKENESS_DAYS * 86400_000).toISOString(), limit: LIKENESS_MAX_ITEMS, excludeSuperseded: true })
  const prepared: NewItem[] = []
  const supersedes: { index: number; oldId: string }[] = []
  let skipped = 0
  let replaced = 0
  for (const i of items) {
    // Defense in depth: redact again on the server even if the workstation already did it.
    const title = redactText(i.title)
    const body = redactText(i.body)
    const zone = resolveZone(i.zone, `${title} ${body}`, zones)
    const key = dedupeKey(zone, title, body)
    if (seen.has(key)) {
      skipped++
      continue
    }
    const candidate = { kind: i.kind, title, body, entities: i.entities }
    let old: string | null = null
    let duplicate = false
    for (const r of recent) {
      if (r.zone !== zone) continue
      const rel = likeness(candidate, r)
      if (rel === "duplicate") {
        duplicate = true
        break
      }
      if (rel === "supersedes" && !old && r.created_at < clampDate(i.source.at)) old = r.id
    }
    if (duplicate) {
      skipped++
      continue
    }
    seen.add(key)
    if (old) supersedes.push({ index: prepared.length, oldId: old })
    prepared.push({ ...i, title, body, zone, source: { ...i.source, at: clampDate(i.source.at) }, author_id: authorId })
  }
  // Semantic vectors (if a provider is configured): a provider outage never prevents ingestion.
  const provider = getEmbeddings()
  if (provider && prepared.length) {
    try {
      const vectors = await embedDocuments(prepared.map(embeddingText))
      if (vectors) prepared.forEach((p, n) => Object.assign(p, { embedding: vectors[n], embedding_model: provider.model }))
    } catch (err) {
      console.error("[embeddings] ingestion without vectors:", err instanceof Error ? err.message : err)
    }
  }
  const inserted = prepared.length ? await store().insertItems(prepared) : []
  for (const s of supersedes) {
    const next = inserted[s.index]
    if (!next) continue
    await store().markSuperseded(s.oldId, next.id)
    replaced++
  }
  const tasks = inserted
    .filter((i) => i.kind === "task")
    .map((i) => ({ title: i.title, zone: i.zone, status: "open" as const, assignee_id: authorId, source_item_id: i.id }))
  if (tasks.length) await store().createTasks(tasks)
  // One write event PER zone, whose summary only cites items of that zone.
  const touched = [...new Set(inserted.map((i) => i.zone))]
  const at = new Date().toISOString()
  if (touched.length)
    await store().insertEvents(
      touched.map((zone) => {
        const list = inserted.filter((i) => i.zone === zone)
        return {
          user_id: authorId,
          agent,
          type: "write" as const,
          zones: [zone],
          summary: `${plural(list.length, "item")} added: ${truncate(list[0].title, 80)}`,
          at,
        }
      }),
    )
  return { inserted: inserted.length, skipped, replaced, ids: inserted.map((i) => i.id), zones: touched }
}

/** Agents that send the prompts typed by the employee (UserPromptSubmit hooks). */
const PROMPT_AGENTS = new Set<AgentName>(["claude-code", "codex"])

/** POST /api/events — hooks Claude Code, MCP, brain-sync. */
export async function recordEvents(viewer: Viewer, inputs: AgentEventInput[]) {
  const zones = await store().listZones()
  const known = new Set(zones.map((z) => z.id))
  const events = inputs.map((e) => {
    let summary = e.summary ? truncate(redactText(e.summary), 200) : undefined
    let eventZones = [...new Set((e.zones ?? []).filter((z) => known.has(z)))]
    if (eventZones.length === 0 && summary && e.type !== "started" && e.type !== "stopped") eventZones = classifyZones(summary, zones, 2)
    // Typed prompt: its summary is only kept if it relates to a zone and has nothing personal (otherwise the fingerprint alone).
    if (summary && e.type === "query" && PROMPT_AGENTS.has(e.agent) && (eventZones.length === 0 || looksPersonal(summary))) summary = undefined
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

/**
 * Zones a text talks about: its classification (all retained zones, not only the first 2), plus any
 * zone one of whose keywords is quoted as is.
 */
function zonesMentioned(text: string, zones: Zone[]): string[] {
  const out = new Set(classifyZones(text, zones, zones.length))
  for (const s of scoreZones(text, zones)) if (s.score >= 1) out.add(s.zone)
  return [...out]
}

/** POST /api/query — an agent looks for context. The zone found lights up. */
export async function queryBrain(viewer: Viewer, input: { query: string; zones?: string[]; limit?: number; agent?: AgentName }) {
  const allZones = await store().listZones()
  const readable = viewer.access.readable
  const filter = input.zones?.length ? input.zones : null
  const searched = filter ? filter.filter((z) => readable.includes(z)) : readable
  // Readable zones + the user's own items, even filed in a zone they don't read (right of review).
  const results = (await hybridSearch(input.query, searched, input.limit ?? 8, viewer.profile.id)).filter((r) => !filter || filter.includes(r.zone))
  // Only readable zones light up: a search is never broadcast into a zone you don't read.
  let hit = [...new Set(results.filter((r) => readable.includes(r.zone)).slice(0, 3).map((r) => r.zone))]
  if (hit.length === 0) hit = classifyZones(input.query, allZones, 2).filter((z) => readable.includes(z))
  const restricted = classifyZones(input.query, allZones, 2).filter((z) => !readable.includes(z) && !hit.includes(z))
  // The search text is only kept (and shown to readers of the lit zones) if it touches no zone
  // the user doesn't read (classification, requested filter, their own items found) and has nothing personal.
  const asked = (input.zones ?? []).filter((z) => allZones.some((x) => x.id === z))
  const touched = [...zonesMentioned(input.query, allZones), ...asked, ...results.map((r) => r.zone)]
  const touchesUnreadable = touched.some((z) => !canRead(viewer.access, z))
  const keepSummary = !touchesUnreadable && !looksPersonal(input.query)
  // With its text, the event carries all the zones the search touches (not only the results'):
  // D2 then only shows the text to readers of ALL those zones.
  const eventZones = keepSummary ? [...new Set([...hit, ...touched])] : hit
  await store().insertEvents([
    {
      user_id: viewer.real.id,
      agent: input.agent ?? "mcp",
      type: "query",
      zones: eventZones,
      summary: keepSummary ? truncate(redactText(input.query), 200) : undefined,
      at: new Date().toISOString(),
    },
  ])
  const names = new Map((await store().listProfiles()).map((p) => [p.id, p.name]))
  return {
    query: input.query,
    zones_searched: searched,
    zones_hit: hit,
    /** Zones that could have answered but that the user cannot read (nothing is said about their content). */
    zones_restricted: restricted,
    items: results.map((r) => ({ ...r, author: names.get(r.author_id) ?? "?" })),
  }
}

/** Lexical and semantic candidates re-read before fusion, relative to the requested limit. */
const HYBRID_FACTOR = 4

/**
 * Hybrid search: the query is expanded to its synonyms (lexical), then, if an embeddings provider is
 * configured, the semantically closest items are added; the two rankings are fused
 * (RRF). Without a provider: lexical with synonyms. The score returned is the fusion's (or lexical alone).
 */
export async function hybridSearch(query: string, zones: string[], limit: number, authorId?: string): Promise<ScoredItem[]> {
  const s = store()
  const { tokens, added } = expandQuery(query)
  const want = Math.max(limit * HYBRID_FACTOR, 20)
  const all = [...tokens, ...added]
  const [lexical, expandedRaw, qvec] = await Promise.all([
    s.searchItems(query, zones, want, { authorId }),
    added.length ? s.searchItems(all.join(" "), zones, want, { authorId }) : Promise.resolve([] as ScoredItem[]),
    embedQuery(query),
  ])
  // A result only synonyms bring back must rest on more than one isolated word of the body ("prod" ≠ "product"):
  // finance must see nothing come up for "deploy to production".
  const lexicalIds = new Set(lexical.map((r) => r.id))
  const expanded = expandedRaw.filter((r) => lexicalIds.has(r.id) || strongEnough(matchStrength(all, r)))
  const byId = new Map<string, ScoredItem>()
  for (const r of [...lexical, ...expanded]) if (!byId.has(r.id)) byId.set(r.id, r)
  const lists: string[][] = [lexical.map((r) => r.id)]
  if (expanded.length) lists.push(expanded.map((r) => r.id))
  if (qvec) {
    const close = rankBySimilarity(qvec, await s.listEmbeddings({ zones, authorId }), { limit: want })
    if (close.length) {
      lists.push(close.map((c) => c.id))
      const missing = close.filter((c) => !byId.has(c.id))
      const fetched = await Promise.all(missing.map((c) => s.getItem(c.id)))
      for (const it of fetched) if (it && !it.superseded_by) byId.set(it.id, { ...it, score: 0 })
    }
  }
  if (lists.length === 1) return lexical.slice(0, limit)
  return rrf(lists)
    .map(({ id, score }) => {
      const it = byId.get(id)
      return it ? { ...it, score: Math.round(score * 1000) / 10 } : null
    })
    .filter((x): x is ScoredItem => x !== null)
    .slice(0, limit)
}

/** Entities (clients, projects, tools…) most cited in the viewer's readable zones. */
export async function listEntitiesFor(viewer: Viewer, limit = 200) {
  return store().topEntities({ zones: viewer.access.readable, limit })
}

/** Everything about an entity: the readable knowledge that cites it, and the entities cited with it. */
export async function getEntityContext(viewer: Viewer, type: string, name: string) {
  const s = store()
  const normName = normalize(name)
  const items = await s.listItemsByEntity({ type, normName, zones: viewer.access.readable, authorId: viewer.profile.id, limit: 100 })
  if (items.length === 0) return null
  const related = new Map<string, { type: string; name: string; count: number }>()
  for (const it of items)
    for (const e of it.entities) {
      if (e.type === type && normalize(e.name) === normName) continue
      const key = `${e.type}:${normalize(e.name)}`
      const r = related.get(key) ?? { type: e.type, name: e.name, count: 0 }
      r.count++
      related.set(key, r)
    }
  const names = new Map((await s.listProfiles()).map((p) => [p.id, p.name]))
  const display = items.flatMap((i) => i.entities).find((e) => e.type === type && normalize(e.name) === normName)?.name ?? name
  return {
    type,
    name: display,
    items,
    zones: [...new Set(items.map((i) => i.zone))],
    related: [...related.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    names: Object.fromEntries(items.map((i) => [i.author_id, names.get(i.author_id) ?? "?"])),
  }
}

export type ZoneView = Zone & {
  count: number
  last_at: string | null
  contributors: number
  locked: boolean
  entities: { name: string; type: string; count: number }[]
}

/**
 * Zone where a person works the most: their knowledge, then their recent events (which count double, it is
 * what they are doing right now). Without any trace, their job title attaches them to a zone; otherwise null.
 */
function homeZone(p: Profile, zones: Zone[], authorStats: AuthorZoneStat[], events: AgentEvent[]): string | null {
  const known = new Set(zones.map((z) => z.id))
  const weight = new Map<string, number>()
  const add = (zone: string, w: number) => known.has(zone) && weight.set(zone, (weight.get(zone) ?? 0) + w)
  for (const st of authorStats) if (st.author_id === p.id) add(st.zone, st.count)
  for (const e of events) if (e.user_id === p.id) for (const z of e.zones) add(z, 2)
  const best = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  if (best) return best[0]
  return p.title ? (classifyZones(p.title, zones, 1)[0] ?? null) : null
}

/** GET /api/state — dashboard snapshot, filtered by the viewer's permissions. */
export async function getState(viewer: Viewer) {
  const s = store()
  const [org, zones, stats, authorStats, profiles, events, status, automations, entities, skills] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.zoneStats(),
    s.authorZoneStats(),
    s.listProfiles(),
    s.listEvents({ limit: 60 }),
    s.getStatus(),
    s.listAutomations(),
    s.topEntities({ limit: 250 }),
    // Database not migrated yet (skills table missing): the brain stays usable, without skills.
    s.listSkills().catch((err) => {
      if (!isStoreSetupError(err)) throw err
      console.error("[skills]", err.message)
      return []
    }),
  ])
  const { access, profile } = viewer
  const readable = access.readable
  const [tasks, recentItems] = await Promise.all([s.listTasks({ zones: readable }), s.listItems({ zones: readable, limit: 30, excludeSuperseded: true })])
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

  // Synapses: two zones share entities (same customer, same tool, same project…).
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
    people: profiles.map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role, zone: homeZone(p, zones, authorStats, events) })),
    names,
    zones: zoneViews,
    synapses,
    events: events.map((e) => redactEvent(e, access, profile.id)),
    status: await statusForViewer(viewer, status, zones),
    automations: automations.filter((a) => access.isAdmin || a.user_id === profile.id),
    tasks: tasks.slice(0, 40),
    items: recentItems,
    can_publish_skills: canPublishSkills(viewer),
    totals: {
      items: stats.reduce((n, x) => n + x.count, 0),
      skills: skills.filter((sk) => canSeeSkill(viewer, sk)).length,
      contributors: new Set(profiles.map((p) => p.id)).size,
      active_24h: activeUsers.size,
    },
    claude: (await claudeKeyInfo(store())).source !== null,
    embeddings: getEmbeddings()?.model ?? null,
  }
}

export type DashboardState = Awaited<ReturnType<typeof getState>>

/**
 * "Where the company stands" as seen by a member: only the zones they read. The generated headline (Claude or heuristic)
 * summarizes all zones: it is only given to whoever reads them all; the others get a headline recomputed
 * on their own zones only.
 */
export async function statusForViewer(viewer: Viewer, status?: CompanyStatus | null, zoneList?: Zone[]): Promise<CompanyStatus | null> {
  const s = store()
  const current = status === undefined ? await s.getStatus() : status
  if (!current) return null
  const { access } = viewer
  const zones = zoneList ?? (await s.listZones())
  const scoped = { ...current, zones: current.zones.filter((z) => canRead(access, z.zone)) }
  if (access.isAdmin || zones.every((z) => canRead(access, z.id))) return scoped
  return { ...scoped, headline: await scopedHeadline(zones.filter((z) => canRead(access, z.id))) }
}

async function scopedHeadline(zones: Zone[]): Promise<string> {
  if (zones.length === 0) return "No accessible zone yet: ask an admin for access."
  const s = store()
  const ids = zones.map((z) => z.id)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const [items, tasks, profiles] = await Promise.all([s.listItems({ zones: ids, sinceIso: since, limit: 600, excludeSuperseded: true }), s.listTasks({ zones: ids }), s.listProfiles()])
  let headline = heuristicStatus({ zones, items, tasks, profiles }).headline
  if (zones.length === 1) headline = headline.replace(/\s*Most active zone: [^.]*\.$/, "")
  return `${zones.length > 1 ? "In your zones" : "In your zone"} (${zones.map((z) => z.name).join(", ")}): ${headline}`
}

/** "State update" neon: all zones light up during generation. */
async function emitStatusEvent(viewer: Viewer, zones: Zone[]) {
  await store().insertEvents([
    {
      user_id: viewer.real.id,
      agent: "job",
      type: "query",
      zones: zones.map((z) => z.id),
      summary: "Updating the state of the company",
      at: new Date().toISOString(),
    },
  ])
}

/** Regenerates the "where the company stands" screen (Claude if available, otherwise heuristic). */
export async function refreshStatus(viewer: Viewer) {
  const s = store()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const [zones, items, tasks, profiles, org] = await Promise.all([
    s.listZones(),
    s.listItems({ sinceIso: since, limit: 600, excludeSuperseded: true }),
    s.listTasks({}),
    s.listProfiles(),
    s.getOrg(),
  ])
  await emitStatusEvent(viewer, zones)
  const claude = await getClaude()
  const status =
    (claude && (await summarizeStatus(claude, { zones, items, tasks, profiles, companyName: org.name }))) ||
    heuristicStatus({ zones, items, tasks, profiles })
  await s.setStatus(status)
  return status
}

/** Day (YYYY-MM-DD) in the company's time zone. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE }).format(new Date())
}

/**
 * GET /api/status/input (admins): knowledge from the last 30 days (400 at most, most recent first,
 * author = the member's name) and the tasks, to generate the summary on a workstation with `claude -p`.
 */
export async function getStatusInput(): Promise<StatusInput> {
  const s = store()
  const since = new Date(Date.now() - STATUS_WINDOW_DAYS * 86400_000).toISOString()
  const [org, zones, items, tasks, profiles] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listItems({ sinceIso: since, limit: STATUS_MAX_ITEMS, excludeSuperseded: true }),
    s.listTasks({}),
    s.listProfiles(),
  ])
  return buildStatusInput({ companyName: org.name, zones, items, tasks, profiles, generatedFor: today() })
}

/** Summary produced outside the server (an admin's workstation), already validated by the route. */
export type ExternalStatus = { headline: string; zones: ZoneStatus[] }

/**
 * POST /api/status with a summary: redacted again (defense in depth), unknown or duplicate zones dropped,
 * saved as generated by Claude now. Null if no zone is known.
 */
export async function saveExternalStatus(viewer: Viewer, input: ExternalStatus): Promise<CompanyStatus | null> {
  const s = store()
  const zones = await s.listZones()
  const known = new Set(zones.map((z) => z.id))
  const clean = (t: string, max: number) => truncate(redactText(t.replace(/\s+/g, " ").trim()), max)
  const list = (xs: string[], n: number, max: number) => xs.map((x) => clean(x, max)).filter(Boolean).slice(0, n)
  const seen = new Set<string>()
  const zoneStatuses: ZoneStatus[] = []
  for (const z of input.zones) {
    if (!known.has(z.zone) || seen.has(z.zone)) continue
    seen.add(z.zone)
    zoneStatuses.push({
      zone: z.zone,
      summary: clean(z.summary, 1500),
      objectives: list(z.objectives, 10, 300),
      progress: clean(z.progress, 800),
      next_steps: list(z.next_steps, 10, 300),
      who_did_what: z.who_did_what
        .map((w) => ({ person: clean(w.person, 80), did: clean(w.did, 300) }))
        .filter((w) => w.person && w.did)
        .slice(0, 12),
    })
  }
  if (zoneStatuses.length === 0) return null
  const status: CompanyStatus = { headline: clean(input.headline, 600), zones: zoneStatuses, generated_at: new Date().toISOString(), generator: "claude" }
  await emitStatusEvent(viewer, zones)
  await s.setStatus(status)
  return status
}

/** Detects repetitive tasks and updates the automation suggestions. */
export async function runAutomationDetection() {
  const s = store()
  const since = new Date(Date.now() - 21 * 86400_000).toISOString()
  const [events, profiles] = await Promise.all([s.listEvents({ sinceIso: since, type: "query", limit: 20000 }), s.listProfiles()])
  const candidates = detectAutomations(events, profiles, { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE })
  return candidates.length ? s.upsertAutomations(candidates) : []
}

/** A workstation's context (handover): zones, entities and topics a person uses the most. */
export async function getPersonContext(viewer: Viewer, personId: string) {
  const s = store()
  const person = await s.getProfile(personId)
  if (!person) return null
  const readable = viewer.access.readable
  // Right of review: on one's own context, one sees ALL one's knowledge, including items filed
  // in a zone one doesn't read (to be able to review and delete them).
  const own = personId === viewer.profile.id
  const scope = own ? undefined : readable
  const [items, entities, events] = await Promise.all([
    s.listItems({ authorId: personId, zones: scope, limit: 200 }),
    s.topEntities({ authorId: personId, zones: scope, limit: 15 }),
    s.listEvents({ userId: personId, limit: 500 }),
  ])
  const zoneCounts = new Map<string, number>()
  for (const i of items) zoneCounts.set(i.zone, (zoneCounts.get(i.zone) ?? 0) + 1)
  for (const e of events) for (const z of e.zones) if (own || readable.includes(z)) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 0.5)
  const prompts = new Map<string, { summary: string; count: number; last: string }>()
  for (const e of events) {
    // The prompts typed by the person (hooks), not the searches made by their agents.
    if (e.type !== "query" || (e.agent !== "claude-code" && e.agent !== "codex")) continue
    if (!e.summary || !canSeeEventContent(e, viewer.access, viewer.profile.id)) continue
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
    // On one's own context: all one's recent knowledge (up to 200), to be able to delete it.
    items: own ? items : items.slice(0, 40),
    /** Zones of the person's own items that they don't read (shown with a "zone not readable" badge). */
    unreadable_zones: own ? [...new Set(items.map((i) => i.zone))].filter((z) => !canRead(viewer.access, z)) : [],
    decisions: items.filter((i) => i.kind === "decision").slice(0, 10),
    procedures: items.filter((i) => i.kind === "procedure").slice(0, 10),
  }
}

/** Maximum catch-up when opening the real-time stream (cursor too old). */
const STREAM_MAX_BACKLOG = 200

/**
 * Starting point of the real-time stream: the requested id (Last-Event-ID or ?after=), bounded. Greater than the
 * last event (brain reset) → restart from the last one; too old → limited catch-up.
 */
export async function streamStartId(requested: number | null): Promise<number> {
  const latest = (await store().listEvents({ limit: 1 }))[0]?.id ?? 0
  if (requested === null || !Number.isSafeInteger(requested) || requested < 0 || requested > latest) return latest
  return Math.max(requested, latest - STREAM_MAX_BACKLOG)
}

/**
 * Incremental read of agent_events for the real-time stream.
 * In Postgres, an id can become visible AFTER a larger id (commit order): the gaps
 * are re-read for `gapMs` (transaction still open) without ever returning an event already delivered.
 */
export function createEventPoller(startId: number, opts: { gapMs?: number; maxGaps?: number } = {}) {
  const gapMs = opts.gapMs ?? 10_000
  const maxGaps = opts.maxGaps ?? 500
  const gaps = new Map<number, number>()
  let cursor = startId
  return {
    get cursor() {
      return cursor
    },
    async poll(): Promise<AgentEvent[]> {
      const now = Date.now()
      const out: AgentEvent[] = []
      for (const [id, since] of gaps) if (now - since > gapMs) gaps.delete(id)
      if (gaps.size) {
        const low = Math.min(...gaps.keys())
        const late = await store().listEvents({ afterId: low - 1, limit: Math.min(1000, cursor - low + 1) })
        for (const e of late) {
          if (e.id > cursor || !gaps.has(e.id)) continue
          gaps.delete(e.id)
          out.push(e)
        }
      }
      for (const e of await store().listEvents({ afterId: cursor, limit: 200 })) {
        for (let missing = Math.max(cursor + 1, e.id - maxGaps); missing < e.id; missing++) gaps.set(missing, now)
        cursor = e.id
        out.push(e)
      }
      if (gaps.size > maxGaps) for (const id of [...gaps.keys()].sort((a, b) => a - b).slice(0, gaps.size - maxGaps)) gaps.delete(id)
      return out
    },
  }
}

export function visibleEvent(viewer: Viewer, e: AgentEvent) {
  return redactEvent(e, viewer.access, viewer.profile.id)
}

export function itemAuthorOrAdmin(viewer: Viewer, item: KnowledgeItem): boolean {
  return viewer.real.role === "admin" || item.author_id === viewer.real.id
}
