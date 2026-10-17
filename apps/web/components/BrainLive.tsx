"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import type { AgentEvent } from "@brain/core"
import type { DashboardState } from "@/lib/brain"
import type { Ripple, ZoneActivity } from "./BrainViz"
import { EVENT_VERB, api, firstName, uniqueZones } from "./format"

/** `restricted_reason` : « zone » (une zone de l'événement n'est pas lisible) ou « private » (événement sans zone). */
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

const Ctx = createContext<BrainLive | null>(null)

export function useBrainLive(): BrainLive {
  const v = useContext(Ctx)
  if (!v) throw new Error("useBrainLive hors de <BrainLiveProvider>")
  return v
}

/**
 * État vivant du cerveau, partagé par toutes les pages de l'application : il vit dans le layout, donc le flux SSE
 * reste ouvert d'une page à l'autre et le cerveau garde ses zones allumées.
 *
 * `now` : horodatage du rendu serveur. Le premier rendu client réutilise exactement la même valeur, sinon les dates
 * relatives (« il y a 44 minutes » / « il y a 45 minutes ») diffèrent et l'hydratation échoue.
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
    const label = e.restricted ? `${who} travaille dans cette zone` : `${who} ${EVENT_VERB[e.type]}${e.type === "query" && e.summary ? ` « ${e.summary} »` : ""}`
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

  // Le layout n'est pas re-rendu par le serveur d'une page à l'autre : après une page de configuration (onboarding,
  // accès), on relit l'état pour que le cerveau montre les zones à jour.
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
