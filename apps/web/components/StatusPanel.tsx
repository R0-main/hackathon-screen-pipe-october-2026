"use client"

import { useState } from "react"
import type { CompanyStatus } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { ErrorText, ZoneTag, zoneColor } from "./ui"

export function StatusPanel({
  status,
  zones,
  canRefresh,
  onRefreshed,
  now,
}: {
  status: CompanyStatus | null
  zones: ZoneView[]
  canRefresh: boolean
  onRefreshed: () => void
  now?: number
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const zone = (id: string) => zones.find((z) => z.id === id)

  async function refresh() {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/status", { method: "POST" })
      onRefreshed()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="panel-title">Où en est l&apos;entreprise</h2>
          <p className="mt-2 max-w-3xl text-[16px] leading-relaxed">{status?.headline ?? "Pas encore de résumé. Lancez une première génération pour que le cerveau fasse le point."}</p>
          {status && (
            <p className="mt-1 text-[12px] text-trace">
              Généré <RelTime iso={status.generated_at} now={now} /> {status.generator === "claude" ? "par Claude" : "par l'heuristique locale, sans Claude"}
            </p>
          )}
        </div>
        {canRefresh && (
          <button type="button" className="btn btn-primary" onClick={refresh} disabled={busy}>
            {busy ? "Génération en cours" : "Rafraîchir l'état"}
          </button>
        )}
      </div>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {(status?.zones ?? []).map((zs, i) => {
          const z = zone(zs.zone)
          if (!z) return null
          return (
            <article key={`${zs.zone}-${i}`} className="inset p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[14px] font-medium">
                  <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
                </h3>
                <span className="text-[12px] text-trace">{zs.progress}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed">{zs.summary}</p>
              {zs.objectives.length > 0 && (
                <Section title="Objectifs">
                  {zs.objectives.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </Section>
              )}
              {zs.next_steps.length > 0 && (
                <Section title="Prochaines étapes">
                  {zs.next_steps.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </Section>
              )}
              {zs.who_did_what.length > 0 && (
                <Section title="Qui a fait quoi">
                  {zs.who_did_what.map((w, i) => (
                    <li key={i}>
                      <b className="font-medium text-ink">{w.person}</b> : {w.did}
                    </li>
                  ))}
                </Section>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h4 className="text-[12px] font-medium">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-trace marker:text-line-strong">{children}</ul>
    </div>
  )
}
