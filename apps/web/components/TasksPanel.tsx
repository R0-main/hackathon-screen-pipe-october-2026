"use client"

import { useState } from "react"
import type { Task } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { fmt } from "@/lib/i18n"
import { api, errorMessage, firstName } from "./format"
import { useT } from "./I18n"
import { ErrorText, ZoneTag, zoneColor } from "./ui"

export function TasksPanel({ tasks, names, zones, onChange }: { tasks: Task[]; names: Record<string, string>; zones: ZoneView[]; onChange: () => void }) {
  const { t } = useT()
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const open = tasks.filter((x) => x.status === "open")
  const done = tasks.filter((x) => x.status === "done")

  async function toggle(task: Task) {
    setPending(task.id)
    setErr(null)
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", json: { status: task.status === "open" ? "done" : "open" } })
      onChange()
    } catch (e) {
      setErr(fmt(t.tasks.updateError, { title: task.title, error: errorMessage(e) }))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="panel-title">{t.tasks.title}</h2>
        <span className="text-[12px] tabular-nums text-trace">{fmt(t.tasks.counts, { open: open.length, done: done.length })}</span>
      </div>
      <p className="mt-1 text-[12px] text-trace">{t.tasks.lead}</p>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      <ul className="mt-3 space-y-0.5">
        {tasks.length === 0 && <li className="text-[13px] text-trace">{t.tasks.empty}</li>}
        {[...open, ...done].slice(0, 12).map((task) => {
          const z = zones.find((x) => x.id === task.zone)
          const sourceName = task.external_source ? t.connectors.names[task.external_source as keyof typeof t.connectors.names] ?? task.external_source : null
          return (
            <li key={task.id} className="flex items-start gap-2.5 rounded-[6px] px-2 py-1.5 hover:bg-bone">
              <input
                type="checkbox"
                checked={task.status === "done"}
                disabled={pending === task.id}
                onChange={() => toggle(task)}
                className="mt-[3px] size-4 shrink-0"
                aria-label={fmt(task.status === "done" ? t.tasks.markOpen : t.tasks.markDone, { title: task.title })}
              />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] leading-snug ${task.status === "done" ? "text-trace line-through" : ""}`}>{task.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-trace">
                  {z && <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />}
                  {task.assignee_id && names[task.assignee_id] && <span>{firstName(names[task.assignee_id])}</span>}
                  {sourceName &&
                    (task.external_url ? (
                      <a href={task.external_url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
                        {fmt(t.tasks.external, { source: sourceName })}
                      </a>
                    ) : (
                      <span>{sourceName}</span>
                    ))}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
