// The fictional company Encore, ready for the demo: accounts, zones, knowledge and 10 days of activity.
// Used by `npm run seed` and, in demo mode, to seed an empty brain automatically (deployment).

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
import {
  DEMO_ITEMS,
  DEMO_ORG,
  DEMO_PROMPTS,
  DEMO_SCREENPIPE_ITEMS,
  DEMO_SKILLS,
  DEMO_USERS,
  DEMO_WORKFLOWS,
  JEANMARC_DAILY_PROMPT,
  LEGACY_DEMO_NAMES,
  type DemoItem,
} from "../scripts/demo-data"

const TZ = process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE

/** UTC date matching a local time (TZ time zone) N days before today. */
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

/** Title of the accounts created from the home page: it counts them and tells them apart from the Encore team. */
export const DEMO_VISITOR_TITLE = "Demo visitor"
/** The same title as written by earlier (French) versions: those visitors are kept when a former demo is replaced. */
const LEGACY_DEMO_VISITOR_TITLE = "Visiteur de la démo"
/** Visitors get the Dev and Product zones: they join the lead dev's team in the org chart. */
const VISITOR_MANAGER = "hugo"

/** Publishes the demo skills (one publication per version); returns the neon of each publication. */
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
      summary: `Skill published: ${sk.name}`,
      at: localTime(sk.daysAgo, 11, 30).toISOString(),
    })
  }
  return events
}

/** Encore team accounts found by their email (null if one is missing: this is not the demo brain). */
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

/** Manager of a new demo visitor in the org chart (null outside the demo brain). */
export async function demoVisitorManager(store: BrainStore = getStore()): Promise<string | null> {
  return demoTeam(await store.listProfiles())?.[VISITOR_MANAGER] ?? null
}

/**
 * Demo brain filled by an earlier version: adds what it lacks, without erasing anything.
 * - Completely flat org chart (filled before reporting lines): the Encore team is attached as in the demo,
 *   visitors to the lead dev's team. As soon as one reporting line exists, it is left alone (an admin's choice).
 * - No skill: the demo skills are published and the planned members get the right to publish.
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

/** The app Screenpipe or the logs saw, by source tool. */
function demoApp(it: DemoItem): string {
  if (it.app) return it.app
  if (it.tool === "claude-code" || it.tool === "codex") return "Terminal"
  if (it.tool === "chatgpt") return "Google Chrome"
  if (it.tool === "agent") return "Screenpipe"
  return "Claude"
}

function demoWriteSummary(it: DemoItem): string {
  const title = it.title.slice(0, 80)
  if (it.tool === "meeting") return `Meeting distilled (${demoApp(it)}): ${title}`
  if (it.tool === "agent") return `Screenpipe agent found: ${title}`
  return `1 item added: ${title}`
}

