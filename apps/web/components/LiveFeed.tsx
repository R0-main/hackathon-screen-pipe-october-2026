"use client"

import type { ZoneView } from "@/lib/brain"
import type { FeedEvent } from "./BrainLive"
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

/**
 * Fil des agents, posé sur le cerveau : on lit l'événement pendant que sa zone s'allume. Une zone du fil ouvre son
 * tiroir. Grand écran : colonne à droite, ouverte. Plus petit : bandeau en bas, replié jusqu'au premier clic.
 * `open` à null : ouvert sur grand écran, replié sinon (décidé en CSS, donc identique au rendu serveur).
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
      aria-label="Agents en direct"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open ?? undefined}
        aria-controls="live-feed-list"
        className="flex items-baseline gap-3 whitespace-nowrap px-4 py-3 text-left"
      >
        <span className="panel-title">Agents en direct</span>
        <span className="min-w-0 flex-1 truncate text-[12px] tabular-nums text-trace" title="Événements des 15 dernières minutes">
          {recent} récent{recent > 1 ? "s" : ""}
        </span>
        <span className="text-[12px]">
          {open === null ? (
            <>
              <span className="xl:hidden">Afficher</span>
              <span className="hidden xl:inline">Masquer</span>
            </>
          ) : open ? (
            "Masquer"
          ) : (
            "Afficher"
          )}
        </span>
      </button>
      <ol id="live-feed-list" className={`scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-line p-2 ${listCls}`}>
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
                      return (
                        <button
                          key={z}
                          type="button"
                          onClick={() => onZone(z)}
                          className="rounded-[4px] text-ink underline-offset-2 hover:underline"
                          title={`Ouvrir la zone ${zv?.name ?? z}`}
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
