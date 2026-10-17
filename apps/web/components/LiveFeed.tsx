"use client"

import type { ZoneView } from "@/lib/brain"
import type { FeedEvent } from "./BrainLive"
import { AGENT_LABEL, EVENT_VERB } from "./format"
import { PersonAvatar } from "./PersonDot"
import { RelTime } from "./RelTime"
import { ZoneTag, zoneColor } from "./ui"

/**
 * Why an event's content is hidden: "zone" (one of its zones is not readable) or "private"
 * (event without a zone: personal prompt, search outside your zones…). A private session start or stop
 * shows nothing more (only the session id is hidden). Fallback for old events without a reason.
 */
function hiddenReason(e: FeedEvent): "zone" | "private" | null {
  if (!e.restricted) return null
  const reason = e.restricted_reason ?? (e.zones.length ? "zone" : "private")
  if (reason === "private" && (e.type === "started" || e.type === "stopped")) return null
  return reason
}

/**
 * The agents feed, laid over the brain: you read the event while its zone lights up. A zone in the feed opens its
 * drawer. Wide screen: column on the right, open. Smaller: strip at the bottom, collapsed until the first click.
 * `open` null: open on a wide screen, collapsed otherwise (decided in CSS, hence identical to the server render).
 */
export function LiveFeed({
  events,
  names,
  zones,
  now,
  onZone,
  open,
  onOpenChange,
}: {
  events: FeedEvent[]
  names: Record<string, string>
  zones: ZoneView[]
  now: number
  onZone: (id: string) => void
  open: boolean | null
  onOpenChange: (open: boolean) => void
}) {
  const zone = (id: string) => zones.find((x) => x.id === id)
  const recent = events.filter((e) => Date.parse(e.at) > now - 15 * 60_000).length
  const listCls = open === null ? "hidden xl:block" : open ? "block" : "hidden"
  const toggle = () => onOpenChange(!(open ?? window.matchMedia("(min-width: 1280px)").matches))

  return (
    <aside
      className={`panel pointer-events-auto absolute bottom-4 left-4 right-16 z-10 flex max-h-[45%] flex-col xl:left-auto xl:right-4 xl:top-14 xl:w-[340px] ${
        open === false ? "xl:bottom-auto" : "xl:bottom-28 xl:max-h-none"
      }`}
      aria-label="Live agents"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open ?? undefined}
        aria-controls="live-feed-list"
        className="flex items-baseline gap-3 whitespace-nowrap px-4 py-3 text-left"
      >
        <span className="panel-title">Live agents</span>
        <span className="min-w-0 flex-1 truncate text-[12px] tabular-nums text-trace" title="Events from the last 15 minutes">
          {recent} recent
        </span>
        <span className="text-[12px]">
          {open === null ? (
            <>
              <span className="xl:hidden">Show</span>
              <span className="hidden xl:inline">Hide</span>
            </>
          ) : open ? (
            "Hide"
          ) : (
            "Show"
          )}
        </span>
      </button>
      <ol id="live-feed-list" className={`scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-line p-2 ${listCls}`}>
        {events.length === 0 && (
          <li className="p-6 text-center text-[13px] text-trace">
            No activity yet. Start a Claude Code session on an equipped computer: it will show up here.
          </li>
        )}
        {events.map((e) => {
          const name = names[e.user_id] ?? "Someone"
          const zoneIds = [...new Set(e.zones)]
          const hidden = hiddenReason(e)
          return (
            <li key={e.id} className={`rounded-[6px] px-2.5 py-2 hover:bg-bone ${e.fresh ? "feed-enter" : ""}`}>
              <div className="flex items-start gap-2.5">
                <PersonAvatar id={e.user_id} size={28} bg="surface" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug">
                    <b className="font-medium">{name.split(" ")[0]}</b> <span className="text-trace">{EVENT_VERB[e.type]}</span>
                    {e.type === "query" && e.summary && !e.restricted && <span> “{e.summary}”</span>}
                    {e.type === "write" && e.summary && !e.restricted && <span className="text-trace">, {e.summary}</span>}
                    {hidden === "zone" && <span className="text-trace"> in a restricted zone</span>}
                    {hidden === "private" && (
                      <span className="text-trace" title="Only visible to the person who sent it and to admins">
                        , private content
                      </span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-trace">
                    <span>{AGENT_LABEL[e.agent]}</span>
                    {zoneIds.map((z, i) => {
                      const zv = zone(z)
                      return (
                        <button
                          key={z}
                          type="button"
                          onClick={() => onZone(z)}
                          className="rounded-[4px] text-ink underline-offset-2 hover:underline"
                          title={`Open the ${zv?.name ?? z} zone`}
                        >
                          <ZoneTag name={zv?.name ?? z} color={zoneColor(zv?.color, i)} />
                        </button>
                      )
                    })}
                    <RelTime iso={e.at} now={now} className="ml-auto tabular-nums" />
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
