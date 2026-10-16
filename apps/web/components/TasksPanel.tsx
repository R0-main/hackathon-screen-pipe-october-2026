"use client"

import { useState } from "react"
import type { Task } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, firstName } from "./format"

export function TasksPanel({ tasks, names, zones, onChange }: { tasks: Task[]; names: Record<string, string>; zones: ZoneView[]; onChange: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const open = tasks.filter((t) => t.status === "open")
  const done = tasks.filter((t) => t.status === "done")

  async function toggle(t: Task) {
    setPending(t.id)
    try {
      await api(`/api/tasks/${t.id}`, { method: "PATCH", json: { status: t.status === "open" ? "done" : "open" } })
      onChange()
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <div className="panel-title">Tâches</div>
        <span className="text-xs text-[var(--muted)]">
          {open.length} ouverte{open.length > 1 ? "s" : ""} · {done.length} faite{done.length > 1 ? "s" : ""}
        </span>
      </div>
      <p className="mt-1 text-[11.5px] text-[var(--faint)]">Extraites automatiquement des sessions IA. Connecteurs Todoist / Notion / Linear : prochaine étape.</p>
      <ul className="mt-3 space-y-1">
        {tasks.length === 0 && <li className="text-sm text-[var(--muted)]">Aucune tâche dans vos zones.</li>}
        {[...open, ...done].slice(0, 12).map((t) => {
          const z = zones.find((x) => x.id === t.zone)
          return (
            <li key={t.id} className="flex items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-[var(--panel-strong)]">
              <input
                type="checkbox"
                checked={t.status === "done"}
                disabled={pending === t.id}
                onChange={() => toggle(t)}
                className="mt-1 h-4 w-4 shrink-0 accent-cyan-400"
                aria-label={`Marquer « ${t.title} » comme ${t.status === "done" ? "à faire" : "faite"}`}
              />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] leading-snug ${t.status === "done" ? "text-[var(--faint)] line-through" : ""}`}>{t.title}</div>
                <div className="mt-0.5 flex gap-1.5 text-[11px] text-[var(--faint)]">
                  {z && <span style={{ color: z.color }}>{z.name}</span>}
                  {t.assignee_id && names[t.assignee_id] && <span>· {firstName(names[t.assignee_id])}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
