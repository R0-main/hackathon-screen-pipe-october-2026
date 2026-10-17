// Job quotidien « nouvelles zones » (cron Vercel, cf. app/api/cron/new-zones) : pour une entreprise, Claude relit les
// connaissances récentes, et les zones qu'il repère sont créées tout de suite, sans validation. Les connaissances
// concernées y sont déplacées et les droits de lecture suivent (readersOfNewZone) : personne ne perd ni ne gagne en vue.
// Tout s'exécute dans le contexte d'une entreprise (runInOrg), avec la clé API du serveur : rien ne tourne sur les postes.

import {
  DEFAULT_TIMEZONE,
  NEW_ZONES_MAX_ITEMS,
  NEW_ZONES_MIN_CORPUS,
  NEW_ZONES_WINDOW_DAYS,
  MAX_ZONES,
  buildNewZonesInput,
  planNewZones,
  readersOfNewZone,
  redactText,
  type NewZoneProposal,
  type NewZonesInput,
} from "@brain/core"
import { proposeNewZones } from "@brain/core/claude"
import { getClaude } from "./ai"
import { zonesFromDraft } from "./onboarding"
import { getStore } from "./store"

export type NewZonesOutcome =
  | { status: "created"; zones: { id: string; name: string; items: number; readers: number }[] }
  | { status: "unchanged" }
  | { status: "skipped"; reason: "no_claude" | "max_zones" | "too_few_items" | "claude_error" }

export type NewZonesRun = NewZonesOutcome & { at: string }

/** Heure locale (fuseau de l'entreprise) du passage quotidien. vercel.json déclenche le job à 8 h et 9 h UTC : l'un des deux tombe à 10 h à Paris, été comme hiver. */
export const NEW_ZONES_HOUR = 10

const LOG_SETTING = "new-zones-log"
const LOG_MAX = 30

export function localHour(at = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(at)
  return Number(h)
}

export function localDay(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.BRAIN_TIMEZONE ?? DEFAULT_TIMEZONE }).format(at)
}

type Propose = (input: NewZonesInput) => Promise<NewZoneProposal[] | null>

/**
 * Un passage pour l'entreprise courante. `propose` remplace l'appel à Claude (tests). Sans clé API côté serveur, rien
 * n'est créé : une zone inventée par une heuristique, sans relecture, ferait plus de mal que de bien.
 */
export async function runNewZones(opts: { propose?: Propose } = {}): Promise<NewZonesRun> {
  const outcome = await evolve(opts.propose)
  const run: NewZonesRun = { ...outcome, at: new Date().toISOString() }
  await appendLog(run)
  return run
}

async function evolve(propose?: Propose): Promise<NewZonesOutcome> {
  const s = getStore()
  const claude = propose ? null : getClaude()
  if (!propose && !claude) return { status: "skipped", reason: "no_claude" }
  const zones = await s.listZones()
  if (zones.length >= MAX_ZONES) return { status: "skipped", reason: "max_zones" }
  const since = new Date(Date.now() - NEW_ZONES_WINDOW_DAYS * 86400_000).toISOString()
  const [items, org] = await Promise.all([s.listItems({ sinceIso: since, limit: NEW_ZONES_MAX_ITEMS }), s.getOrg()])
  if (items.length < NEW_ZONES_MIN_CORPUS) return { status: "skipped", reason: "too_few_items" }

  const input = buildNewZonesInput({ companyName: org.name, zones, items })
  const proposals = propose ? await propose(input) : await proposeNewZones(claude!, input)
  if (!proposals) return { status: "skipped", reason: "claude_error" }
  // Relu juste avant d'écrire : une zone créée entre-temps dans l'admin n'est pas doublée.
  const current = await s.listZones()
  const plans = planNewZones(proposals, input, current)
  if (plans.length === 0) return { status: "unchanged" }

  const clean = (t: string) => redactText(t).trim()
  const created = zonesFromDraft(
    { zones: plans.map((p) => ({ ...p.zone, name: clean(p.zone.name) || p.zone.name, description: clean(p.zone.description) })) },
    current,
  )
  for (const z of created) await s.upsertZone(z)

  const profiles = await s.listProfiles()
  const members = profiles.filter((p) => p.role !== "admin")
  const access = await s.listZoneAccess()
  const rows = new Map(members.map((m) => [m.id, access.filter((a) => a.user_id === m.id).map(({ zone_id, can_write }) => ({ zone_id, can_write }))]))
  const granted = new Set<string>()
  const result: { id: string; name: string; items: number; readers: number }[] = []
  for (const [k, plan] of plans.entries()) {
    const zone = created[k]
    // Droits calculés AVANT le déplacement, sur les zones d'origine : l'ordre des plans ne change rien.
    const readers = readersOfNewZone(plan, members.map((m) => ({ id: m.id, readable: (rows.get(m.id) ?? []).map((r) => r.zone_id) })))
    for (const id of readers) {
      rows.get(id)!.push({ zone_id: zone.id, can_write: true })
      granted.add(id)
    }
    const moved = await s.moveItems(plan.items.map((i) => i.id), zone.id)
    result.push({ id: zone.id, name: zone.name, items: moved, readers: readers.length })
  }
  for (const id of granted) await s.setZoneAccess(id, rows.get(id)!)

  // Le néon de la nouvelle zone s'allume, et le fil d'activité dit pourquoi. Il faut un compte : un admin de préférence.
  const actor = profiles.find((p) => p.role === "admin") ?? profiles[0]
  if (actor) {
    await s.insertEvents(
      result.map((z) => ({
        user_id: actor.id,
        agent: "job" as const,
        type: "write" as const,
        zones: [z.id],
        summary: `Nouvelle zone créée automatiquement : ${z.name} (${z.items} connaissance${z.items > 1 ? "s" : ""} rangée${z.items > 1 ? "s" : ""} ici)`,
        at: new Date().toISOString(),
      })),
    )
  }
  return { status: "created", zones: result }
}

/** Historique des passages (les 30 derniers), lisible par les admins : GET /api/admin/zones/auto. */
export async function loadNewZonesLog(): Promise<NewZonesRun[]> {
  const raw = await getStore().getOrgSetting(LOG_SETTING)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function appendLog(run: NewZonesRun) {
  const log = await loadNewZonesLog()
  await getStore().setOrgSetting(LOG_SETTING, JSON.stringify([run, ...log].slice(0, LOG_MAX)))
}
