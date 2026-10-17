// Logique métier du cerveau : ingestion, requêtes des agents, événements (néons), état, automatisations.

import {
  DEFAULT_TIMEZONE,
  STATUS_MAX_ITEMS,
  STATUS_WINDOW_DAYS,
  buildStatusInput,
  classifyZones,
  detectAutomations,
  heuristicStatus,
  looksPersonal,
  normalize,
  promptFingerprint,
  redactText,
  scoreZones,
  truncate,
  type AgentEvent,
  type AgentEventInput,
  type AgentName,
  type CompanyStatus,
  type KnowledgeItem,
  type KnowledgeItemInput,
  type StatusInput,
  type Zone,
  type ZoneStatus,
} from "@brain/core"
import { summarizeStatus } from "@brain/core/claude"
import { getStore, isStoreSetupError } from "./store"
import type { NewItem } from "./store/types"
import { canRead, canSeeEventContent, redactEvent } from "./access"
import type { Viewer } from "./auth"
import { getClaude } from "./ai"
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

/** Fenêtre de déduplication à l'ingestion (même auteur, même zone, même titre et même contenu normalisés). */
const DEDUPE_DAYS = 30

const dedupeText = (s: string) => normalize(s).replace(/\s+/g, " ").trim()

/**
 * Un titre identique ne suffit pas : une même fenêtre (titre de conversation) produit plusieurs faits successifs.
 * Seul un item identique (titre ET contenu, après masquage) est un doublon.
 */
