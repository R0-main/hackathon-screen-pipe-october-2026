"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { KIND_LABEL, firstName, relativeTime } from "./format"
import { Dot, ZoneTag, zoneColor } from "./ui"

type ZoneLike = { name: string; color: string; position?: number }

export function KnowledgeCard({ item, author, zone, now }: { item: KnowledgeItem; author?: string; zone?: ZoneView | ZoneLike; now?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-[6px] border border-line bg-surface p-3.5 transition-colors hover:border-line-strong">
      <button type="button" className="w-full rounded-[4px] text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="chip">{KIND_LABEL[item.kind]}</span>
          {zone && (
            <span className="chip">
              <ZoneTag name={zone.name} color={zoneColor(zone.color, zone.position ?? 0)} />
            </span>
          )}
          <span className="ml-auto text-trace">
            {author ? `${firstName(author)}, ` : ""}
            <span className="tabular-nums">{relativeTime(item.created_at, now)}</span>
          </span>
        </div>
        <h4 className="mt-2 text-[13.5px] font-medium leading-snug">{item.title}</h4>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-line text-[13px] leading-relaxed">{item.body}</p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {item.entities.map((e) => (
              <span key={`${e.type}:${e.name}`} className="chip">
                {e.name}
              </span>
            ))}
            <span className="chip text-trace">
              source : {item.source.tool}
              {item.source.app ? ` (${item.source.app})` : ""}
            </span>
            <span className="chip tabular-nums text-trace">confiance {Math.round(item.confidence * 100)} %</span>
          </div>
        </div>
      )}
    </article>
  )
}

export function KnowledgeList({ items, names, zones, now }: { items: KnowledgeItem[]; names: Record<string, string>; zones: ZoneView[]; now: number }) {
  const [filter, setFilter] = useState<string>("all")
  const shown = filter === "all" ? items : items.filter((i) => i.zone === filter)
  const readable = zones.filter((z) => !z.locked)
  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">Dernières connaissances distillées</h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer par zone">
          <button type="button" className={`chip ${filter === "all" ? "chip-on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            Toutes
          </button>
          {readable.map((z) => (
            <button key={z.id} type="button" className={`chip ${filter === z.id ? "chip-on" : ""}`} aria-pressed={filter === z.id} onClick={() => setFilter(z.id)}>
              <Dot color={zoneColor(z.color, z.position)} />
              {z.name}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
        {shown.length === 0 && <p className="text-[13px] text-trace">Rien ici pour l&apos;instant. Les connaissances arrivent à mesure que les postes nourrissent le cerveau.</p>}
        {shown.map((i) => (
          <KnowledgeCard key={i.id} item={i} author={names[i.author_id]} zone={zones.find((z) => z.id === i.zone)} now={now} />
        ))}
      </div>
    </section>
  )
}
