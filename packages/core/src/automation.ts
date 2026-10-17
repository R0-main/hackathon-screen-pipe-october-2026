// Detection of repetitive tasks from "query" AgentEvents (submitted prompts).
// Heuristic: same person, same prompt (fingerprint), same time slot, on at least 3 days.

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
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
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
    // First run of each local day.
    const byDay = new Map<string, { minutes: number; weekday: number; e: AgentEvent }>()
    for (const e of list.sort((a, b) => a.at.localeCompare(b.at))) {
      const p = localParts(e.at, timeZone)
      if (!byDay.has(p.day)) byDay.set(p.day, { minutes: p.minutes, weekday: p.weekday, e })
    }
    const days = [...byDay.values()]
    if (days.length < minDays) continue
    // Same slot: at least 80% of the days within ±40 min of the median time.
    const mins = days.map((d) => d.minutes)
    const med = median(mins)
    const onSlot = mins.filter((m) => Math.abs(m - med) <= 40).length
    if (onSlot < minDays || onSlot / days.length < 0.8) continue

    const [userId] = key.split(":")
    const person = names.get(userId) ?? "Someone"
    const sample = list.find((e) => e.summary)?.summary ?? "this prompt"
    const zoneCounts = new Map<string, number>()
    for (const e of list) for (const z of e.zones) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1)
    const zone = [...zoneCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const at = hhmm(med - 5)
    const plan = planSchedule(days, at)

    out.push({
      key: `heuristic:${key}`,
      user_id: userId,
      zone,
      title: `Automate "${truncate(sample, 70)}"`,
      description:
        `${person} runs this prompt ${plan.rhythm} around ${hhmm(med)} ` +
        `(${list.length} times over ${days.length} days). Suggestion: run it automatically ${lowerFirst(plan.schedule)} ` +
        `and have the result waiting when they arrive, to free up the start of their day.`,
      schedule: plan.schedule,
      evidence: { occurrences: list.length, days: days.length, sample: truncate(sample, 200), times: days.map((d) => hhmm(d.minutes)) },
      minutes_saved_per_week: plan.runsPerWeek * minutesPerRun,
      source: "heuristic",
    })
  }
  return out.sort((a, b) => b.minutes_saved_per_week - a.minutes_saved_per_week || b.evidence.days - a.evidence.days)
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** "Every Monday at 09:00" → "every Monday at 09:00" (day names keep their capital). */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function joinList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`
}

/**
 * Suggested rhythm and slot, from the real number of runs per week: "Monday to Friday" is only suggested
 * from about 4 days a week; below that, the most frequent weekdays.
 */
export function planSchedule(
  days: { weekday: number; e: { at: string } }[],
  at: string,
): { schedule: string; rhythm: string; runsPerWeek: number } {
  const perWeek = (days.length / spanDays(days.map((d) => d.e.at))) * 7
  const counts = new Map<number, number>()
  for (const d of days) counts.set(d.weekday, (counts.get(d.weekday) ?? 0) + 1)
  if (counts.size === 1) {
    const day = WEEKDAYS[days[0].weekday]
    return { schedule: `Every ${day} at ${at}`, rhythm: `every ${day}`, runsPerWeek: 1 }
  }
  if (perWeek >= 3.5) return { schedule: `Monday to Friday at ${at}`, rhythm: "almost every day", runsPerWeek: Math.min(5, Math.round(perWeek)) }
  // Partial weeks inflate the estimate: never more slots than weekdays actually used.
  const runsPerWeek = Math.max(1, Math.min(counts.size, Math.round(perWeek)))
  // Most frequent days (ties in weekday order, Monday first), then put back in weekday order.
  const order = (wd: number) => (wd + 6) % 7
  const chosen = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))
    .slice(0, runsPerWeek)
    .map(([wd]) => wd)
    .sort((a, b) => order(a) - order(b))
  return {
    schedule: `Every ${joinList(chosen.map((wd) => WEEKDAYS[wd]))} at ${at}`,
    rhythm: runsPerWeek === 1 ? "about once a week" : `about ${runsPerWeek} times a week`,
    runsPerWeek,
  }
}

function spanDays(isos: string[]): number {
  const ts = isos.map((s) => new Date(s).getTime())
  return Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 86400_000) + 1)
}
