"use client"

import { useEffect, useState } from "react"
import type { KnowledgeItem, Task, ZoneStatus } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { KnowledgeCard } from "./KnowledgeList"
import { api } from "./format"

type ZoneDetail = {
  status: ZoneStatus | null
  items: (KnowledgeItem & { author: string })[]
  entities: { type: string; name: string; count: number }[]
  tasks: (Task & { assignee?: string })[]
}

export function ZoneDrawer({ zone, onClose }: { zone: ZoneView; onClose: () => void }) {
  const [detail, setDetail] = useState<ZoneDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    if (zone.locked) return
    api<ZoneDetail>(`/api/zones/${zone.id}`)
      .then(setDetail)
      .catch((e) => setError(e.message))
  }, [zone.id, zone.locked])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        className="scroll-thin h-full w-full max-w-xl overflow-y-auto border-l border-[var(--border-strong)] bg-[#060a14] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: `-20px 0 60px ${zone.color}22` }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em]" style={{ color: zone.color }}>
              Zone
            </div>
            <h2 className="text-2xl font-semibold">{zone.name}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{zone.description}</p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>

        {zone.locked ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] p-5 text-sm text-[var(--muted)]">
            🔒 Vous n&apos;avez pas accès à cette zone. Ses connaissances restent invisibles pour vous et pour vos agents ; seule son activité est visible.
            Demandez l&apos;accès à un admin si votre poste en a besoin.
          </div>
        ) : error ? (
          <p className="mt-6 text-sm text-red-300">{error}</p>
        ) : !detail ? (
          <p className="mt-6 text-sm text-[var(--muted)]">Chargement…</p>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="chip mono">{zone.count} connaissances</span>
              <span className="chip mono">{zone.contributors} contributeurs</span>
            </div>
            {detail.status && (
              <div className="rounded-2xl border border-[var(--border)] p-4">
                <div className="panel-title">État</div>
                <p className="mt-2 text-sm leading-relaxed">{detail.status.summary}</p>
                {detail.status.next_steps.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-[13px] text-[var(--muted)]">
                    {detail.status.next_steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {detail.entities.length > 0 && (
              <div>
                <div className="panel-title">Entités les plus citées</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.entities.map((e) => (
                    <span key={`${e.type}:${e.name}`} className="chip">
                      {e.name} <span className="mono text-[var(--faint)]">{e.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="panel-title">Connaissances</div>
              <div className="mt-2 space-y-2">
                {detail.items.map((i) => (
                  <KnowledgeCard key={i.id} item={i} author={i.author} zone={zone} />
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
