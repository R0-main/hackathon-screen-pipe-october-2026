// Résumé « état de l'entreprise » sans LLM (repli de la version Claude).

import type { CompanyStatus, KnowledgeItem, Profile, Task, Zone, ZoneStatus } from "./types"
import { truncate } from "./text"

const OBJECTIVE_RE = /\b(objectif|objectifs|okr|goal|cible|vise|viser|d'ici|target)\b/i

export function heuristicStatus(input: {
  zones: Zone[]
  items: KnowledgeItem[]
  tasks: Task[]
  profiles: Pick<Profile, "id" | "name">[]
  now?: Date
}): CompanyStatus {
  const now = input.now ?? new Date()
  const weekAgo = now.getTime() - 7 * 86400_000
  const names = new Map(input.profiles.map((p) => [p.id, p.name]))
  const zones: ZoneStatus[] = []
  let weekCount = 0
  let decisions = 0
  let busiest: { zone: string; n: number } | null = null

  for (const z of input.zones) {
    const items = input.items.filter((i) => i.zone === z.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
    const recent = items.filter((i) => new Date(i.created_at).getTime() >= weekAgo)
    const tasks = input.tasks.filter((t) => t.zone === z.id)
    const open = tasks.filter((t) => t.status === "open")
    const done = tasks.filter((t) => t.status === "done")
    weekCount += recent.length
    decisions += recent.filter((i) => i.kind === "decision").length
    if (!busiest || recent.length > busiest.n) busiest = { zone: z.name, n: recent.length }

    const objectives = items
      .filter((i) => OBJECTIVE_RE.test(`${i.title} ${i.body}`))
      .slice(0, 2)
      .map((i) => truncate(i.title, 110))

    const byAuthor = new Map<string, KnowledgeItem[]>()
    for (const i of recent) byAuthor.set(i.author_id, [...(byAuthor.get(i.author_id) ?? []), i])
    const who_did_what = [...byAuthor.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)
      .map(([author, list]) => ({
        person: names.get(author) ?? "Inconnu",
        did: `${list.length} contribution${list.length > 1 ? "s" : ""}, dont « ${truncate(list[0].title, 70)} »`,
      }))

    const lastDecision = items.find((i) => i.kind === "decision")
    const summary =
      items.length === 0
        ? "Aucune connaissance pour l'instant."
        : `${items.length} connaissances, ${recent.length} cette semaine.` +
          (lastDecision ? ` Dernière décision : ${truncate(lastDecision.title, 100)}.` : "")

    zones.push({
      zone: z.id,
      summary,
      objectives,
      progress: tasks.length ? `${done.length}/${tasks.length} tâches terminées` : recent.length ? "Activité régulière, pas de tâche suivie" : "Calme",
      next_steps: open.slice(0, 3).map((t) => truncate(t.title, 110)),
      who_did_what,
    })
  }

  const openTasks = input.tasks.filter((t) => t.status === "open").length
  const headline =
    `${weekCount} nouvelles connaissances cette semaine, ${decisions} décision${decisions > 1 ? "s" : ""}, ` +
    `${openTasks} tâche${openTasks > 1 ? "s" : ""} ouverte${openTasks > 1 ? "s" : ""}.` +
    (busiest && busiest.n > 0 ? ` Zone la plus active : ${busiest.zone}.` : "")

  return { headline, zones, generated_at: now.toISOString(), generator: "heuristic" }
}
