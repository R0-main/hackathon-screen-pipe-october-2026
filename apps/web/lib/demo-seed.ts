// L'entreprise fictive Butine, prête pour la démo : comptes, zones, connaissances et 10 jours d'activité.
// Utilisé par `npm run seed` et, en mode démo, pour amorcer automatiquement un cerveau vide (déploiement).

import {
  DEFAULT_TIMEZONE,
  SKILL_MAIN_FILE,
  detectAutomations,
  heuristicStatus,
  promptFingerprint,
  withSkillFrontmatter,
  type AgentEvent,
  type Profile,
} from "@brain/core"
import { hashToken, isDemoMode, newToken } from "./auth"
import { getStore, type BrainStore } from "./store"
import type { NewEvent } from "./store/types"
import { DEMO_ITEMS, DEMO_ORG, DEMO_PROMPTS, DEMO_SKILLS, DEMO_USERS, JEANMARC_DAILY_PROMPT, LEGACY_DEMO_NAMES } from "../scripts/demo-data"

const TZ = process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE

/** Date UTC correspondant à une heure locale (fuseau TZ) N jours avant aujourd'hui. */
function localTime(daysAgo: number, hour: number, minute: number): Date {
  const day = new Date(Date.now() - daysAgo * 86400_000)
  const guess = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute))
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  const [h, m] = fmt.format(guess).split(":").map(Number)
  const offsetMin = h * 60 + m - (hour * 60 + minute)
  return new Date(guess.getTime() - offsetMin * 60_000)
}

function isWeekend(daysAgo: number): boolean {
  const d = localTime(daysAgo, 12, 0)
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d)
  return wd === "Sat" || wd === "Sun"
}

