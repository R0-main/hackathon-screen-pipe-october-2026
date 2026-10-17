// L'entreprise fictive Fournil, prête pour la démo : comptes, zones, connaissances et 10 jours d'activité.
// Utilisé par `npm run seed` et, en mode démo, pour amorcer automatiquement un cerveau vide (déploiement).

import {
  DEFAULT_TIMEZONE,
  detectAutomations,
  heuristicStatus,
  promptFingerprint,
  type AgentEvent,
} from "@brain/core"
import { hashToken, isDemoMode, newToken } from "./auth"
import { getStore, type BrainStore } from "./store"
import type { NewEvent } from "./store/types"
import { DEMO_ITEMS, DEMO_ORG, DEMO_PROMPTS, DEMO_USERS, JEANMARC_DAILY_PROMPT } from "../scripts/demo-data"

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

export type DemoTokens = Record<string, { name: string; token: string; id: string }>

/** Vide le cerveau et le remplit avec Fournil. Renvoie les jetons des comptes (affichés une seule fois). */
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

  return { tokens, counts: { users: DEMO_USERS.length, items: items.length, tasks: tasks.length, events: inserted.length, automations: autos.length } }
}

const g = globalThis as unknown as { __demoBootstrap?: Promise<void> }

/**
 * Mode démo uniquement : un cerveau sans aucun compte (base neuve d'un déploiement) est amorcé avec Fournil.
 * Ne touche jamais un cerveau qui contient déjà des comptes.
 */
export async function ensureDemoBrain(): Promise<void> {
  if (!isDemoMode()) return
  if (!g.__demoBootstrap) {
    g.__demoBootstrap = (async () => {
      const store = getStore()
      if (!(await store.isEmpty())) return
      // Plusieurs instances peuvent recevoir les premières visites en même temps : une seule amorce la démo.
      // Les autres attendent le marqueur « terminé » sans toucher aux données (lire les comptes créerait une org vide).
      if (!(await store.claimOnce("demo-bootstrap"))) {
        for (let i = 0; i < 60 && !(await store.isClaimDone("demo-bootstrap")); i++) await new Promise((r) => setTimeout(r, 500))
        return
      }
      try {
        const res = await seedDemoBrain(store)
        await store.finishClaim("demo-bootstrap")
        console.log(`[démo] cerveau vide amorcé avec Fournil : ${res.counts.items} connaissances, ${res.counts.events} événements.`)
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
