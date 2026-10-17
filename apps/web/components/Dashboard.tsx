"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentEvent } from "@brain/core"
import type { DashboardState } from "@/lib/brain"
import { BrainViz, type Ripple, type ZoneActivity } from "./BrainViz"
import { TopBar } from "./TopBar"
import { LiveFeed } from "./LiveFeed"
import { StatusPanel } from "./StatusPanel"
import { AutomationsPanel } from "./AutomationsPanel"
import { TasksPanel } from "./TasksPanel"
import { KnowledgeList } from "./KnowledgeList"
import { ZoneDrawer } from "./ZoneDrawer"
import { AskBrain } from "./AskBrain"
import { AGENT_LABEL, api, firstName, uniqueZones } from "./format"

/** `restricted_reason` : « zone » (une zone de l'événement n'est pas lisible) ou « private » (événement sans zone). */
export type FeedEvent = AgentEvent & { restricted?: boolean; restricted_reason?: "zone" | "private"; fresh?: boolean }

const ACTIVE_MS: Record<AgentEvent["type"], number> = { query: 6500, write: 9000, started: 3500, stopped: 2000 }
const FEED_MAX = 80

const maxId = (events: { id: number }[]) => events.reduce((m, e) => Math.max(m, e.id), 0)

/** Fusionne des événements dans le fil, sans doublon, du plus récent au plus ancien. */
function mergeFeed(prev: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const known = new Set(prev.map((e) => e.id))
  const added = incoming.filter((e) => !known.has(e.id))
  if (added.length === 0) return prev
  return [...prev, ...added].sort((a, b) => b.id - a.id).slice(0, FEED_MAX)
}

/** Repli sans horodatage serveur : une valeur déterministe (identique au rendu serveur et à l'hydratation). */
function maxEventTime(events: { at: string }[]): number {
  return events.reduce((m, e) => Math.max(m, Date.parse(e.at) || 0), 0)
}

/**
 * `now` : horodatage du rendu serveur. Le premier rendu client réutilise exactement la même valeur, sinon les dates
 * relatives (« il y a 44 minutes » / « il y a 45 minutes ») diffèrent et l'hydratation échoue.
 */
