"use client"

import { useState } from "react"
import type { AutomationSuggestion, Zone } from "@brain/core"
import { api, errorMessage } from "./format"
import { CheckIcon, ClockIcon, ErrorText, ZoneTag, zoneColor } from "./ui"

/** What the buttons do. By default, the brain's API; the MCP App (show_automations) goes through its MCP server instead. */
export type AutomationActions = {
  setStatus: (id: string, status: AutomationSuggestion["status"]) => Promise<unknown>
  /** Missing: no "Analyze activity" button. */
  detect?: () => Promise<unknown>
}

const API_ACTIONS: AutomationActions = {
  setStatus: (id, status) => api(`/api/automations/${id}`, { method: "PATCH", json: { status } }),
  detect: () => api("/api/automations/detect", { method: "POST" }),
}

export function AutomationsPanel({
  automations,
  names,
  zones,
  isAdmin,
  onChange,
  actions = API_ACTIONS,
}: {
  automations: AutomationSuggestion[]
  names: Record<string, string>
  zones: Zone[]
  isAdmin: boolean
  onChange: () => void
  actions?: AutomationActions
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const visible = automations.filter((a) => a.status !== "dismissed")

  async function setStatus(id: string, status: AutomationSuggestion["status"]) {
    setBusy(id)
    setErr(null)
    try {
      await actions.setStatus(id, status)
      onChange()
    } catch (e) {
      setErr(`Could not ${status === "accepted" ? "validate" : "update"}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function detect() {
    setBusy("detect")
    setErr(null)
    try {
      await actions.detect?.()
      onChange()
    } catch (e) {
      setErr(`Could not analyze: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-busy={busy === "detect"}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="panel-title">Suggested automations</h2>
        {isAdmin && actions.detect && (
          <button type="button" className="btn btn-sm" onClick={detect} disabled={busy === "detect"}>
            {busy === "detect" ? "Analyzing" : "Analyze activity"}
          </button>
        )}
      </div>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      {visible.length === 0 && (
        <p className="mt-3 text-[13px] text-trace">
          Nothing repetitive detected yet. The brain spots prompts run by the same person, in the same time slot, several days in a row.
        </p>
      )}
      <div className="mt-3 space-y-3">
        {visible.map((a) => {
          const z = zones.find((x) => x.id === a.zone)
          return (
            <article key={a.id} className="inset p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[14px] font-medium leading-snug">{a.title}</h3>
                <span className="shrink-0 text-[12px] tabular-nums text-trace">{a.minutes_saved_per_week} min per week</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-trace">{a.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
                {a.user_id && names[a.user_id] && <span className="chip">{names[a.user_id]}</span>}
                {z && (
                  <span className="chip">
                    <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
                  </span>
                )}
                {a.schedule && (
                  <span className="chip">
                    <ClockIcon size={12} /> {a.schedule}
                  </span>
                )}
                <span className="chip">{a.source === "screenpipe" ? "detected by Screenpipe" : `${a.evidence.days} days of history`}</span>
                {a.evidence.times && a.evidence.times.length > 0 && (
                  <span className="chip tabular-nums" title="Time of the first run of each day">
                    {a.evidence.times.slice(-6).join(", ")}
                  </span>
                )}
              </div>
              {isAdmin && (
                <div className="mt-3 flex items-center gap-2">
                  {a.status === "accepted" ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                      <CheckIcon size={14} /> Automation validated
                    </span>
                  ) : (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy === a.id} onClick={() => setStatus(a.id, "accepted")}>
                        Set it up
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy === a.id} onClick={() => setStatus(a.id, "dismissed")}>
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
