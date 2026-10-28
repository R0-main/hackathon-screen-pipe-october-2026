// The live demo kept alive (BRAIN_DEMO=1): a visitor should find a team at work, not a brain frozen on the day it was
// seeded. Driven by the visits themselves (the dashboard re-reads /api/state every 45 s), without any scheduled job:
// - once a day: the history moves forward by whole weeks when its latest knowledge is more than a week old (weekdays
//   stay weekdays), and the company status is generated again;
// - while someone watches: an agent of the team works every PULSE_MS or so (a prompt, a real search_brain, now and
//   then a fresh piece of knowledge), and the six computers report their syncs, as the real ones do every 15 minutes.

import { SYNC_EVERY_MS, heuristicStatus, promptFingerprint, type AgentEvent } from "@brain/core"
import { getAccess } from "./access"
import { ingestItems, queryBrain, recordEvents } from "./brain"
import { demoTeam } from "./demo-seed"
import { localDay } from "./new-zones"
import { getStore, type BrainStore } from "./store"
import { DEMO_AGENT_QUERIES, DEMO_FRESH_ITEMS, DEMO_KEYWORDS, DEMO_ORG, DEMO_PROMPTS, DEMO_USERS } from "../scripts/demo-data"

/** Time between two agent scenes while the demo is watched. */
export const PULSE_MS = 40_000
/** A session left open this long is ended by the next pulse. */
const SESSION_MS = 3 * 60_000
const WEEK_MS = 7 * 86400_000
/** Chance that a scene also sends up a fresh piece of knowledge (each one only once). */
const FRESH_CHANCE = 0.25

export type PulseResult = { day: { shiftedDays: number; status: boolean } | null; scene: string | null; reports: number; ended: number }

/**
 * Once a day (first visit): when the latest knowledge is more than a week old, the whole history up to it moves
 * forward by as many whole weeks as fit before now; then the company status is generated again on what the team knows.
 */
export async function keepDemoCurrent(store: BrainStore, now = Date.now()): Promise<{ shiftedDays: number; status: boolean }> {
  const items = await store.listItems({ limit: 5000 })
  const latest = Math.max(...items.map((i) => Date.parse(i.source?.at ?? i.created_at)).filter(Number.isFinite))
  let shiftedDays = 0
  if (Number.isFinite(latest) && now - latest > WEEK_MS) {
    const weeks = Math.floor((now - latest) / WEEK_MS)
    const until = new Date(Math.max(latest, ...items.map((i) => Date.parse(i.created_at)))).toISOString()
    await store.shiftTimeline(weeks * WEEK_MS, until)
    shiftedDays = weeks * 7
  }
  const [zones, all, tasks, profiles] = await Promise.all([store.listZones(), store.listItems({}), store.listTasks({}), store.listProfiles()])
  await store.setStatus(heuristicStatus({ zones, items: all, tasks, profiles }))
  return { shiftedDays, status: true }
}

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)]

/**
 * One beat of the live demo, for the demo company only (a company created next to it is never touched). Cheap when
 * nothing is due: a scene only if no agent of the team worked in the last PULSE_MS, the day's work only once a day.
 */
export async function demoPulse(store: BrainStore = getStore(), now = Date.now(), rnd: () => number = Math.random): Promise<PulseResult | null> {
  if ((await store.getOrg()).name !== DEMO_ORG.name) return null
  const profiles = await store.listProfiles()
  const ids = demoTeam(profiles)
  if (!ids) return null
  const result: PulseResult = { day: null, scene: null, reports: 0, ended: 0 }

  const dayKey = `demo-day-${localDay(new Date(now))}`
  if (await store.claimOnce(dayKey)) {
    try {
      result.day = await keepDemoCurrent(store, now)
      await store.finishClaim(dayKey)
    } catch (err) {
      await store.releaseClaim(dayKey).catch(() => {})
      throw err
    }
  }

  const team = new Set(Object.values(ids))
  const recent: AgentEvent[] = (await store.listEvents({ limit: 80 })).filter((e) => team.has(e.user_id))
  // Sessions the previous scenes left open end after a few minutes.
  const stopped = new Set(recent.filter((e) => e.type === "stopped" && e.session_id).map((e) => e.session_id))
  const open = recent.filter((e) => e.type === "started" && e.session_id?.startsWith("pulse-") && !stopped.has(e.session_id) && now - Date.parse(e.at) > SESSION_MS)
  if (open.length) {
    await store.insertEvents(open.map((e) => ({ user_id: e.user_id, agent: e.agent, type: "stopped" as const, zones: [], session_id: e.session_id, at: new Date(now).toISOString() })))
    result.ended = open.length
  }

  // The computers sync every 15 minutes: their reports stay fresh while the demo is watched.
  const reports = new Map((await store.latestSyncReports()).map((r) => [r.user_id, r]))
  for (const u of DEMO_USERS) {
    const last = reports.get(ids[u.key])
    if (last && now - Date.parse(last.at) < SYNC_EVERY_MS) continue
    await store.saveSyncReport(ids[u.key], {
      at: new Date(now - Math.floor(rnd() * 5 * 60_000)).toISOString(),
      ok: true,
      duration_ms: 2000 + Math.floor(rnd() * 9000),
      items_sent: rnd() < 0.3 ? 1 : 0,
      duplicates: 0,
      conversations: { claude: Math.floor(rnd() * 3), screenpipe: 1 + Math.floor(rnd() * 4) },
      distiller: "claude-cli",
      failed: 0,
      deferred: 0,
      platform: "darwin",
      screenpipe: true,
    })
    result.reports++
  }

  // An agent of the team works, unless one just did.
  if (recent.some((e) => e.agent !== "dashboard" && now - Date.parse(e.at) < PULSE_MS)) return result
  const zone = pick(Object.keys(DEMO_PROMPTS), rnd)
  const prompt = pick(DEMO_PROMPTS[zone], rnd)
  const person = profiles.find((p) => p.id === ids[prompt.user])
  if (!person) return result
  const viewer = { profile: person, real: person, access: await getAccess(person) }
  const agent = prompt.user === "hugo" && rnd() < 0.4 ? "codex" : "claude-code"
  const session = `pulse-${now}`
  const at = (offset: number) => new Date(now - offset).toISOString()
  await recordEvents(viewer, [
    { agent, type: "started", session_id: session, at: at(30_000) },
    { agent, type: "query", zones: [zone], summary: prompt.text, fingerprint: promptFingerprint(prompt.text), session_id: session, at: at(20_000) },
  ])
  // The agent asks the brain, as it would through the MCP: the zones found light up.
  await queryBrain(viewer, { query: pick(DEMO_AGENT_QUERIES[zone] ?? [prompt.text], rnd), agent: "mcp" })
  result.scene = `${person.name}: ${prompt.text}`
  if (rnd() < FRESH_CHANCE) {
    const since = new Date(now - 60 * 86400_000).toISOString()
    const known = new Set((await store.listItems({ sinceIso: since, limit: 5000 })).map((i) => i.title))
    const fresh = DEMO_FRESH_ITEMS.find((f) => !known.has(f.title))
    const author = fresh && profiles.find((p) => p.id === ids[fresh.author])
    if (fresh && author) {
      const { author: _a, ...item } = fresh
      await ingestItems({ profile: author, real: author, access: await getAccess(author) }, [{ ...item, keywords: DEMO_KEYWORDS[fresh.title], source: { ...item.source, at: new Date(now).toISOString() } }])
    }
  }
  return result
}