export function Dashboard({ initial, now: serverNow }: { initial: DashboardState; now?: number }) {
  const [state, setState] = useState(initial)
  const [feed, setFeed] = useState<FeedEvent[]>(() => initial.events.map(uniqueZones))
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [now, setNow] = useState(() => serverNow ?? (maxEventTime(initial.events) || Date.now()))
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const namesRef = useRef(initial.names)
  namesRef.current = state.names
  // Identifiants déjà reçus. Le rendu serveur est de l'historique : il n'allume rien. Ensuite, le premier des deux
  // chemins (flux SSE ou relecture de /api/state) qui voit un événement l'ajoute au fil ET allume sa zone, l'autre
  // l'ignore : chaque événement apparaît une fois et allume sa zone une fois, quel que soit l'ordre d'arrivée.
  const seen = useRef<Set<number>>(new Set(initial.events.map((e) => e.id)))
  const lastId = useRef(maxId(initial.events))
  const rippleSeq = useRef(0)

  const ignite = useCallback((e: FeedEvent) => {
    const t = Date.now()
    const zones = [...new Set(e.zones)]
    if (zones.length === 0) return
    const who = namesRef.current[e.user_id] ? firstName(namesRef.current[e.user_id]) : "Quelqu'un"
    const label =
      e.type === "write"
        ? `${who} · ${AGENT_LABEL[e.agent]} a ajouté du contexte`
        : e.restricted
          ? `${who} · activité`
          : `${who} · ${e.summary ?? AGENT_LABEL[e.agent]}`
    setActivity((prev) => {
      const next = { ...prev }
      for (const z of zones) next[z] = { until: t + ACTIVE_MS[e.type], startedAt: t, who, label }
      return next
    })
    const keys = zones.map((z) => ({ key: `r${++rippleSeq.current}-${e.id}-${z}`, zone: z }))
    setRipples((prev) => [...prev.slice(-24), ...keys])
    setTimeout(() => setRipples((prev) => prev.filter((r) => !keys.some((k) => k.key === r.key))), 2600)
  }, [])

  /** Événements jamais vus : ajoutés au fil (animés) et allumés, du plus ancien au plus récent. Renvoie les nouveaux. */
  const receive = useCallback(
    (incoming: FeedEvent[]): FeedEvent[] => {
      const added = incoming
        .filter((e) => !seen.current.has(e.id))
        .map(uniqueZones)
        .sort((a, b) => a.id - b.id)
      if (added.length === 0) return added
      for (const e of added) seen.current.add(e.id)
      setFeed((prev) => mergeFeed(prev, added.map((e) => ({ ...e, fresh: true }))))
      for (const e of added) ignite(e)
      return added
    },
    [ignite],
  )

  const refresh = useCallback(async () => {
    try {
      const next = await api<DashboardState>("/api/state")
      namesRef.current = next.names
      setState(next)
      // Ce que le flux n'a pas encore livré (connexion lente, reconnexion) ou a manqué : ajouté et allumé ici, une fois.
      receive(next.events)
    } catch {
      /* session expirée : la prochaine navigation renverra vers /login */
    }
  }, [receive])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(refresh, 1200)
  }, [refresh])

  // Flux temps réel (SSE) : chaque événement d'agent allume sa zone.
  // `after` = dernier événement déjà affiché : rien n'est perdu entre le rendu serveur et la connexion
  // (les reconnexions automatiques reprennent ensuite via Last-Event-ID).
  useEffect(() => {
    const es = new EventSource(`/api/stream?after=${lastId.current}`)
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.addEventListener("agent", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as FeedEvent
      lastId.current = Math.max(lastId.current, e.id)
      // Une écriture que le flux est le premier à voir : les compteurs et les connaissances changent, on relit l'état.
      if (receive([e]).some((x) => x.type === "write")) scheduleRefresh()
    })
    return () => es.close()
  }, [receive, scheduleRefresh])

  useEffect(() => {
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 400)
    const poll = setInterval(refresh, 45_000)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [refresh])

  const activeAgents = new Set(feed.filter((e) => Date.parse(e.at) > now - 15 * 60_000 && e.type !== "stopped").map((e) => e.user_id)).size
  const selectedZone = state.zones.find((z) => z.id === selected) ?? null

  return (
    <div className="min-h-screen">
      <TopBar state={state} live={live} activeAgents={activeAgents} />
      <main className="mx-auto max-w-[1600px] px-4 pb-16 sm:px-6">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="panel relative min-w-0 overflow-hidden p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="panel-title">Le cerveau de {state.org.name}</div>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Chaque zone est un domaine de connaissance. Elle s&apos;allume quand un agent y cherche ou y écrit du contexte.
                </p>
              </div>
              <div className="flex gap-2 text-xs text-[var(--muted)]">
                <span className="chip mono">{state.totals.items} connaissances</span>
                <span className="chip mono">{state.people.length} personnes</span>
              </div>
            </div>
            <AskBrain me={state.me} zones={state.zones} />
            <div className="mt-2">
              <BrainViz
                zones={state.zones}
                synapses={state.synapses}
                activity={activity}
                ripples={ripples}
                now={now}
                selected={selected}
                onSelect={(z) => setSelected((s) => (s === z ? null : z))}
              />
            </div>
          </div>
          <LiveFeed events={feed} names={state.names} zones={state.zones} now={now} />
        </section>

        <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <StatusPanel status={state.status} zones={state.zones} canRefresh={state.real.role === "admin"} onRefreshed={refresh} now={now} />
          <div className="grid min-w-0 grid-cols-1 content-start gap-4">
            <AutomationsPanel automations={state.automations} names={state.names} zones={state.zones} isAdmin={state.real.role === "admin"} onChange={refresh} />
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