/** Inserts demo knowledge (and its tasks); returns the brain-sync write events, one per item. */
async function insertDemoItems(store: BrainStore, ids: Record<string, string>, list: DemoItem[], r: () => number): Promise<NewEvent[]> {
  const events: NewEvent[] = []
  for (const it of [...list].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const at = localTime(it.daysAgo, 9 + Math.floor(r() * 9), Math.floor(r() * 60))
    const fromScreenpipe = it.tool === "meeting" || it.tool === "agent" || it.tool === "chatgpt"
    const [item] = await store.insertItems([
      {
        author_id: ids[it.author],
        zone: it.zone,
        kind: it.kind,
        title: it.title,
        body: it.body,
        entities: it.entities,
        source: {
          app: demoApp(it),
          tool: it.tool ?? "claude",
          at: at.toISOString(),
          ...(fromScreenpipe ? { screenpipe_ref: `screenpipe:${it.tool}:${Math.floor(at.getTime() / 1000)}` } : {}),
        },
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
      summary: demoWriteSummary(it),
      at: new Date(at.getTime() + 15 * 60_000).toISOString(),
    })
  }
  return events
}

/** The workflows Screenpipe detected on the computers, as brain-sync reports them (source "screenpipe"). */
async function seedDemoWorkflows(store: BrainStore, ids: Record<string, string>) {
  await store.upsertAutomations(
    DEMO_WORKFLOWS.map((w) => ({
      key: `screenpipe:${ids[w.user]}:${w.id}`,
      user_id: ids[w.user],
      zone: w.zone,
      title: w.title,
      description: w.description,
      schedule: w.schedule,
      evidence: { occurrences: w.occurrences, days: w.days },
      minutes_saved_per_week: w.minutes_saved_per_week,
      source: "screenpipe" as const,
    })),
  )
}

/**
 * Demo brain seeded before the Screenpipe examples existed: adds them (meetings, browser chats, Screenpipe agent,
 * workflows) without touching anything else. Returns the number of items added (0 if already there).
 */
export async function upgradeScreenpipeDemo(store: BrainStore = getStore()): Promise<number> {
  if ((await store.getOrg()).name !== DEMO_ORG.name) return 0
  const ids = demoTeam(await store.listProfiles())
  if (!ids) return 0
  const existing = new Set((await store.listItems({})).map((i) => i.title))
  const missing = DEMO_SCREENPIPE_ITEMS.filter((it) => !existing.has(it.title))
  if (missing.length) await store.insertEvents(await insertDemoItems(store, ids, missing, rand(7)))
  await seedDemoWorkflows(store, ids)
  return missing.length
}

export type DemoTokens = Record<string, { name: string; token: string; id: string }>

/** Empties the brain and fills it with Encore. Returns the accounts' tokens (shown only once). */
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

  // Knowledge (and the matching brain-sync write event), including what came from Screenpipe.
  events.push(...(await insertDemoItems(store, ids, [...DEMO_ITEMS, ...DEMO_SCREENPIPE_ITEMS], r)))

  events.push(...(await seedDemoSkills(store, ids, allZoneIds)))

  // History of sessions and prompts over 10 days.
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

  // Jean-Marc runs the same prompt every weekday morning around 9am.
  for (let d = 7; d >= 0; d--) {
    if (isWeekend(d)) continue
    const at = localTime(d, 9, 1 + Math.floor(r() * 9))
    if (at.getTime() > Date.now()) continue
    const session = `seed-jm-${d}`
    events.push({ user_id: ids.jeanmarc, agent: "claude-code", type: "started", zones: [], session_id: session, at: at.toISOString() })
    events.push({
      user_id: ids.jeanmarc, agent: "claude-code", type: "query", zones: ["finance"], summary: JEANMARC_DAILY_PROMPT,
      fingerprint: promptFingerprint(JEANMARC_DAILY_PROMPT), session_id: session, at: new Date(at.getTime() + 15_000).toISOString(),
    })
    events.push({ user_id: ids.jeanmarc, agent: "claude-code", type: "stopped", zones: [], session_id: session, at: new Date(at.getTime() + 12 * 60_000).toISOString() })
  }

  events.sort((a, b) => a.at.localeCompare(b.at))
  const inserted: AgentEvent[] = await store.insertEvents(events)

  // State of the company and automations detected on that history.
  const [items, tasks, profiles] = await Promise.all([store.listItems({}), store.listTasks({}), store.listProfiles()])
  await store.setStatus(heuristicStatus({ zones, items, tasks, profiles }))
  const autos = detectAutomations(inserted, profiles, { timeZone: TZ })
  if (autos.length) await store.upsertAutomations(autos)
  await seedDemoWorkflows(store, ids)

  return { tokens, counts: { users: DEMO_USERS.length, skills: DEMO_SKILLS.length, items: items.length, tasks: tasks.length, events: inserted.length, automations: autos.length + DEMO_WORKFLOWS.length } }
}

/**
 * Why the brain must give way to the current demo, or null: still on a former fictional company (LEGACY_DEMO_NAMES:
 * Fournil, or Butine in French or in English).
 */
