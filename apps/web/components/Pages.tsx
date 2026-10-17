"use client"

import { useMemo } from "react"
import type { KnowledgeItem } from "@brain/core"
import { useBrainLive } from "./BrainLive"
import { PageScroll } from "./AppShell"
import { StatusPanel } from "./StatusPanel"
import { KnowledgeList, type KnowledgeFilters } from "./KnowledgeList"
import { peopleLooks } from "./PersonDot"
import { TasksPanel } from "./TasksPanel"
import { AutomationsPanel } from "./AutomationsPanel"

/** Pages secondaires : chacune lit l'état vivant partagé par le layout (flux SSE déjà ouvert) et porte le titre de son panneau. */

export function StatusView() {
  const { state, now, refresh } = useBrainLive()
  return (
    <PageScroll>
      <StatusPanel
        status={state.status}
        zones={state.zones}
        people={state.people}
        tasks={state.tasks}
        taskCounts={state.task_counts}
        canRefresh={state.real.role === "admin"}
        onRefreshed={refresh}
        now={now}
      />
    </PageScroll>
  )
}

/**
 * `items` : les connaissances lues par la page (bien plus que les 30 de l'état vivant) ; celles qui arrivent ensuite
 * par l'état vivant s'y ajoutent en tête.
 */
export function KnowledgeView({ items, limit, initial }: { items: KnowledgeItem[]; limit: number; initial?: KnowledgeFilters }) {
  const { state, now } = useBrainLive()
  const merged = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]))
    for (const i of state.items) byId.set(i.id, i)
    return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [items, state.items])
  return (
    <PageScroll width="max-w-[960px]">
      <KnowledgeList items={merged} names={state.names} zones={state.zones} looks={peopleLooks(state)} now={now} initial={initial} limit={limit} />
    </PageScroll>
  )
}

export function TasksView() {
  const { state, refresh } = useBrainLive()
  return (
    <PageScroll width="max-w-[900px]">
      <TasksPanel tasks={state.tasks} names={state.names} zones={state.zones} onChange={refresh} />
    </PageScroll>
  )
}

export function AutomationsView() {
  const { state, refresh } = useBrainLive()
  return (
    <PageScroll width="max-w-[900px]">
      <AutomationsPanel automations={state.automations} names={state.names} zones={state.zones} isAdmin={state.real.role === "admin"} onChange={refresh} />
    </PageScroll>
  )
}
