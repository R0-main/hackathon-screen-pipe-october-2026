"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import type { AgentEvent } from "@brain/core"
import type { DashboardState } from "@/lib/brain"
import type { Ripple, ZoneActivity } from "./BrainViz"
import { EVENT_VERB, api, firstName, uniqueZones } from "./format"

/** `restricted_reason`: "zone" (one of the event's zones is not readable) or "private" (event without a zone). */
export type FeedEvent = AgentEvent & { restricted?: boolean; restricted_reason?: "zone" | "private"; fresh?: boolean }

type BrainLive = {
  state: DashboardState
  feed: FeedEvent[]
  activity: Record<string, ZoneActivity>
  ripples: Ripple[]
  now: number
  live: boolean
  activeAgents: number
  refresh: () => Promise<void>
}

const ACTIVE_MS: Record<AgentEvent["type"], number> = { query: 6500, write: 9000, started: 3500, stopped: 2000 }
const FEED_MAX = 80

const maxId = (events: { id: number }[]) => events.reduce((m, e) => Math.max(m, e.id), 0)

/** Merges events into the feed, without duplicates, from most recent to oldest. */
function mergeFeed(prev: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const known = new Set(prev.map((e) => e.id))
  const added = incoming.filter((e) => !known.has(e.id))
  if (added.length === 0) return prev
  return [...prev, ...added].sort((a, b) => b.id - a.id).slice(0, FEED_MAX)
}

/** Fallback without a server timestamp: a deterministic value (identical for the server render and hydration). */
function maxEventTime(events: { at: string }[]): number {
  return events.reduce((m, e) => Math.max(m, Date.parse(e.at) || 0), 0)
}

const Ctx = createContext<BrainLive | null>(null)

export function useBrainLive(): BrainLive {
  const v = useContext(Ctx)
  if (!v) throw new Error("useBrainLive outside <BrainLiveProvider>")
  return v
}

/**
 * Live state of the brain, shared by all the app's pages: it lives in the layout, so the SSE stream
 * stays open from one page to the next and the brain keeps its zones lit.
 *
 * `now`: timestamp of the server render. The first client render reuses exactly the same value, otherwise relative
 * dates ("44 minutes ago" / "45 minutes ago") differ and hydration fails.
 */
export function BrainLiveProvider({ initial, now: serverNow, children }: { initial: DashboardState; now?: number; children: ReactNode }) {
  const [state, setState] = useState(initial)
  const [feed, setFeed] = useState<FeedEvent[]>(() => initial.events.map(uniqueZones))
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [now, setNow] = useState(() => serverNow ?? (maxEventTime(initial.events) || Date.now()))
  const [live, setLive] = useState(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const namesRef = useRef(initial.names)
  namesRef.current = state.names
  // Ids already received. The server render is history: it lights nothing. Then, the first of the two
  // paths (SSE stream or /api/state re-read) that sees an event adds it to the feed AND lights its zone, the other
  // ignores it: each event appears once and lights its zone once, whatever the order of arrival.
  const seen = useRef<Set<number>>(new Set(initial.events.map((e) => e.id)))
  const lastId = useRef(maxId(initial.events))
  const rippleSeq = useRef(0)

  const ignite = useCallback((e: FeedEvent) => {
    const t = Date.now()
    const zones = [...new Set(e.zones)]
    if (zones.length === 0) return
    const who = namesRef.current[e.user_id] ? firstName(namesRef.current[e.user_id]) : "Someone"
    const label = e.restricted ? `${who} is working in this zone` : `${who} ${EVENT_VERB[e.type]}${e.type === "query" && e.summary ? ` “${e.summary}”` : ""}`
    setActivity((prev) => {
      const next = { ...prev }
      for (const z of zones) next[z] = { until: t + ACTIVE_MS[e.type], startedAt: t, who, label }
      return next
    })
    const keys = zones.map((z) => ({ key: `r${++rippleSeq.current}-${e.id}-${z}`, zone: z }))
    setRipples((prev) => [...prev.slice(-24), ...keys])
    setTimeout(() => setRipples((prev) => prev.filter((r) => !keys.some((k) => k.key === r.key))), 2600)
  }, [])

  /** Events never seen: added to the feed (animated) and lit, from oldest to most recent. Returns the new ones. */
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
      // What the stream has not delivered yet (slow connection, reconnection) or missed: added and lit here, once.
      receive(next.events)
    } catch {
      /* session expired: the next navigation will go to /login */
    }
  }, [receive])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(refresh, 1200)
  }, [refresh])

  // Real-time stream (SSE): each agent event lights its zone.
  // `after` = last event already shown: nothing is lost between the server render and the connection
  // (automatic reconnections then resume through Last-Event-ID).
  useEffect(() => {
    const es = new EventSource(`/api/stream?after=${lastId.current}`)
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.addEventListener("agent", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as FeedEvent
      lastId.current = Math.max(lastId.current, e.id)
      // A write the stream is the first to see: counters and knowledge change, the state is re-read.
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

  // The layout is not re-rendered by the server from one page to the next: after a configuration page (onboarding,
  // access), the state is re-read so the brain shows the up-to-date zones.
  const pathname = usePathname()
  const firstPath = useRef(true)
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false
      return
    }
    refresh()
  }, [pathname, refresh])

  const activeAgents = new Set(feed.filter((e) => Date.parse(e.at) > now - 15 * 60_000 && e.type !== "stopped").map((e) => e.user_id)).size

  return <Ctx.Provider value={{ state, feed, activity, ripples, now, live, activeAgents, refresh }}>{children}</Ctx.Provider>
}