function dedupeKey(zone: string, title: string, body: string): string {
  return JSON.stringify([zone, dedupeText(title), dedupeText(body)])
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`

/**
 * POST /api/ingest — les connaissances distillées sur le poste entrent dans le cerveau.
 * Tout le monde nourrit le cerveau : n'importe quelle zone existante est acceptée (seule la lecture est restreinte),
 * l'auteur garde toujours la main sur ses items (getPersonContext, queryBrain, suppression).
 * Idempotent : un item déjà reçu de ce même auteur, dans la même zone, avec le même titre et le même contenu
 * (normalisés) depuis 30 jours est ignoré.
 */
export async function ingestItems(viewer: Viewer, items: KnowledgeItemInput[], agent: AgentName = "brain-sync") {
  const zones = await store().listZones()
  const authorId = viewer.real.id
  const since = new Date(Date.now() - DEDUPE_DAYS * 86400_000).toISOString()
  const seen = new Set((await store().listItems({ authorId, sinceIso: since, limit: 100_000 })).map((i) => dedupeKey(i.zone, i.title, i.body)))
  const prepared: NewItem[] = []
  let skipped = 0
  for (const i of items) {
    // Défense en profondeur : on re-masque côté serveur même si le poste l'a déjà fait.
    const title = redactText(i.title)
    const body = redactText(i.body)
    const zone = resolveZone(i.zone, `${title} ${body}`, zones)
    const key = dedupeKey(zone, title, body)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    prepared.push({ ...i, title, body, zone, source: { ...i.source, at: clampDate(i.source.at) }, author_id: authorId })
  }
  const inserted = prepared.length ? await store().insertItems(prepared) : []
  const tasks = inserted
    .filter((i) => i.kind === "task")
    .map((i) => ({ title: i.title, zone: i.zone, status: "open" as const, assignee_id: authorId, source_item_id: i.id }))
  if (tasks.length) await store().createTasks(tasks)
  // Un événement d'écriture PAR zone, dont le résumé ne cite que des items de cette zone.
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
          summary: `${plural(list.length, "connaissance")} ${list.length > 1 ? "ajoutées" : "ajoutée"} : ${truncate(list[0].title, 80)}`,
          at,
        }
      }),
    )
  return { inserted: inserted.length, skipped, ids: inserted.map((i) => i.id), zones: touched }
}

/** Agents qui envoient les prompts saisis par l'employé (hooks UserPromptSubmit). */
const PROMPT_AGENTS = new Set<AgentName>(["claude-code", "codex"])

/** POST /api/events — hooks Claude Code, MCP, brain-sync. */
export async function recordEvents(viewer: Viewer, inputs: AgentEventInput[]) {
  const zones = await store().listZones()
  const known = new Set(zones.map((z) => z.id))
  const events = inputs.map((e) => {
    let summary = e.summary ? truncate(redactText(e.summary), 200) : undefined
    let eventZones = [...new Set((e.zones ?? []).filter((z) => known.has(z)))]
    if (eventZones.length === 0 && summary && e.type !== "started" && e.type !== "stopped") eventZones = classifyZones(summary, zones, 2)
    // Prompt saisi : son résumé n'est conservé que s'il se rattache à une zone et n'a rien de personnel (sinon l'empreinte seule).
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
 * Zones dont parle un texte : son classement (toutes les zones retenues, pas seulement les 2 premières), plus toute
 * zone dont un mot-clé est cité tel quel.
 */
function zonesMentioned(text: string, zones: Zone[]): string[] {
  const out = new Set(classifyZones(text, zones, zones.length))
  for (const s of scoreZones(text, zones)) if (s.score >= 1) out.add(s.zone)
  return [...out]
}

/** POST /api/query — un agent cherche du contexte. La zone trouvée s'allume. */
export async function queryBrain(viewer: Viewer, input: { query: string; zones?: string[]; limit?: number; agent?: AgentName }) {
  const allZones = await store().listZones()
  const readable = viewer.access.readable
  const filter = input.zones?.length ? input.zones : null
  const searched = filter ? filter.filter((z) => readable.includes(z)) : readable
  // Zones lisibles + les propres items de l'utilisateur, même rangés dans une zone qu'il ne lit pas (droit de regard).
  const results = (await store().searchItems(input.query, searched, input.limit ?? 8, { authorId: viewer.profile.id })).filter(
    (r) => !filter || filter.includes(r.zone),
  )
  // Seules les zones lisibles s'allument : une recherche n'est jamais diffusée dans une zone que l'on ne lit pas.
  let hit = [...new Set(results.filter((r) => readable.includes(r.zone)).slice(0, 3).map((r) => r.zone))]
  if (hit.length === 0) hit = classifyZones(input.query, allZones, 2).filter((z) => readable.includes(z))
  const restricted = classifyZones(input.query, allZones, 2).filter((z) => !readable.includes(z) && !hit.includes(z))
  // Le texte de la recherche n'est conservé (et montré aux lecteurs des zones allumées) que s'il ne touche aucune zone
  // que l'utilisateur ne lit pas (classement, filtre demandé, ses propres items trouvés) et n'a rien de personnel.
  const asked = (input.zones ?? []).filter((z) => allZones.some((x) => x.id === z))
  const touched = [...zonesMentioned(input.query, allZones), ...asked, ...results.map((r) => r.zone)]
  const touchesUnreadable = touched.some((z) => !canRead(viewer.access, z))
  const keepSummary = !touchesUnreadable && !looksPersonal(input.query)
  // Avec son texte, l'événement porte toutes les zones que la recherche touche (pas seulement celles des résultats) :
  // D2 ne montre alors le texte qu'aux lecteurs de TOUTES ces zones.
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
  const [org, zones, stats, profiles, events, status, automations, entities, skills] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.zoneStats(),
    s.listProfiles(),
    s.listEvents({ limit: 60 }),
    s.getStatus(),
    s.listAutomations(),
    s.topEntities({ limit: 250 }),
    // Base pas encore migrée (table skills absente) : le cerveau reste utilisable, sans skills.
    s.listSkills().catch((err) => {
      if (!isStoreSetupError(err)) throw err
      console.error("[skills]", err.message)
      return []
    }),
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
    claude: Boolean(getClaude()),
  }
}

export type DashboardState = Awaited<ReturnType<typeof getState>>

/**
 * « Où en est la boîte » vu par un membre : seulement les zones qu'il lit. Le titre généré (Claude ou heuristique)
 * résume toutes les zones : il n'est donné qu'à qui les lit toutes ; les autres reçoivent un titre recalculé
 * sur leurs seules zones.
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
  if (zones.length === 0) return "Aucune zone accessible pour l'instant : demandez un accès à un admin."
  const s = store()
  const ids = zones.map((z) => z.id)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const [items, tasks, profiles] = await Promise.all([s.listItems({ zones: ids, sinceIso: since, limit: 600 }), s.listTasks({ zones: ids }), s.listProfiles()])
  let headline = heuristicStatus({ zones, items, tasks, profiles }).headline
  if (zones.length === 1) headline = headline.replace(/\s*Zone la plus active : [^.]*\.$/, "")
  return `${zones.length > 1 ? "Dans vos zones" : "Dans votre zone"} (${zones.map((z) => z.name).join(", ")}) : ${headline}`
}

/** Néon « mise à jour de l'état » : toutes les zones s'allument pendant la génération. */
async function emitStatusEvent(viewer: Viewer, zones: Zone[]) {
  await store().insertEvents([
    {
      user_id: viewer.real.id,
      agent: "job",
      type: "query",
      zones: zones.map((z) => z.id),
      summary: "Mise à jour de l'état de l'entreprise",
      at: new Date().toISOString(),
    },
  ])
}

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
  await emitStatusEvent(viewer, zones)
  const claude = getClaude()
  const status =
    (claude && (await summarizeStatus(claude, { zones, items, tasks, profiles, companyName: org.name }))) ||
    heuristicStatus({ zones, items, tasks, profiles })
  await s.setStatus(status)
  return status
}

/** Jour (AAAA-MM-JJ) dans le fuseau de l'entreprise. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE }).format(new Date())
}

/**
 * GET /api/status/input (admins) : les connaissances des 30 derniers jours (400 au plus, les plus récentes d'abord,
 * auteur = nom du membre) et les tâches, pour générer le résumé sur un poste avec `claude -p`.
 */
export async function getStatusInput(): Promise<StatusInput> {
  const s = store()
  const since = new Date(Date.now() - STATUS_WINDOW_DAYS * 86400_000).toISOString()
  const [org, zones, items, tasks, profiles] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listItems({ sinceIso: since, limit: STATUS_MAX_ITEMS }),
    s.listTasks({}),
    s.listProfiles(),
  ])
  return buildStatusInput({ companyName: org.name, zones, items, tasks, profiles, generatedFor: today() })
}

/** Résumé produit hors du serveur (poste d'un admin), déjà validé par la route. */
export type ExternalStatus = { headline: string; zones: ZoneStatus[] }

/**
 * POST /api/status avec un résumé : re-masqué (défense en profondeur), zones inconnues ou en double écartées,
 * enregistré comme généré par Claude maintenant. Null si aucune zone connue.
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
  // Droit de regard : sur son propre contexte, on voit TOUTES ses connaissances, y compris celles rangées
  // dans une zone qu'on ne lit pas (pour pouvoir les relire et les supprimer).
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
    // Les prompts saisis par la personne (hooks), pas les recherches faites par ses agents.
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
    // Sur son propre contexte : toutes ses connaissances récentes (jusqu'à 200), pour pouvoir les supprimer.
    items: own ? items : items.slice(0, 40),
    /** Zones de ses propres items que la personne ne lit pas (affichées avec un badge « zone non lisible »). */
    unreadable_zones: own ? [...new Set(items.map((i) => i.zone))].filter((z) => !canRead(viewer.access, z)) : [],
    decisions: items.filter((i) => i.kind === "decision").slice(0, 10),
    procedures: items.filter((i) => i.kind === "procedure").slice(0, 10),
  }
}

/** Rattrapage maximal à l'ouverture du flux temps réel (curseur trop ancien). */
const STREAM_MAX_BACKLOG = 200

/**
 * Point de départ du flux temps réel : l'identifiant demandé (Last-Event-ID ou ?after=), borné. Plus grand que le
 * dernier événement (cerveau réinitialisé) → on repart du dernier ; trop ancien → rattrapage limité.
 */
export async function streamStartId(requested: number | null): Promise<number> {
  const latest = (await store().listEvents({ limit: 1 }))[0]?.id ?? 0
  if (requested === null || !Number.isSafeInteger(requested) || requested < 0 || requested > latest) return latest
  return Math.max(requested, latest - STREAM_MAX_BACKLOG)
}

/**
 * Lecture incrémentale de agent_events pour le flux temps réel.
 * En Postgres, un identifiant peut devenir visible APRÈS un identifiant plus grand (ordre des commits) : les trous
 * sont relus pendant `gapMs` (transaction encore ouverte) sans jamais renvoyer un événement déjà livré.
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
