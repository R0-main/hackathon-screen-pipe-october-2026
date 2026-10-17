"use client"

import { useState } from "react"
import type { AutomationSuggestion } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, errorMessage } from "./format"
import { CheckIcon, ClockIcon, ErrorText, ZoneTag, zoneColor } from "./ui"

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
    <section className="panel p-4 sm:p-5" aria-busy={busy === "detect"}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="panel-title">Automatisations proposées</h2>
        {isAdmin && (
          <button type="button" className="btn btn-sm" onClick={detect} disabled={busy === "detect"}>
            {busy === "detect" ? "Analyse en cours" : "Analyser l'activité"}
          </button>
        )}
      </div>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      {visible.length === 0 && (
        <p className="mt-3 text-[13px] text-trace">
          Rien de répétitif détecté pour l&apos;instant. Le cerveau repère les prompts lancés par la même personne, au même créneau, plusieurs jours de suite.
        </p>
      )}
      <div className="mt-3 space-y-3">
        {visible.map((a) => {
          const z = zones.find((x) => x.id === a.zone)
          return (
            <article key={a.id} className="inset p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[14px] font-medium leading-snug">{a.title}</h3>
                <span className="shrink-0 text-[12px] tabular-nums text-trace">{a.minutes_saved_per_week} min par semaine</span>
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
                <span className="chip">{a.source === "screenpipe" ? "détecté par Screenpipe" : `${a.evidence.days} jours d'historique`}</span>
                {a.evidence.times && a.evidence.times.length > 0 && (
                  <span className="chip tabular-nums" title="Heure de la première exécution de chaque journée">
                    {a.evidence.times.slice(-6).join(", ")}
                  </span>
                )}
              </div>
              {isAdmin && (
                <div className="mt-3 flex items-center gap-2">
                  {a.status === "accepted" ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                      <CheckIcon size={14} /> Automatisation validée
                    </span>
                  ) : (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy === a.id} onClick={() => setStatus(a.id, "accepted")}>
                        Mettre en place
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy === a.id} onClick={() => setStatus(a.id, "dismissed")}>
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
