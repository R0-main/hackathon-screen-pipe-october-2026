"use client"

import { useState } from "react"
import type { Task } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, firstName } from "./format"
import { ZoneTag, zoneColor } from "./ui"

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
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="panel-title">Tâches</h2>
        <span className="text-[12px] tabular-nums text-trace">
          {open.length} ouverte{open.length > 1 ? "s" : ""}, {done.length} faite{done.length > 1 ? "s" : ""}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-trace">Extraites des sessions IA. Connecteurs Todoist, Notion et Linear à venir.</p>
      <ul className="mt-3 space-y-0.5">
        {tasks.length === 0 && <li className="text-[13px] text-trace">Aucune tâche dans vos zones.</li>}
        {[...open, ...done].slice(0, 12).map((t) => {
          const z = zones.find((x) => x.id === t.zone)
          return (
            <li key={t.id} className="flex items-start gap-2.5 rounded-[6px] px-2 py-1.5 hover:bg-bone">
              <input
                type="checkbox"
                checked={t.status === "done"}
                disabled={pending === t.id}
                onChange={() => toggle(t)}
                className="mt-[3px] size-4 shrink-0"
                aria-label={`Marquer « ${t.title} » comme ${t.status === "done" ? "à faire" : "faite"}`}
              />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] leading-snug ${t.status === "done" ? "text-trace line-through" : ""}`}>{t.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-trace">
                  {z && <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />}
                  {t.assignee_id && names[t.assignee_id] && <span>{firstName(names[t.assignee_id])}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
