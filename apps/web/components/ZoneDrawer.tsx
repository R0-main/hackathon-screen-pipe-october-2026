"use client"

import { useEffect, useRef, useState } from "react"
import { formatBytes, type DocumentRef, type KnowledgeItem, type Task, type ZoneStatus } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { documentHref } from "./DocumentLinks"
import { KnowledgeCard } from "./KnowledgeList"
import { api } from "./format"
import { CloseIcon, Dot, ErrorText, LockIcon, PaperclipIcon, zoneColor } from "./ui"

type ZoneDetail = {
  status: ZoneStatus | null
  items: (KnowledgeItem & { author: string; documents?: DocumentRef[] })[]
  /** Missing from an older brain. */
  documents?: (DocumentRef & { title: string; author: string })[]
  entities: { type: string; name: string; count: number }[]
  tasks: (Task & { assignee?: string })[]
}

export function ZoneDrawer({ zone, onClose }: { zone: ZoneView; onClose: () => void }) {
  const [detail, setDetail] = useState<ZoneDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    if (zone.locked) return
    api<ZoneDetail>(`/api/zones/${zone.id}`)
      .then(setDetail)
      .catch((e) => setError(e.message))
  }, [zone.id, zone.locked])

  // Dialog: initial focus on "Close", Escape to close, focus back to the triggering element.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [onClose])

  const color = zoneColor(zone.color, zone.position)

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="zone-drawer-title"
        className="scroll-thin h-full w-full max-w-xl overflow-y-auto border-l border-line bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="zone-drawer-title" className="flex items-center gap-2 text-[22px] font-medium leading-tight">
              <Dot color={color} size={10} />
              {zone.name}
            </h2>
            <p className="mt-1 text-[13px] text-trace">{zone.description}</p>
          </div>
          <button ref={closeRef} type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {zone.locked ? (
          <div className="inset mt-6 flex gap-3 p-4 text-[13px] text-trace">
            <LockIcon className="mt-0.5 shrink-0 text-ink" />
            <p>
              You don&apos;t have access to this zone. Its knowledge stays invisible to you and to your agents; only its activity is visible.
              Ask an admin for access if your work needs it.
            </p>
          </div>
        ) : error ? (
          <ErrorText className="mt-6">{error}</ErrorText>
        ) : !detail ? (
          <p className="mt-6 text-[13px] text-trace" aria-live="polite">
            Loading
          </p>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="flex flex-wrap gap-2 text-[12px]">
              <span className="chip tabular-nums">{zone.count} knowledge items</span>
              <span className="chip tabular-nums">{zone.contributors} contributors</span>
            </div>
            {detail.status && (
              <div className="inset p-4">
                <h3 className="panel-title">State</h3>
                <p className="mt-2 text-[13px] leading-relaxed">{detail.status.summary}</p>
                {detail.status.next_steps.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-[13px] text-trace marker:text-line-strong">
                    {detail.status.next_steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {detail.entities.length > 0 && (
              <div>
                <h3 className="panel-title">Most cited entities</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.entities.map((e) => (
                    <span key={`${e.type}:${e.name}`} className="chip">
                      {e.name} <span className="tabular-nums text-trace">{e.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {detail.documents && detail.documents.length > 0 && (
              <div>
                <h3 className="panel-title">Documents</h3>
                <ul className="mt-2 space-y-1.5">
                  {detail.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-[13px]">
                      <PaperclipIcon size={14} className="shrink-0 text-trace" aria-hidden />
                      <a href={documentHref(d.id)} target="_blank" rel="noopener" className="min-w-0 truncate hover:underline">
                        {d.title}
                      </a>
                      <span className="ml-auto shrink-0 tabular-nums text-[12px] text-trace">{formatBytes(d.size)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="panel-title">Knowledge</h3>
              <div className="mt-2 space-y-2">
                {detail.items.map((i) => (
                  <KnowledgeCard key={i.id} item={i} author={i.author} zone={zone} />
                ))}
                {detail.items.length === 0 && <p className="text-[13px] text-trace">No knowledge in this zone yet.</p>}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
