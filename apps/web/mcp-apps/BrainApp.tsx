// show_brain: the dashboard's 3D brain in the conversation. The zones light up as the team's agents work: the view
// asks its MCP server for the new events every few seconds (brain_activity), as the dashboard does with its stream.

import { useCallback, useEffect, useRef, useState } from "react"
import type { App } from "@modelcontextprotocol/ext-apps"
import { Brain3D } from "@/components/Brain3D"
import type { Ripple, ZoneActivity } from "@/components/BrainViz"
import { EVENT_VERB, firstName, uniqueZones } from "@/components/format"
import { Dot, zoneColor } from "@/components/ui"
import type { ActivityPayload, BrainEvent, BrainPayload } from "./types"

const POLL_MS = 4000
/** Same durations as the dashboard (BrainLive). */
const ACTIVE_MS: Record<BrainEvent["type"], number> = { query: 6500, write: 9000, started: 3500, stopped: 2000 }
const INLINE_H = 520

export function BrainApp({ app, data, fullscreen }: { app: App; data: BrainPayload; fullscreen: boolean }) {
  const [events, setEvents] = useState<BrainEvent[]>(data.events)
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<string | null>(null)
  const names = useRef(data.names)
  const lastId = useRef(data.events.reduce((m, e) => Math.max(m, e.id), 0))
  const seq = useRef(0)

  // An event received live lights its zones, with the agent's label, like on the dashboard.
  const ignite = useCallback((e: BrainEvent) => {
    const zones = [...new Set(e.zones)]
    if (!zones.length) return
    const t = Date.now()
    const who = names.current[e.user_id] ? firstName(names.current[e.user_id]) : "Someone"
    const label = e.restricted ? `${who} is working in this zone` : `${who} ${EVENT_VERB[e.type]}${e.type === "query" && e.summary ? ` “${e.summary}”` : ""}`
    setActivity((prev) => Object.fromEntries([...Object.entries(prev), ...zones.map((z) => [z, { until: t + ACTIVE_MS[e.type], startedAt: t, who, label }])]))
    const keys = zones.map((zone) => ({ key: `r${++seq.current}-${e.id}-${zone}`, zone }))
    setRipples((prev) => [...prev.slice(-24), ...keys])
    setTimeout(() => setRipples((prev) => prev.filter((r) => !keys.some((k) => k.key === r.key))), 2600)
  }, [])

  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await app.callServerTool({ name: "brain_activity", arguments: { after: lastId.current } })
        const p = r.structuredContent as ActivityPayload | undefined
        if (stop || !p?.events.length) return
        names.current = { ...names.current, ...p.names }
        const fresh = p.events.filter((e) => e.id > lastId.current).map(uniqueZones).sort((a, b) => a.id - b.id)
        if (!fresh.length) return
        lastId.current = fresh[fresh.length - 1].id
        setEvents((prev) => [...fresh.slice().reverse(), ...prev].slice(0, 80))
        for (const e of fresh) ignite(e)
      } catch {
        // the host is closing the view, or the brain does not answer: next try in a few seconds
      }
    }
    const id = setInterval(poll, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 400)
    return () => {
      stop = true
      clearInterval(id)
      clearInterval(tick)
    }
  }, [app, ignite])

  // Same rule as the dashboard: a dot breathes if its agent worked in the last 15 minutes, bounces if it touches the brain now.
  const working = new Set(events.filter((e) => e.type !== "stopped" && Date.parse(e.at) > now - 15 * 60_000).map((e) => e.user_id))
  const live = new Set(events.filter((e) => (e.type === "query" || e.type === "write") && Date.parse(e.at) > now - 8000).map((e) => e.user_id))
  const people = data.people.map((p) => ({ ...p, working: working.has(p.id), live: live.has(p.id), me: p.id === data.me }))
  const zone = data.zones.find((z) => z.id === selected) ?? null

  if (!data.zones.length) return <p className="px-4 py-6 text-[13px] text-trace">The brain has no zones yet: an admin starts the onboarding from the dashboard.</p>

  return (
    <div className="relative w-full overflow-hidden" style={{ height: fullscreen ? "100%" : INLINE_H }}>
      <Brain3D
        zones={data.zones}
        synapses={data.synapses}
        activity={activity}
        ripples={ripples}
        now={now}
        selected={selected}
        onSelect={(z) => setSelected((s) => (s === z ? null : z))}
        people={people}
      />
      <div className="pointer-events-none absolute right-3 top-3 flex gap-1.5 text-[12px]">
        <span className="chip tabular-nums">{data.totals.items} knowledge items</span>
        <span className="chip tabular-nums">{working.size} active</span>
      </div>
      {zone && (
        <aside className="panel absolute bottom-3 left-3 w-[min(320px,calc(100%-1.5rem))] p-4" aria-label={`Zone ${zone.name}`}>
          <div className="flex items-center gap-2">
            <Dot color={zoneColor(zone.color, zone.position)} size={8} />
            <h2 className="text-[14px] font-medium">{zone.name}</h2>
          </div>
          {zone.locked ? (
            <p className="mt-2 text-[13px] text-trace">You do not have access to this zone.</p>
          ) : (
            <>
              <p className="mt-1.5 text-[13px] leading-snug text-trace">{zone.description}</p>
              <p className="mt-2 text-[12px] tabular-nums text-trace">
                {zone.count} knowledge items · {zone.contributors} contributors
              </p>
              {zone.entities.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 text-[12px]">
                  {zone.entities.slice(0, 6).map((e) => (
                    <span key={`${e.type}:${e.name}`} className="chip">
                      {e.name}
                    </span>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary btn-sm mt-3"
                onClick={() => void app.sendMessage({ role: "user", content: [{ type: "text", text: `Where does the ${zone.name} zone stand? Use get_zone_summary.` }] }).catch(() => {})}
              >
                Ask Claude about {zone.name}
              </button>
            </>
          )}
        </aside>
      )}
    </div>
  )
}
