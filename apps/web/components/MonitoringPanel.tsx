"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import type { PosteHealth } from "@brain/core"
import type { MonitoringState } from "@/app/api/admin/monitoring/route"
import { fmt } from "@/lib/i18n"
import { PageScroll } from "./AppShell"
import { api, errorMessage, initials } from "./format"
import { useT } from "./I18n"
import { RelTime } from "./RelTime"
import { ErrorText } from "./ui"

const REFRESH_MS = 30_000

/** Pastille d'état : encre pour « à jour », cerclée pour les autres (jamais de couleur seule, le libellé suit toujours). */
function HealthDot({ status }: { status: PosteHealth }) {
  const cls = status === "ok" ? "bg-ink" : status === "error" ? "border-2 border-danger" : status === "late" ? "border-2 border-ink" : "border border-line-strong"
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${cls}`} />
}

export function MonitoringPanel() {
  const { t } = useT()
  const [data, setData] = useState<MonitoringState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setData(await api<MonitoringState>("/api/admin/monitoring"))
      setErr(null)
      setNow(Date.now())
    } catch (e) {
      setErr(fmt(t.monitoring.loadError, { error: errorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  const m = t.monitoring
  const label: Record<PosteHealth, string> = { ok: m.ok, late: m.late, error: m.error, never: m.never }

  return (
    <PageScroll>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-medium leading-tight">{m.title}</h1>
            <p className="mt-1 max-w-3xl text-[13px] text-trace">{m.lead}</p>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-trace">
            {data && (
              <span>
                {fmt(m.refreshed, { when: "" })}
                <RelTime iso={data.generated_at} now={now} />
              </span>
            )}
            <button type="button" className="btn btn-sm" onClick={load} disabled={busy}>
              {m.refresh}
            </button>
          </div>
        </div>
        {err && <ErrorText>{err}</ErrorText>}
        {!data && !err && <p className="text-[13px] text-trace">{t.common.loading}</p>}

        {data && (
          <>
            <section className="panel p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="panel-title">{m.postes}</h2>
                <p className="flex flex-wrap gap-x-3 text-[12px] tabular-nums text-trace">
                  {(["ok", "late", "error", "never"] as PosteHealth[]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5">
                      <HealthDot status={s} />
                      {data.counts[s]} {label[s]}
                    </span>
                  ))}
                </p>
              </div>
              {data.postes.length === 0 && <p className="mt-3 text-[13px] text-trace">{m.noPostes}</p>}
              <ul className="mt-3 divide-y divide-line">
                {data.postes.map((p) => (
                  <li key={p.profile.id} className="grid gap-x-4 gap-y-1 py-3 md:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-[10px] font-medium">{initials(p.profile.name)}</span>
                      <div className="min-w-0">
                        <Link href={`/people/${p.profile.id}`} className="block truncate text-[13px] font-medium hover:underline">
                          {p.profile.name}
                        </Link>
                        <span className="flex items-center gap-1.5 text-[12px] text-trace">
                          <HealthDot status={p.health.status} />
                          {label[p.health.status]}
                        </span>
                      </div>
                    </div>
                    <Cell label={m.lastSync}>
                      {p.report ? <RelTime iso={p.report.at} now={now} /> : t.common.never}
                      {p.report && (
                        <span className="block text-[12px] text-trace">
                          {p.report.distiller}, {Math.round(p.report.duration_ms / 1000)} s
                        </span>
                      )}
                    </Cell>
                    <Cell label={m.lastActivity}>{p.last_event_at ? <RelTime iso={p.last_event_at} now={now} /> : "—"}</Cell>
                    <Cell label={m.items7d}>
                      <span className="tabular-nums">{p.items_7d}</span>
                    </Cell>
                    <Cell label={m.syncs7d}>
                      <span className="tabular-nums">
                        {p.syncs_7d}
                        {p.errors_7d > 0 && (
                          <span className="text-trace">
                            {" "}
                            ({p.errors_7d} {m.errors7d})
                          </span>
                        )}
                      </span>
                    </Cell>
                    {p.health.status !== "ok" && (
                      <p className="text-[12px] text-trace md:col-span-5">
                        {m.reason} : {p.health.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <section className="panel p-4 sm:p-5">
                <h2 className="panel-title">{m.incidents}</h2>
                {data.incidents.length === 0 && <p className="mt-3 text-[13px] text-trace">{m.noIncidents}</p>}
                <ul className="mt-3 space-y-2">
                  {data.incidents.map((i) => (
                    <li key={i.id} className="inset px-3 py-2 text-[13px]">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="mono text-[12px]">{i.where}</span>
                        <span className="text-[12px] text-trace">
                          {i.count > 1 && `${fmt(m.incidentCount, { n: i.count })}, `}
                          <RelTime iso={i.last_at} now={now} />
                        </span>
                      </div>
                      <p className="mt-1 break-words text-trace">{i.message}</p>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="panel p-4 sm:p-5">
                <h2 className="panel-title">{m.server}</h2>
                <dl className="mt-3 space-y-2 text-[13px]">
                  <Row k={m.version} v={data.server.version} />
                  <Row k={m.uptime} v={<RelTime iso={new Date(Date.parse(data.generated_at) - data.server.uptime_s * 1000).toISOString()} now={now} />} />
                  <Row k={m.store} v={data.server.store} />
                  <Row k={m.stream} v={m.streamModes[data.server.stream]} />
                  <Row k={m.webhook} v={data.server.alert_webhook ? m.webhookOn : m.webhookOff} />
                </dl>
                <p className="mt-3 text-[12px] text-trace">{m.health}</p>
              </section>
            </div>
          </>
        )}
      </div>
    </PageScroll>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 text-[13px]">
      <span className="block text-[12px] text-trace md:hidden">{label}</span>
      {children}
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-trace">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  )
}
