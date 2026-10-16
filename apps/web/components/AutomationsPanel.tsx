"use client"

import { useState } from "react"
import type { AutomationSuggestion } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, errorMessage } from "./format"

export function AutomationsPanel({
  automations,
  names,
  zones,
  isAdmin,
  onChange,
}: {
  automations: AutomationSuggestion[]
  names: Record<string, string>
  zones: ZoneView[]
  isAdmin: boolean
  onChange: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const visible = automations.filter((a) => a.status !== "dismissed")

  async function setStatus(id: string, status: AutomationSuggestion["status"]) {
    setBusy(id)
    setErr(null)
    try {
      await api(`/api/automations/${id}`, { method: "PATCH", json: { status } })
      onChange()
    } catch (e) {
      setErr(`${status === "accepted" ? "Validation" : "Mise à jour"} impossible : ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function detect() {
    setBusy("detect")
    setErr(null)
    try {
      await api("/api/automations/detect", { method: "POST" })
      onChange()
    } catch (e) {
      setErr(`Analyse impossible : ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="panel-title">Automatisations proposées</div>
        {isAdmin && (
          <button className="btn !py-1 !text-xs" onClick={detect} disabled={busy === "detect"}>
            {busy === "detect" ? "Analyse…" : "Analyser l'activité"}
          </button>
        )}
      </div>
      {err && (
        <p role="alert" className="mt-2 text-sm text-red-300">
          {err}
        </p>
      )}
      {visible.length === 0 && (
        <p className="mt-3 text-sm text-[var(--muted)]">
          Rien de répétitif détecté pour l&apos;instant. Le cerveau repère les prompts lancés par la même personne, au même créneau, plusieurs jours de suite.
        </p>
      )}
      <div className="mt-3 space-y-3">
        {visible.map((a) => {
          const z = zones.find((x) => x.id === a.zone)
          return (
            <article key={a.id} className="rounded-2xl border border-[rgba(52,211,153,0.3)] bg-[rgba(52,211,153,0.06)] p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[14px] font-semibold leading-snug">{a.title}</h3>
                <span className="mono shrink-0 rounded-lg bg-emerald-400/15 px-2 py-1 text-xs font-semibold text-emerald-300">
                  −{a.minutes_saved_per_week} min/sem.
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{a.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                {a.user_id && names[a.user_id] && <span className="chip">{names[a.user_id]}</span>}
                {z && (
                  <span className="chip" style={{ color: z.color, borderColor: `${z.color}55` }}>
                    {z.name}
                  </span>
                )}
                {a.schedule && <span className="chip">⏰ {a.schedule}</span>}
                <span className="chip">{a.source === "screenpipe" ? "détecté par Screenpipe" : `${a.evidence.days} jours d'historique`}</span>
                {a.evidence.times && a.evidence.times.length > 0 && (
                  <span className="chip mono !whitespace-normal" title="Heure de la première exécution de chaque journée">
                    {a.evidence.times.slice(-6).join(" · ")}
                  </span>
                )}
              </div>
              {isAdmin && (
                <div className="mt-3 flex gap-2">
                  {a.status === "accepted" ? (
                    <span className="text-xs font-medium text-emerald-300">✓ Automatisation validée</span>
                  ) : (
                    <>
                      <button className="btn btn-primary !py-1 !text-xs" disabled={busy === a.id} onClick={() => setStatus(a.id, "accepted")}>
                        Mettre en place
                      </button>
                      <button className="btn !py-1 !text-xs" disabled={busy === a.id} onClick={() => setStatus(a.id, "dismissed")}>
                        Ignorer
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
