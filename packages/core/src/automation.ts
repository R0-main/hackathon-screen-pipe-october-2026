// Détection des tâches répétitives à partir des AgentEvent « query » (prompts soumis).
// Heuristique : même personne, même prompt (empreinte), même créneau, sur au moins 3 jours.

import type { AgentEvent, AutomationSuggestion, Profile } from "./types"
import { promptFingerprint, truncate } from "./text"

export type AutomationCandidate = Omit<AutomationSuggestion, "id" | "created_at" | "status">

export const DEFAULT_TIMEZONE = "Europe/Paris"

function localParts(iso: string, timeZone: string): { day: string; minutes: number; weekday: number } {
  const d = new Date(iso)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]))
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday }
}

function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function detectAutomations(
  events: AgentEvent[],
  profiles: Pick<Profile, "id" | "name">[],
  opts: { now?: Date; timeZone?: string; minDays?: number; windowDays?: number; minutesPerRun?: number } = {},
): AutomationCandidate[] {
  const now = opts.now ?? new Date()
  const timeZone = opts.timeZone ?? DEFAULT_TIMEZONE
  const minDays = opts.minDays ?? 3
  const windowMs = (opts.windowDays ?? 21) * 86400_000
  const minutesPerRun = opts.minutesPerRun ?? 12
  const names = new Map(profiles.map((p) => [p.id, p.name]))

  const groups = new Map<string, AgentEvent[]>()
  for (const e of events) {
    if (e.type !== "query" || (e.agent !== "claude-code" && e.agent !== "codex")) continue
    if (now.getTime() - new Date(e.at).getTime() > windowMs) continue
    const fp = e.fingerprint || (e.summary ? promptFingerprint(e.summary) : "")
    if (!fp) continue
    const key = `${e.user_id}:${fp}`
    const list = groups.get(key) ?? []
    list.push(e)
    groups.set(key, list)
  }

  const out: AutomationCandidate[] = []
  for (const [key, list] of groups) {
    // Première exécution de chaque journée locale.
    const byDay = new Map<string, { minutes: number; weekday: number; e: AgentEvent }>()
    for (const e of list.sort((a, b) => a.at.localeCompare(b.at))) {
      const p = localParts(e.at, timeZone)
      if (!byDay.has(p.day)) byDay.set(p.day, { minutes: p.minutes, weekday: p.weekday, e })
    }
    const days = [...byDay.values()]
    if (days.length < minDays) continue
    // Même créneau : au moins 80 % des journées à ±40 min de l'heure médiane.
    const mins = days.map((d) => d.minutes)
    const med = median(mins)
    const onSlot = mins.filter((m) => Math.abs(m - med) <= 40).length
    if (onSlot < minDays || onSlot / days.length < 0.8) continue

    const [userId] = key.split(":")
    const person = names.get(userId) ?? "Quelqu'un"
    const sample = list.find((e) => e.summary)?.summary ?? "ce prompt"
    const zoneCounts = new Map<string, number>()
    for (const e of list) for (const z of e.zones) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1)
    const zone = [...zoneCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const at = hhmm(med - 5)
    const plan = planSchedule(days, at)

    out.push({
      key: `heuristic:${key}`,
      user_id: userId,
      zone,
      title: `Automatiser « ${truncate(sample, 70)} »`,
      description:
        `${person} lance ce prompt ${plan.rhythm} vers ${hhmm(med)} ` +
        `(${list.length} fois sur ${days.length} jours). Proposition : l'exécuter automatiquement ${plan.schedule.toLowerCase()} ` +
        `et lui livrer le résultat à son arrivée, pour libérer son début de journée.`,
      schedule: plan.schedule,
      evidence: { occurrences: list.length, days: days.length, sample: truncate(sample, 200), times: days.map((d) => hhmm(d.minutes)) },
      minutes_saved_per_week: plan.runsPerWeek * minutesPerRun,
      source: "heuristic",
    })
  }
  return out.sort((a, b) => b.minutes_saved_per_week - a.minutes_saved_per_week || b.evidence.days - a.evidence.days)
}

const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"]

function joinFr(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`
}

/**
 * Rythme et créneau proposés, tirés du nombre réel d'exécutions par semaine : on ne propose « du lundi au vendredi »
 * qu'à partir de 4 jours par semaine environ ; en dessous, les jours de la semaine les plus fréquents.
 */
export function planSchedule(
  days: { weekday: number; e: { at: string } }[],
  at: string,
): { schedule: string; rhythm: string; runsPerWeek: number } {
  const perWeek = (days.length / spanDays(days.map((d) => d.e.at))) * 7
  const counts = new Map<number, number>()
  for (const d of days) counts.set(d.weekday, (counts.get(d.weekday) ?? 0) + 1)
  if (counts.size === 1) {
    const day = WEEKDAYS_FR[days[0].weekday]
    return { schedule: `Chaque ${day} à ${at}`, rhythm: `chaque ${day}`, runsPerWeek: 1 }
  }
  if (perWeek >= 3.5) return { schedule: `Du lundi au vendredi à ${at}`, rhythm: "presque chaque jour", runsPerWeek: Math.min(5, Math.round(perWeek)) }
  // Les semaines entamées gonflent l'estimation : jamais plus de créneaux que de jours de la semaine réellement utilisés.
  const runsPerWeek = Math.max(1, Math.min(counts.size, Math.round(perWeek)))
  // Jours les plus fréquents (à égalité, dans l'ordre de la semaine, lundi d'abord), puis remis dans l'ordre de la semaine.
  const order = (wd: number) => (wd + 6) % 7
  const chosen = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))
    .slice(0, runsPerWeek)
    .map(([wd]) => wd)
    .sort((a, b) => order(a) - order(b))
  return {
    schedule: `Chaque ${joinFr(chosen.map((wd) => WEEKDAYS_FR[wd]))} à ${at}`,
    rhythm: runsPerWeek === 1 ? "environ une fois par semaine" : `environ ${runsPerWeek} fois par semaine`,
    runsPerWeek,
  }
}

function spanDays(isos: string[]): number {
  const ts = isos.map((s) => new Date(s).getTime())
  return Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 86400_000) + 1)
}
