"use client"

import { useBrainLive } from "./BrainLive"
import { PageScroll } from "./AppShell"
import { StatusPanel } from "./StatusPanel"
import { KnowledgeList } from "./KnowledgeList"
import { TasksPanel } from "./TasksPanel"
import { AutomationsPanel } from "./AutomationsPanel"

/** Secondary pages: each reads the live state shared by the layout (SSE stream already open) and carries its panel's title. */

export function StatusView() {
  const { state, now, refresh } = useBrainLive()
  return (
    <PageScroll>
      <StatusPanel status={state.status} zones={state.zones} canRefresh={state.real.role === "admin"} onRefreshed={refresh} now={now} />
    </PageScroll>
  )
}

export function KnowledgeView() {
  const { state, now } = useBrainLive()
  return (
    <PageScroll>
      <KnowledgeList items={state.items} names={state.names} zones={state.zones} now={now} />
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
