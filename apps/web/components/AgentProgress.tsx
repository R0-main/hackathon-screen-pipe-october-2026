"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "./format"
import { CheckIcon, CloseIcon } from "./ui"

export type AgentStep = "start" | "progress" | "draft" | "done" | "error"
export type AgentEvent = { id: number; step: AgentStep; message: string; at: string }
export type RunState = "idle" | "running" | "done" | "error"

const POLL_MS = 3000
const TOAST_MS = 7000

/**
 * Follows Claude Code or Codex while it prepares the onboarding: its proposal (which it sends early then completes) and
 * the thread of its signals (POST /api/onboarding/progress). The thread already there on the first read shows without
 * notifying; only the signals that arrive afterwards become notifications, so you can move on without missing anything.
 */
export function useAgentOnboarding<D extends { received_at?: string }>(active: boolean, notify = true) {
  const [draft, setDraft] = useState<D | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [toasts, setToasts] = useState<AgentEvent[]>([])
  const seen = useRef<number | null>(null)
  // When the thread is already on screen, its signals do not become notifications (nor later, when leaving the step).
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  useEffect(() => {
    if (!notify) setToasts([])
  }, [notify])

  useEffect(() => {
    if (!active) return
    let stop = false
    const tick = async () => {
      const [d, p] = await Promise.all([
        api<{ draft: D | null }>("/api/onboarding/import").catch(() => null),
        api<{ events: AgentEvent[] }>("/api/onboarding/progress").catch(() => null),
      ])
      if (stop) return
      if (d) setDraft((prev) => (prev?.received_at === d.draft?.received_at ? prev : d.draft))
      if (!p) return
      const last = p.events.at(-1)?.id ?? 0
      setEvents((prev) => (prev.at(-1)?.id === last && prev.length === p.events.length ? prev : p.events))
      if (seen.current === null) seen.current = last
      const fresh = p.events.filter((e) => e.id > (seen.current ?? 0))
      if (fresh.length) {
        seen.current = last
        if (notifyRef.current) setToasts((t) => [...t, ...fresh].slice(-4))
      }
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [active])

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  // The current run: since its last start.
  const start = events.findLastIndex((e) => e.step === "start")
  const run = start >= 0 ? events.slice(start) : events
  const lastStep = run.at(-1)?.step
  const state: RunState = !run.length ? "idle" : lastStep === "done" ? "done" : lastStep === "error" ? "error" : "running"
  return { draft, run, state, toasts, dismiss }
}

function EventMark({ ev, current }: { ev: AgentEvent; current: boolean }) {
  if (ev.step === "error") return <CloseIcon size={14} className="text-danger" />
  if (current && ev.step !== "done") return <span className="live-dot is-live" aria-hidden />
  return <CheckIcon size={14} />
}

/** The run's thread, in the step: each signal is added at the bottom, the last one blinks while the agent works. */
export function AgentRun({ run, className = "" }: { run: AgentEvent[]; className?: string }) {
  if (!run.length) return null
  const shown = run.slice(-6)
  return (
    <ol className={`space-y-1.5 ${className}`} aria-live="polite" aria-label="Agent progress">
      {shown.map((ev, i) => (
        <li key={ev.id} className={`feed-enter flex items-center gap-2.5 text-[13.5px] ${i === shown.length - 1 ? "" : "text-trace"}`}>
          <span className="grid size-4 shrink-0 place-items-center">
            <EventMark ev={ev} current={i === shown.length - 1} />
          </span>
          <span className="min-w-0 break-words">{ev.message}</span>
        </li>
      ))}
    </ol>
  )
}

const TOAST_TITLE: Record<AgentStep, string> = {
  start: "Claude started",
  progress: "Claude is making progress",
  draft: "New proposal",
  done: "Claude is done",
  error: "Claude stopped",
}

function Toast({ ev, current, dismiss, action }: { ev: AgentEvent; current: boolean; dismiss: (id: number) => void; action?: React.ReactNode }) {
  // Errors and proposals to review stay: they must not be missed.
  const sticky = ev.step === "error" || Boolean(action)
  useEffect(() => {
    if (sticky) return
    const t = setTimeout(() => dismiss(ev.id), TOAST_MS)
    return () => clearTimeout(t)
  }, [ev.id, sticky, dismiss])
  return (
    <li className="panel bubble-in pointer-events-auto flex items-start gap-3 border-line-strong px-4 py-3">
      <span className="mt-[3px] grid size-4 shrink-0 place-items-center">
        <EventMark ev={ev} current={current && (ev.step === "start" || ev.step === "progress")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{TOAST_TITLE[ev.step]}</div>
        <div className="break-words text-[13px] text-trace">{ev.message}</div>
        {action && <div className="mt-1.5 text-[13px]">{action}</div>}
      </div>
      <button type="button" className="grid size-5 shrink-0 place-items-center rounded-[4px] text-trace hover:text-ink" aria-label="Close" onClick={() => dismiss(ev.id)}>
        <CloseIcon size={12} />
      </button>
    </li>
  )
}

/** The agent's notifications, bottom right, while you do something else. `draftAction`: what to do with a received proposal. */
export function AgentToasts({ toasts, dismiss, draftAction }: { toasts: AgentEvent[]; dismiss: (id: number) => void; draftAction?: React.ReactNode }) {
  if (!toasts.length) return null
  return (
    <ol className="pointer-events-none fixed inset-x-4 bottom-4 z-50 ml-auto max-w-[360px] space-y-2" aria-live="polite" aria-label="Agent notifications">
      {toasts.map((ev, i) => (
        <Toast key={ev.id} ev={ev} current={i === toasts.length - 1} dismiss={dismiss} action={ev.step === "draft" ? draftAction : undefined} />
      ))}
    </ol>
  )
}
