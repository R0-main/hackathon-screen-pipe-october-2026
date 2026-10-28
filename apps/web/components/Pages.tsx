"use client"

import { useMemo } from "react"
import { useBrainLive } from "./BrainLive"
import { PageScroll } from "./AppShell"
import { StatusPanel } from "./StatusPanel"
import { KnowledgeList, type ItemWithDocuments, type KnowledgeFilters } from "./KnowledgeList"
import { peopleLooks } from "./PersonDot"
import { TasksPanel } from "./TasksPanel"
import { AutomationsPanel } from "./AutomationsPanel"

/** Secondary pages: each reads the live state shared by the layout (SSE stream already open) and carries its panel's title. */

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
        hasClaude={state.claude}
        onRefreshed={refresh}
        now={now}
      />
    </PageScroll>
  )
}

/**
 * `items`: the knowledge read by the page (far more than the live state's 30); those that arrive afterwards through
 * the live state are added at the top.
 */
export function KnowledgeView({ items, limit, initial }: { items: ItemWithDocuments[]; limit: number; initial?: KnowledgeFilters }) {
  const { state, now } = useBrainLive()
  const merged = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]))
    // The live state's version wins, its documents too (the page's are kept if it has none).
    for (const i of state.items) byId.set(i.id, { ...byId.get(i.id), ...i })
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
