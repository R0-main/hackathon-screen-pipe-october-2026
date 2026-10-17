"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { KIND_COLOR, KIND_LABEL, firstName } from "./format"
import { RelTime } from "./RelTime"

/** `unreadableNote` : la zone de l'item n'est pas lisible par le spectateur (son propre item) ; texte de l'infobulle du badge. */
export function KnowledgeCard({
  item,
  author,
  zone,
  now,
  unreadableNote,
}: {
  item: KnowledgeItem
  author?: string
  zone?: ZoneView | { name: string; color: string }
  now?: number
  unreadableNote?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-2xl border border-[var(--border)] bg-[rgba(2,6,23,0.35)] p-3.5 transition hover:border-[var(--border-strong)]">
      <button className="w-full text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="chip !py-0" style={{ color: KIND_COLOR[item.kind], borderColor: `${KIND_COLOR[item.kind]}55` }}>
            {KIND_LABEL[item.kind]}
          </span>
          {zone && (
            <span className="chip !py-0" style={{ color: zone.color, borderColor: `${zone.color}55` }}>
              {zone.name}
            </span>
          )}
          {unreadableNote && (
            <span className="chip !py-0 !border-amber-300/40 !text-amber-200" title={unreadableNote}>
              🔒 zone non lisible
            </span>
          )}
          <span className="ml-auto text-[var(--faint)]">
            {author ? `${firstName(author)} · ` : ""}
            <RelTime iso={item.created_at} now={now} />
          </span>
        </div>
        <h4 className="mt-2 break-words text-[13.5px] font-medium leading-snug">{item.title}</h4>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-[var(--muted)]">{item.body}</p>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {item.entities.map((e, i) => (
              <span key={`${e.type}:${e.name}:${i}`} className="chip !py-0">
                {e.name}
              </span>
            ))}
            <span className="chip !py-0 text-[var(--faint)]">
              source : {item.source.tool}
              {item.source.app ? ` (${item.source.app})` : ""}
            </span>
            <span className="chip !py-0 mono text-[var(--faint)]">confiance {Math.round(item.confidence * 100)} %</span>
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
        <div className="panel-title">Dernières connaissances distillées</div>
        <div className="flex flex-wrap gap-1.5">
          <button className={`chip ${filter === "all" ? "!border-cyan-400/60 !text-cyan-200" : ""}`} onClick={() => setFilter("all")}>
            Toutes
          </button>
          {readable.map((z) => (
            <button
              key={z.id}
              className="chip"
              style={filter === z.id ? { color: z.color, borderColor: z.color } : undefined}
              onClick={() => setFilter(z.id)}
            >
              {z.name}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
        {shown.length === 0 && <p className="text-sm text-[var(--muted)]">Rien ici pour l&apos;instant.</p>}
        {shown.map((i) => (
          <KnowledgeCard key={i.id} item={i} author={names[i.author_id]} zone={zones.find((z) => z.id === i.zone)} now={now} />
        ))}
      </div>
    </section>
  )
}
