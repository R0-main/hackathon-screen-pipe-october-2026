"use client"

import type { ZoneView } from "@/lib/brain"
import type { FeedEvent } from "./Dashboard"
import { AGENT_LABEL, EVENT_VERB, initials, relativeTime } from "./format"

export function LiveFeed({ events, names, zones, now }: { events: FeedEvent[]; names: Record<string, string>; zones: ZoneView[]; now: number }) {
  const color = (z: string) => zones.find((x) => x.id === z)?.color ?? "#94a3b8"
  const zoneName = (z: string) => zones.find((x) => x.id === z)?.name ?? z
  return (
    <aside className="panel flex max-h-[760px] min-h-[420px] flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="panel-title">Agents en direct</div>
        <span className="text-[11px] text-[var(--faint)]">hooks · MCP · brain-sync</span>
      </div>
      <ol className="scroll-thin flex-1 space-y-1 overflow-y-auto p-2">
        {events.length === 0 && <li className="p-6 text-center text-sm text-[var(--muted)]">Aucune activité pour l&apos;instant.</li>}
        {events.map((e) => {
          const name = names[e.user_id] ?? "Quelqu'un"
          const main = e.zones[0]
          return (
            <li key={e.id} className={`rounded-xl px-3 py-2 ${e.fresh ? "feed-enter" : ""} hover:bg-[var(--panel-strong)]`}>
              <div className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10.5px] font-bold"
                  style={{ background: `${main ? color(main) : "#94a3b8"}22`, color: main ? color(main) : "#cbd5e1", boxShadow: e.fresh ? `0 0 14px ${main ? color(main) : "#94a3b8"}66` : undefined }}
                >
                  {initials(name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] leading-snug">
                    <b className="font-semibold">{name.split(" ")[0]}</b>{" "}
                    <span className="text-[var(--muted)]">{EVENT_VERB[e.type]}</span>
                    {e.type === "query" && e.summary && !e.restricted && <span className="text-[var(--text)]"> « {e.summary} »</span>}
                    {e.type === "write" && e.summary && !e.restricted && <span className="text-[var(--muted)]"> — {e.summary}</span>}
                    {e.restricted && <span className="italic text-[var(--faint)]"> dans une zone restreinte</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--faint)]">
                    <span className="chip !py-0">{AGENT_LABEL[e.agent]}</span>
                    {e.zones.map((z) => (
                      <span key={z} className="chip !py-0" style={{ borderColor: `${color(z)}55`, color: color(z) }}>
                        {zoneName(z)}
                      </span>
                    ))}
                    <span className="ml-auto mono">{relativeTime(e.at, now)}</span>
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