function rand(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/** Titre des comptes créés depuis la page d'accueil : c'est lui qui les compte et les distingue de l'équipe Butine. */
export const DEMO_VISITOR_TITLE = "Visiteur de la démo"
/** Les visiteurs ont les zones Dev et Produit : ils rejoignent l'équipe du lead dev dans l'organigramme. */
const VISITOR_MANAGER = "hugo"

/** Publie les skills de démo (une publication par version) ; renvoie le néon de chaque publication. */
async function seedDemoSkills(store: BrainStore, ids: Record<string, string>, allZoneIds: string[]): Promise<NewEvent[]> {
  const events: NewEvent[] = []
  for (const sk of [...DEMO_SKILLS].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const files = sk.files.map((f) => (f.path === SKILL_MAIN_FILE ? { ...f, content: withSkillFrontmatter(f.content, sk.name, sk.description) } : f))
    for (let v = 0; v < (sk.version ?? 1); v++)
      await store.publishSkill({ name: sk.name, description: sk.description, zone: sk.zone, files, publisher_id: ids[sk.author] })
    events.push({
      user_id: ids[sk.author],
      agent: "dashboard",
      type: "write",
      zones: sk.zone ? [sk.zone] : allZoneIds,
      summary: `Skill publié : ${sk.name}`,
      at: localTime(sk.daysAgo, 11, 30).toISOString(),
    })
  }
  return events
}

/** Comptes de l'équipe Butine retrouvés par leur email (null s'il en manque un : ce n'est pas le cerveau de démo). */
function demoTeam(profiles: Profile[]): Record<string, string> | null {
  const byEmail = new Map(profiles.filter((p) => p.email).map((p) => [p.email, p.id]))
  const ids: Record<string, string> = {}
  for (const u of DEMO_USERS) {
    const id = byEmail.get(u.email)
    if (!id) return null
    ids[u.key] = id
  }
  return ids
}

/** Responsable d'un nouveau visiteur de la démo dans l'organigramme (null hors du cerveau de démo). */
export async function demoVisitorManager(store: BrainStore = getStore()): Promise<string | null> {
  return demoTeam(await store.listProfiles())?.[VISITOR_MANAGER] ?? null
}

/**
 * Cerveau de démo rempli par une version antérieure : complète ce qui lui manque, sans rien effacer.
 * - Organigramme entièrement à plat (rempli avant les rattachements) : l'équipe Butine est rattachée comme dans la démo,
 *   les visiteurs à l'équipe du lead dev. Dès qu'un rattachement existe, on n'y touche plus (choix d'un admin).
 * - Aucun skill : les skills de démo sont publiés et les membres prévus reçoivent le droit de publier.
 */
export async function upgradeDemoBrain(store: BrainStore = getStore()) {
  const out = { managers: 0, skills: 0 }
  if ((await store.getOrg()).name !== DEMO_ORG.name) return out
  const profiles = await store.listProfiles()
  const ids = demoTeam(profiles)
  if (!ids) return out
  if (profiles.every((p) => !p.manager_id)) {
    for (const u of DEMO_USERS) {
      if (!u.manager) continue
      await store.updateProfile(ids[u.key], { manager_id: ids[u.manager] })
      out.managers++
    }
    for (const v of profiles.filter((p) => p.title === DEMO_VISITOR_TITLE)) {
      await store.updateProfile(v.id, { manager_id: ids[VISITOR_MANAGER] })
      out.managers++
    }
  }
  if ((await store.listSkills()).length === 0) {
    for (const u of DEMO_USERS) if (u.publishSkills) await store.updateProfile(ids[u.key], { can_publish_skills: true })
    const events = await seedDemoSkills(store, ids, (await store.listZones()).map((z) => z.id))
    await store.insertEvents(events)
    out.skills = DEMO_SKILLS.length
  }
  return out
}

export type DemoTokens = Record<string, { name: string; token: string; id: string }>

/** Vide le cerveau et le remplit avec Butine. Renvoie les jetons des comptes (affichés une seule fois). */
export async function seedDemoBrain(store: BrainStore = getStore()) {
  await store.reset(DEMO_ORG)
  const zones = await store.listZones()
  const allZoneIds = zones.map((z) => z.id)

  const tokens: DemoTokens = {}
  const ids: Record<string, string> = {}
  for (const u of DEMO_USERS) {
    const token = newToken()
    const profile = await store.createProfile({
      name: u.name,
      email: u.email,
      title: u.title,
      role: u.role,
      manager_id: u.manager ? ids[u.manager] : null,
      can_publish_skills: u.publishSkills ?? false,
      token_hash: hashToken(token),
    })
    const zonesFor = u.role === "admin" ? allZoneIds : u.zones
    await store.setZoneAccess(profile.id, zonesFor.map((zone_id) => ({ zone_id, can_write: true })))
    ids[u.key] = profile.id
    tokens[u.key] = { name: u.name, token, id: profile.id }
  }

  const r = rand(42)
  const events: NewEvent[] = []

  // Connaissances (et l'événement d'écriture brain-sync correspondant).
  const sorted = [...DEMO_ITEMS].sort((a, b) => b.daysAgo - a.daysAgo)
  for (const it of sorted) {
    const at = localTime(it.daysAgo, 9 + Math.floor(r() * 9), Math.floor(r() * 60))
    const [item] = await store.insertItems([
      {
        author_id: ids[it.author],
        zone: it.zone,
        kind: it.kind,
        title: it.title,
        body: it.body,
        entities: it.entities,
        source: { app: it.tool === "claude-code" || it.tool === "codex" ? "Terminal" : "Claude", tool: it.tool ?? "claude", at: at.toISOString() },
        confidence: 0.75 + Math.round(r() * 20) / 100,
        created_at: at.toISOString(),
      },
    ])
    if (it.kind === "task") {
      await store.createTasks([
        { title: it.title, zone: it.zone, status: it.done ? "done" : "open", assignee_id: ids[it.author], source_item_id: item.id, created_at: at.toISOString() },
      ])
    }
    events.push({
      user_id: ids[it.author],
      agent: "brain-sync",
      type: "write",
      zones: [it.zone],
      summary: `1 connaissance ajoutée : ${it.title.slice(0, 80)}`,
      at: new Date(at.getTime() + 15 * 60_000).toISOString(),
    })
  }

  events.push(...(await seedDemoSkills(store, ids, allZoneIds)))

  // Historique de sessions et de prompts sur 10 jours.
  for (let d = 10; d >= 0; d--) {
    if (isWeekend(d)) continue
    for (const [zone, prompts] of Object.entries(DEMO_PROMPTS)) {
      for (const pr of prompts) {
        if (r() < 0.55) continue
        const at = localTime(d, 9 + Math.floor(r() * 9), Math.floor(r() * 60))
        if (d === 0 && at.getTime() > Date.now()) continue
        const session = `seed-${d}-${pr.user}-${Math.floor(r() * 1e6)}`
        const agent = pr.user === "hugo" && r() < 0.3 ? "codex" : "claude-code"
        events.push({ user_id: ids[pr.user], agent, type: "started", zones: [], session_id: session, at: at.toISOString() })
        events.push({
          user_id: ids[pr.user], agent, type: "query", zones: [zone], summary: pr.text,
          fingerprint: promptFingerprint(pr.text), session_id: session, at: new Date(at.getTime() + 20_000).toISOString(),
        })
        events.push({
          user_id: ids[pr.user], agent: "mcp", type: "query", zones: [zone], summary: pr.text.slice(0, 90),
          session_id: session, at: new Date(at.getTime() + 45_000).toISOString(),
        })
        events.push({ user_id: ids[pr.user], agent, type: "stopped", zones: [], session_id: session, at: new Date(at.getTime() + 25 * 60_000).toISOString() })
      }
    }
  }

  // Jean-Marc lance le même prompt chaque matin de semaine vers 9 h.
  for (let d = 7; d >= 0; d--) {
    if (isWeekend(d)) continue
    const at = localTime(d, 9, 1 + Math.floor(r() * 9))
    if (at.getTime() > Date.now()) continue
    const session = `seed-jm-${d}`
    events.push({ user_id: ids.jeanmarc, agent: "claude-code", type: "started", zones: [], session_id: session, at: at.toISOString() })
    events.push({
      user_id: ids.jeanmarc, agent: "claude-code", type: "query", zones: ["compta"], summary: JEANMARC_DAILY_PROMPT,
      fingerprint: promptFingerprint(JEANMARC_DAILY_PROMPT), session_id: session, at: new Date(at.getTime() + 15_000).toISOString(),
    })
    events.push({ user_id: ids.jeanmarc, agent: "claude-code", type: "stopped", zones: [], session_id: session, at: new Date(at.getTime() + 12 * 60_000).toISOString() })
  }

  events.sort((a, b) => a.at.localeCompare(b.at))
  const inserted: AgentEvent[] = await store.insertEvents(events)

  // État de l'entreprise et automatisations détectées sur cet historique.
  const [items, tasks, profiles] = await Promise.all([store.listItems({}), store.listTasks({}), store.listProfiles()])
  await store.setStatus(heuristicStatus({ zones, items, tasks, profiles }))
  const autos = detectAutomations(inserted, profiles, { timeZone: TZ })
  if (autos.length) await store.upsertAutomations(autos)

  return { tokens, counts: { users: DEMO_USERS.length, skills: DEMO_SKILLS.length, items: items.length, tasks: tasks.length, events: inserted.length, automations: autos.length } }
}

/**
 * Cerveau de démo resté sur une ancienne entreprise fictive (LEGACY_DEMO_NAMES) : remplacé par la démo actuelle.
 * Les visiteurs sont recréés avec le même jeton et les mêmes zones : un poste déjà branché sur la démo le reste.
 * Renvoie null si le cerveau n'est pas une ancienne démo (rien n'est touché).
 */
export async function replaceLegacyDemoBrain(store: BrainStore = getStore()) {
  if (!LEGACY_DEMO_NAMES.includes((await store.getOrg()).name)) return null
  const visitors: { name: string; email?: string; token_hash: string; zones: { zone_id: string; can_write: boolean }[] }[] = []
  for (const v of (await store.listProfiles()).filter((p) => p.title === DEMO_VISITOR_TITLE)) {
    const token_hash = await store.getTokenHash(v.id)
    if (!token_hash) continue
    const zones = (await store.listZoneAccess(v.id)).map(({ zone_id, can_write }) => ({ zone_id, can_write }))
    visitors.push({ name: v.name, email: v.email ?? undefined, token_hash, zones })
  }
  const res = await seedDemoBrain(store)
  const known = new Set((await store.listZones()).map((z) => z.id))
  for (const v of visitors) {
    const { zones, ...rest } = v
    const profile = await store.createProfile({ ...rest, title: DEMO_VISITOR_TITLE, role: "member", manager_id: res.tokens[VISITOR_MANAGER].id })
    await store.setZoneAccess(profile.id, zones.filter((a) => known.has(a.zone_id)))
  }
  return { ...res.counts, visitors: visitors.length }
}

const g = globalThis as unknown as { __demoBootstrap?: Promise<void> }

/**
 * Mode démo uniquement : un cerveau sans aucun compte (base neuve d'un déploiement) est amorcé avec Butine.
 * Un cerveau Butine déjà rempli n'est jamais effacé : il est seulement complété (upgradeDemoBrain). Seul un cerveau
 * resté sur une ancienne entreprise de démo est remplacé, une fois, en gardant ses visiteurs (replaceLegacyDemoBrain).
 */
export async function ensureDemoBrain(): Promise<void> {
  if (!isDemoMode()) return
  if (!g.__demoBootstrap) {
    g.__demoBootstrap = (async () => {
      const store = getStore()
      if (!(await store.isEmpty())) {
        await replaceLegacyOnce(store)
        return upgradeOnce(store)
      }
      // Plusieurs instances peuvent recevoir les premières visites en même temps : une seule amorce la démo.
      // Les autres attendent le marqueur « terminé » sans toucher aux données (lire les comptes créerait une org vide).
      if (!(await store.claimOnce("demo-bootstrap"))) {
        for (let i = 0; i < 60 && !(await store.isClaimDone("demo-bootstrap")); i++) await new Promise((r) => setTimeout(r, 500))
        return
      }
      try {
        const res = await seedDemoBrain(store)
        await store.finishClaim("demo-bootstrap")
        console.log(`[démo] cerveau vide amorcé avec ${DEMO_ORG.name} : ${res.counts.items} connaissances, ${res.counts.events} événements.`)
      } catch (err) {
        await store.releaseClaim("demo-bootstrap").catch(() => {})
        throw err
      }
    })().catch((err) => {
      g.__demoBootstrap = undefined
      throw err
    })
  }
  return g.__demoBootstrap
}

/** Une seule instance remplace une ancienne démo ; les autres attendent qu'elle ait fini, sans toucher aux données. */
async function replaceLegacyOnce(store: BrainStore) {
  if (!LEGACY_DEMO_NAMES.includes((await store.getOrg()).name)) return
  const key = `demo-replace-legacy-${DEMO_ORG.name}`
  if (!(await store.claimOnce(key))) {
    for (let i = 0; i < 60 && !(await store.isClaimDone(key)); i++) await new Promise((r) => setTimeout(r, 500))
    return
  }
  try {
    const res = await replaceLegacyDemoBrain(store)
    await store.finishClaim(key)
    if (res) console.log(`[démo] ancienne démo remplacée par ${DEMO_ORG.name} : ${res.items} connaissances, ${res.visitors} visiteur(s) conservé(s).`)
  } catch (err) {
    await store.releaseClaim(key).catch(() => {})
    throw err
  }
}

/** Une seule instance complète le cerveau de démo (les autres passent leur chemin : rien ne presse). */
async function upgradeOnce(store: BrainStore) {
  const key = "demo-upgrade-skills-org"
  if (!(await store.claimOnce(key))) return
  try {
    const res = await upgradeDemoBrain(store)
    await store.finishClaim(key)
    if (res.managers || res.skills) console.log(`[démo] cerveau complété : ${res.managers} rattachement(s), ${res.skills} skill(s).`)
  } catch (err) {
    await store.releaseClaim(key).catch(() => {})
    throw err
  }
}
