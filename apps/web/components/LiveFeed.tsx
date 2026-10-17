"use client"

import type { ZoneView } from "@/lib/brain"
import type { FeedEvent } from "./Dashboard"
import { AGENT_LABEL, EVENT_VERB, initials } from "./format"
import { RelTime } from "./RelTime"
import { ZoneTag, zoneColor } from "./ui"

/**
 * Pourquoi le contenu d'un événement est masqué : « zone » (une de ses zones n'est pas lisible) ou « private »
 * (événement sans zone : prompt personnel, recherche hors de vos zones…). Un démarrage ou un arrêt de session privé
 * n'affiche rien de plus (seul l'identifiant de session est caché). Repli pour les anciens événements sans motif.
 */
function hiddenReason(e: FeedEvent): "zone" | "private" | null {
  if (!e.restricted) return null
  const reason = e.restricted_reason ?? (e.zones.length ? "zone" : "private")
  if (reason === "private" && (e.type === "started" || e.type === "stopped")) return null
  return reason
}

export function LiveFeed({ events, names, zones, now }: { events: FeedEvent[]; names: Record<string, string>; zones: ZoneView[]; now: number }) {
  const zone = (id: string) => zones.find((x) => x.id === id)
  return (
    <aside className="panel flex max-h-[760px] min-h-[420px] flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="panel-title">Agents en direct</h2>
        <span className="text-[12px] text-trace">hooks, MCP, brain-sync</span>
      </div>
      <ol className="scroll-thin flex-1 overflow-y-auto p-2">
        {events.length === 0 && (
          <li className="p-6 text-center text-[13px] text-trace">
            Aucune activité pour l&apos;instant. Lancez une session Claude Code sur un poste équipé : elle apparaîtra ici.
          </li>
        )}
        {events.map((e) => {
          const name = names[e.user_id] ?? "Quelqu'un"
          const zoneIds = [...new Set(e.zones)]
          const hidden = hiddenReason(e)
          return (
            <li key={e.id} className={`rounded-[6px] px-2.5 py-2 hover:bg-bone ${e.fresh ? "feed-enter" : ""}`}>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-[10px] font-medium" aria-hidden>
                  {initials(name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug">
                    <b className="font-medium">{name.split(" ")[0]}</b> <span className="text-trace">{EVENT_VERB[e.type]}</span>
                    {e.type === "query" && e.summary && !e.restricted && <span> « {e.summary} »</span>}
                    {e.type === "write" && e.summary && !e.restricted && <span className="text-trace">, {e.summary}</span>}
                    {hidden === "zone" && <span className="text-trace"> dans une zone restreinte</span>}
                    {hidden === "private" && (
                      <span className="text-trace" title="Visible seulement de la personne qui l'a envoyé et des admins">
                        , contenu privé
                      </span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-trace">
                    <span>{AGENT_LABEL[e.agent]}</span>
                    {zoneIds.map((z, i) => {
                      const zv = zone(z)
                      return <ZoneTag key={z} name={zv?.name ?? z} color={zoneColor(zv?.color, i)} className="text-ink" />
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