async function outdatedDemo(store: BrainStore): Promise<"legacy" | null> {
  return LEGACY_DEMO_NAMES.includes((await store.getOrg()).name) ? "legacy" : null
}

/**
 * Outdated demo brain (outdatedDemo): replaced by the current demo.
 * Visitors are recreated with the same token and the same zones: a computer already connected to the demo stays so.
 * Returns null if the brain is not an outdated demo (nothing is touched).
 */
export async function replaceOutdatedDemoBrain(store: BrainStore = getStore()) {
  if (!(await outdatedDemo(store))) return null
  const visitors: { name: string; email?: string; token_hash: string; zones: { zone_id: string; can_write: boolean }[] }[] = []
  for (const v of (await store.listProfiles()).filter((p) => p.title === DEMO_VISITOR_TITLE || p.title === LEGACY_DEMO_VISITOR_TITLE)) {
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
 * Demo mode only: a brain without any account (fresh deployment database) is seeded with Encore.
 * An Encore brain already filled is never erased: it is only completed (upgradeDemoBrain). Only a brain still on a
 * former demo company is replaced, once, keeping its visitors (replaceOutdatedDemoBrain).
 */
export async function ensureDemoBrain(): Promise<void> {
  if (!isDemoMode()) return
  if (!g.__demoBootstrap) {
    g.__demoBootstrap = (async () => {
      const store = getStore()
      if (!(await store.isEmpty())) {
        await replaceOutdatedOnce(store)
        return upgradeOnce(store)
      }
      // Several instances may receive the first visits at the same time: only one seeds the demo.
      // The others wait for the "done" marker without touching the data (reading the accounts would create an empty org).
      if (!(await store.claimOnce("demo-bootstrap"))) {
        for (let i = 0; i < 60 && !(await store.isClaimDone("demo-bootstrap")); i++) await new Promise((r) => setTimeout(r, 500))
        return
      }
      try {
        const res = await seedDemoBrain(store)
        await store.finishClaim("demo-bootstrap")
        console.log(`[demo] empty brain seeded with ${DEMO_ORG.name}: ${res.counts.items} items, ${res.counts.events} events.`)
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

/** Only one instance replaces an outdated demo; the others wait for it to finish, without touching the data. */
async function replaceOutdatedOnce(store: BrainStore) {
  const reason = await outdatedDemo(store)
  if (!reason) return
  const key = `demo-replace-${reason}-${DEMO_ORG.name}`
  if (!(await store.claimOnce(key))) {
    for (let i = 0; i < 60 && !(await store.isClaimDone(key)); i++) await new Promise((r) => setTimeout(r, 500))
    return
  }
  try {
    const res = await replaceOutdatedDemoBrain(store)
    await store.finishClaim(key)
    if (res) console.log(`[demo] ${reason} demo replaced by ${DEMO_ORG.name}: ${res.items} items, ${res.visitors} visitor(s) kept.`)
  } catch (err) {
    await store.releaseClaim(key).catch(() => {})
    throw err
  }
}

/** Only one instance completes the demo brain (the others move on: there is no hurry). */
async function upgradeOnce(store: BrainStore) {
  await claimed(store, "demo-upgrade-skills-org", async () => {
    const res = await upgradeDemoBrain(store)
    if (res.managers || res.skills) console.log(`[demo] brain completed: ${res.managers} reporting line(s), ${res.skills} skill(s).`)
  })
  await claimed(store, "demo-upgrade-screenpipe", async () => {
    const n = await upgradeScreenpipeDemo(store)
    if (n) console.log(`[demo] brain completed: ${n} Screenpipe item(s) and the detected workflows.`)
  })
}

/** Runs `fn` once across instances (claim marker in the database). */
async function claimed(store: BrainStore, key: string, fn: () => Promise<void>) {
  if (!(await store.claimOnce(key))) return
  try {
    await fn()
    await store.finishClaim(key)
  } catch (err) {
    await store.releaseClaim(key).catch(() => {})
    throw err
  }
}
