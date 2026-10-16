"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentEvent } from "@brain/core"
import type { DashboardState } from "@/lib/brain"
import type { Ripple, ZoneActivity } from "./BrainViz"
import { Brain3D } from "./Brain3D"
import { TopBar } from "./TopBar"
import { LiveFeed } from "./LiveFeed"
import { StatusPanel } from "./StatusPanel"
import { AutomationsPanel } from "./AutomationsPanel"
import { TasksPanel } from "./TasksPanel"
import { KnowledgeList } from "./KnowledgeList"
import { ZoneDrawer } from "./ZoneDrawer"
import { AskBrain } from "./AskBrain"
import { EVENT_VERB, api, firstName } from "./format"

export type FeedEvent = AgentEvent & { restricted?: boolean; fresh?: boolean }

const ACTIVE_MS: Record<AgentEvent["type"], number> = { query: 6500, write: 9000, started: 3500, stopped: 2000 }

export function Dashboard({ initial }: { initial: DashboardState }) {
  const [state, setState] = useState(initial)
  const [feed, setFeed] = useState<FeedEvent[]>(initial.events)
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const namesRef = useRef(initial.names)
  namesRef.current = state.names

  const refresh = useCallback(async () => {
    try {
      setState(await api<DashboardState>("/api/state"))
    } catch {
      /* session expirée : la prochaine navigation renverra vers /login */
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(refresh, 1200)
  }, [refresh])

  const ignite = useCallback((e: FeedEvent) => {
    const t = Date.now()
    if (e.zones.length === 0) return
    const who = namesRef.current[e.user_id] ? firstName(namesRef.current[e.user_id]) : "Quelqu'un"
    const label = e.restricted ? `${who} travaille dans cette zone` : `${who} ${EVENT_VERB[e.type]}${e.type === "query" && e.summary ? ` « ${e.summary} »` : ""}`
    setActivity((prev) => {
      const next = { ...prev }
      for (const z of e.zones) next[z] = { until: t + ACTIVE_MS[e.type], startedAt: t, who, label }
      return next
    })
    const keys = e.zones.map((z) => ({ key: `${e.id}-${z}-${t}`, zone: z }))
    setRipples((prev) => [...prev.slice(-24), ...keys])
    setTimeout(() => setRipples((prev) => prev.filter((r) => !keys.some((k) => k.key === r.key))), 2600)
  }, [])

  // Flux temps réel (SSE) : chaque événement d'agent allume sa zone.
  useEffect(() => {
    const es = new EventSource("/api/stream")
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.addEventListener("agent", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as FeedEvent
      setFeed((prev) => (prev.some((p) => p.id === e.id) ? prev : [{ ...e, fresh: true }, ...prev].slice(0, 80)))
      ignite(e)
      if (e.type === "write") scheduleRefresh()
    })
    return () => es.close()
  }, [ignite, scheduleRefresh])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 400)
    const poll = setInterval(refresh, 45_000)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [refresh])

  const activeAgents = new Set(feed.filter((e) => Date.parse(e.at) > now - 15 * 60_000 && e.type !== "stopped").map((e) => e.user_id)).size
  const selectedZone = state.zones.find((z) => z.id === selected) ?? null
  const isAdmin = state.real.role === "admin"

  return (
    <div className="min-h-dvh">
      <TopBar state={state} live={live} activeAgents={activeAgents} />
      <main className="mx-auto max-w-[1600px] px-4 pb-16 pt-4 sm:px-6">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="panel relative min-w-0 overflow-hidden p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="panel-title">Zones de connaissance</h2>
                <p className="mt-1 max-w-2xl text-[13px] text-trace">
                  Chaque zone est un domaine de l&apos;entreprise. Elle s&apos;allume quand un agent y cherche ou y écrit du contexte. Cliquez une zone pour l&apos;ouvrir.
                </p>
              </div>
              <div className="flex gap-1.5 text-[12px]">
                <span className="chip tabular-nums">{state.totals.items} connaissances</span>
                <span className="chip tabular-nums">{state.people.length} personnes</span>
              </div>
            </div>
            <AskBrain me={state.me} zones={state.zones} />
            <div className="mt-3">
              {state.zones.length === 0 ? (
                <div className="inset p-8 text-center">
                  <p className="text-[13px] text-trace">Le cerveau n&apos;a pas encore de zones.</p>
                  {isAdmin && (
                    <Link href="/onboarding" className="btn btn-primary mt-3">
                      Lancer l&apos;onboarding
                    </Link>
                  )}
                </div>
              ) : (
                <Brain3D
                  zones={state.zones}
                  synapses={state.synapses}
                  activity={activity}
                  ripples={ripples}
                  now={now}
                  selected={selected}
                  onSelect={(z) => setSelected((s) => (s === z ? null : z))}
                />
              )}
            </div>
          </div>
          <LiveFeed events={feed} names={state.names} zones={state.zones} now={now} />
        </section>

        <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <StatusPanel status={state.status} zones={state.zones} canRefresh={isAdmin} onRefreshed={refresh} />
          <div className="grid min-w-0 grid-cols-1 content-start gap-4">
            <AutomationsPanel automations={state.automations} names={state.names} zones={state.zones} isAdmin={isAdmin} onChange={refresh} />
            <TasksPanel tasks={state.tasks} names={state.names} zones={state.zones} onChange={refresh} />
          </div>
        </section>

        <section className="mt-4">
          <KnowledgeList items={state.items} names={state.names} zones={state.zones} now={now} />
        </section>
      </main>
      {selectedZone && <ZoneDrawer zone={selectedZone} onClose={() => setSelected(null)} />}
    </div>
  )
}
