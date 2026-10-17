"use client"

import { useBrainLive } from "./BrainLive"
import { PageScroll } from "./AppShell"
import { LiveFeed } from "./LiveFeed"
import { StatusPanel } from "./StatusPanel"
import { KnowledgeList } from "./KnowledgeList"
import { TasksPanel } from "./TasksPanel"
import { AutomationsPanel } from "./AutomationsPanel"

/** Pages secondaires : chacune lit l'état vivant partagé par le layout (flux SSE déjà ouvert) et porte le titre de son panneau. */

export function ActivityView() {
  const { state, feed, now } = useBrainLive()
  return (
    <PageScroll width="max-w-[900px]">
      <LiveFeed events={feed} names={state.names} zones={state.zones} now={now} />
    </PageScroll>
  )
}

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
