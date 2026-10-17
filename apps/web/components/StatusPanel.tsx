"use client"

import { useState } from "react"
import type { CompanyStatus } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { ErrorText, ZoneTag, zoneColor } from "./ui"

/** Command of the installed client (see lib/install-prompt.ts) that has Claude write the state on the workstation, then sends it. */
const REFRESH_COMMAND = "~/.company-brain/brain refresh-status"

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
  // A viewer who doesn't read all zones: the headline is recomputed on their zones by the server (not by Claude).
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
    <section className="panel p-4 sm:p-5" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="panel-title">Where the company stands</h2>
          <p className="mt-2 max-w-3xl text-[16px] leading-relaxed">{status?.headline ?? "No summary yet. Run a first generation so the brain can take stock."}</p>
          {status && (
            <p className="mt-1 text-[12px] text-trace">
              Generated <RelTime iso={status.generated_at} now={now} />{" "}
              {status.generator !== "claude"
                ? "by the local heuristic, without Claude"
                : headlineScoped
                  ? "from the zone summaries written by Claude"
                  : "by Claude"}
            </p>
          )}
          {/* Admins: without an API key on the server, Claude can write the summary from a workstation (the employee's subscription). */}
          {canRefresh && status?.generator !== "claude" && (
            <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-trace">
              For a summary written by Claude with your subscription (no API key), run on your computer:{" "}
              <code className="mono select-all rounded-[4px] bg-bone px-1.5 py-0.5 text-ink [overflow-wrap:anywhere]">{REFRESH_COMMAND}</code>
            </p>
          )}
        </div>
        {canRefresh && (
          <button type="button" className="btn btn-primary" onClick={refresh} disabled={busy}>
            {busy ? "Generating" : "Refresh the status"}
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
                <Section title="Goals">
                  {zs.objectives.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </Section>
              )}
              {zs.next_steps.length > 0 && (
                <Section title="Next steps">
                  {zs.next_steps.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </Section>
              )}
              {zs.who_did_what.length > 0 && (
                <Section title="Who did what">
                  {zs.who_did_what.map((w, i) => (
                    <li key={i}>
                      <b className="font-medium text-ink">{w.person}</b>: {w.did}
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
