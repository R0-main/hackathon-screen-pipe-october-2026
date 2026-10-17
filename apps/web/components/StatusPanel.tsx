"use client"

import { useState } from "react"
import type { CompanyStatus } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"

/** Commande du client installé (voir lib/install-prompt.ts) qui fait rédiger l'état par Claude sur le poste, puis l'envoie. */
const REFRESH_COMMAND = "node ~/.company-brain/brain.mjs refresh-status"

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
  // Spectateur qui ne lit pas toutes les zones : le titre est recalculé sur ses zones par le serveur (pas par Claude).
  const headlineScoped = zones.some((z) => z.locked)

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
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="panel-title">Où en est la boîte ?</div>
          <p className="mt-2 max-w-3xl text-[15px] leading-relaxed">{status?.headline ?? "Pas encore de résumé : lancez une première génération."}</p>
          {status && (
            <p className="mt-1 text-xs text-[var(--faint)]">
              Généré <RelTime iso={status.generated_at} now={now} /> ·{" "}
              {status.generator !== "claude"
                ? "heuristique locale (sans Claude)"
                : headlineScoped
                  ? "résumés des zones rédigés par Claude"
                  : "rédigé par Claude"}
            </p>
          )}
          {/* Admins : sans clé API sur le serveur, Claude peut rédiger le résumé depuis un poste (abonnement de l'employé). */}
          {canRefresh && status?.generator !== "claude" && (
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
              Pour un résumé rédigé par Claude avec votre abonnement (sans clé API), lancez sur votre poste :{" "}
              <code className="mono select-all rounded-md bg-white/5 px-1.5 py-0.5 text-[var(--text)] [overflow-wrap:anywhere]">{REFRESH_COMMAND}</code>
            </p>
          )}
        </div>
        {canRefresh && (
          <button className="btn btn-primary" onClick={refresh} disabled={busy}>
            {busy ? "Le cerveau réfléchit…" : "Rafraîchir l'état"}
          </button>
        )}
      </div>
      {err && <p className="mt-2 text-sm text-red-300">{err}</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {(status?.zones ?? []).map((zs, i) => {
          const z = zone(zs.zone)
          if (!z) return null
          return (
            <article key={`${zs.zone}-${i}`} className="rounded-2xl border border-[var(--border)] bg-[rgba(2,6,23,0.35)] p-4" style={{ boxShadow: `inset 3px 0 0 ${z.color}` }}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: z.color }}>
                  {z.name}
                </h3>
                <span className="text-[11px] text-[var(--muted)]">{zs.progress}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text)]">{zs.summary}</p>
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
                      <b className="font-medium text-[var(--text)]">{w.person}</b> — {w.did}
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
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-[var(--muted)] marker:text-[var(--faint)]">{children}</ul>
    </div>
  )
}
