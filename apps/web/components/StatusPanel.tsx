"use client"

import Link from "next/link"
import { useState, type ReactNode } from "react"
import type { CompanyStatus, Task, ZoneStatus } from "@brain/core"
import type { DashboardState, ZoneView } from "@/lib/brain"
import { fmt, plural } from "@/lib/i18n"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { PersonAvatar } from "./PersonDot"
import { RelTime } from "./RelTime"
import { CheckIcon, CopyIcon, ErrorText, ZoneBead, ZoneTag, zoneColor } from "./ui"

/** Command of the installed client (see lib/install-prompt.ts) that has Claude write the state on the workstation, then sends it. */
const REFRESH_COMMAND = "~/.company-brain/brain refresh-status"

type Person = DashboardState["people"][number]
type TaskCounts = DashboardState["task_counts"]

/**
 * "Where the company stands", read like a team update: the answer first, then what is next across all zones and the
 * list of zones, then the detail zone by zone, hooked to a thread (one bead per zone, as in the brain). Progress reads
 * in beads: one per task, filled when it is done.
 */
export function StatusPanel({
  status,
  zones,
  people,
  tasks,
  taskCounts,
  canRefresh,
  onRefreshed,
  now,
}: {
  status: CompanyStatus | null
  zones: ZoneView[]
  people: Person[]
  tasks: Task[]
  taskCounts: TaskCounts
  canRefresh: boolean
  onRefreshed: () => void
  now?: number
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // A viewer who doesn't read all zones: the headline is recomputed on their zones by the server (not by Claude).
  const headlineScoped = zones.some((z) => z.locked)

  // Zones of the update still present, once each (a zone deleted since the generation disappears).
  const sections: { zs: ZoneStatus; z: ZoneView }[] = []
  for (const zs of status?.zones ?? []) {
    const z = zones.find((x) => x.id === zs.zone)
    if (z && !sections.some((s) => s.z.id === z.id)) sections.push({ zs, z })
  }
  const steps = sections.flatMap(({ zs, z }) => zs.next_steps.map((text) => ({ text, z, done: stepDone(text, z.id, tasks) })))
  const openSteps = steps.filter((s) => !s.done).length

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

  const generator = !status
    ? null
    : status.generator !== "claude"
      ? t.status.byHeuristic
      : headlineScoped
        ? t.status.byClaudeScoped
        : t.status.byClaude

  return (
    <div className="space-y-10 sm:space-y-12" aria-busy={busy}>
      <header>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <h1 className="text-[22px] font-medium leading-tight">{t.status.title}</h1>
          {canRefresh && (
            <button type="button" className="btn btn-primary" onClick={refresh} disabled={busy}>
              {busy ? t.status.refreshing : t.status.refresh}
            </button>
          )}
        </div>
        <p className="mt-4 max-w-[60ch] text-[19px] leading-[1.45] sm:text-[21px]">
          {status?.headline ?? (canRefresh ? t.status.emptyAdmin : t.status.empty)}
        </p>
        {status && (
          <p className="mt-3 text-[13px] text-trace">
            {t.status.generated} <RelTime iso={status.generated_at} now={now} /> {generator}
          </p>
        )}
        {err && <ErrorText className="mt-3">{fmt(t.status.refreshError, { error: err })}</ErrorText>}
        {/* Admins: without an API key on the server, Claude can write the update from a workstation (the employee's subscription). */}
        {canRefresh && status?.generator !== "claude" && <CommandHint />}
      </header>

      {sections.length > 0 && (
        <div className="grid gap-x-12 gap-y-10 border-t border-line pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
          <section aria-labelledby="status-next">
            <SectionTitle id="status-next" count={openSteps || undefined}>
              {t.status.next}
            </SectionTitle>
            {steps.length === 0 ? (
              <p className="mt-3 text-[13px] text-trace">{t.status.nextEmpty}</p>
            ) : (
              <ul className="mt-3 border-t border-line">
                {steps.map((s, i) => (
                  <li key={`${s.z.id}-${i}`} className="flex items-start gap-3 border-b border-line py-3">
                    <span
                      aria-hidden
                      className={`mt-[5px] block size-[9px] shrink-0 rounded-full border ${s.done ? "border-ink bg-ink" : "border-trace"}`}
                    />
                    <span className={`min-w-0 flex-1 text-[14px] leading-snug [overflow-wrap:anywhere] ${s.done ? "text-trace line-through decoration-line-strong" : ""}`}>
                      {s.text}
                      {s.done && <span className="sr-only"> ({t.status.stepDone})</span>}
                    </span>
                    <ZoneTag name={s.z.name} color={zoneColor(s.z.color, s.z.position)} className="shrink-0 pt-px text-[12px] text-trace" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="status-zones">
            <SectionTitle id="status-zones">{t.status.zones}</SectionTitle>
            <ul className="mt-3 border-t border-line">
              {sections.map(({ z }) => (
                <li key={z.id} className="border-b border-line">
                  <a
                    href={`#zone-${z.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-[6px] px-2 py-3 transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} className="min-w-0 flex-1 text-[14px] font-medium" />
                    <span className="text-[12px] tabular-nums text-trace">{plural(z.count, t.status.items, t.status.itemsPlural)}</span>
                    <Progress counts={taskCounts[z.id]} max={6} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {sections.length > 0 && (
        <section aria-labelledby="status-detail" className="border-t border-line pt-8">
          <SectionTitle id="status-detail">{t.status.byZone}</SectionTitle>
          <ol className="mt-7">
            {sections.map(({ zs, z }, i) => (
              <ZoneSection
                key={z.id}
                zs={zs}
                zone={z}
                counts={taskCounts[z.id]}
                people={people}
                byClaude={status?.generator === "claude"}
                last={i === sections.length - 1}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

function ZoneSection({
  zs,
  zone,
  counts,
  people,
  byClaude,
  last,
}: {
  zs: ZoneStatus
  zone: ZoneView
  counts: TaskCounts[string] | undefined
  people: Person[]
  byClaude: boolean
  last: boolean
}) {
  const { t } = useT()
  // The heuristic writes "1/2 tasks done": the beads already say so. Claude's sentence, on the other hand, adds meaning.
  const progressNote = byClaude && zs.progress.trim() && !/^\s*\d+\s*\/\s*\d+/.test(zs.progress) ? zs.progress : null
  const hasDetail = zs.objectives.length > 0 || zs.who_did_what.length > 0
  return (
    <li id={`zone-${zone.id}`} className={`relative scroll-mt-6 pl-8 ${last ? "" : "pb-12"}`}>
      {/* The thread: from this zone's bead to the next one's. */}
      {!last && <span aria-hidden className="absolute -bottom-[4px] left-[5px] top-[21px] w-px bg-line-strong" />}
      <ZoneBead color={zoneColor(zone.color, zone.position)} className="absolute left-0 top-[6.5px]" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="text-[17px] font-medium leading-6">{zone.name}</h3>
        <Progress counts={counts} max={10} />
      </div>
      <p className="mt-2 max-w-[68ch] text-[15px] leading-relaxed">{zs.summary}</p>
      {progressNote && <p className="mt-1.5 max-w-[68ch] text-[13px] leading-relaxed text-trace">{progressNote}</p>}

      {hasDetail && (
        <div className="mt-6 grid gap-x-12 gap-y-6 md:grid-cols-2">
          {zs.objectives.length > 0 && (
            <div>
              <h4 className="text-[13px] font-medium">{t.status.objectives}</h4>
              <ul className="mt-2.5 space-y-2 text-[14px] leading-snug">
                {zs.objectives.map((o, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="mt-[6px] block size-[6px] shrink-0 rounded-full border border-trace" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{o}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {zs.who_did_what.length > 0 && (
            <div>
              <h4 className="text-[13px] font-medium">{t.status.whoDidWhat}</h4>
              <ul className="mt-2.5 space-y-3">
                {zs.who_did_what.map((w, i) => {
                  const p = findPerson(people, w.person)
                  return (
                    <li key={i} className="flex gap-2.5">
                      {p ? (
                        <PersonAvatar id={p.id} size={26} bg="surface" />
                      ) : (
                        <span aria-hidden className="block size-[26px] shrink-0 rounded-full border border-line-strong bg-surface" />
                      )}
                      <div className="min-w-0 text-[13px] leading-snug">
                        <p className="font-medium">{p?.name ?? w.person}</p>
                        <p className="mt-0.5 text-trace [overflow-wrap:anywhere]">{w.did}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <Link
        href={`/knowledge?zone=${encodeURIComponent(zone.id)}`}
        className="mt-5 inline-block rounded-[4px] text-[13px] underline decoration-line-strong decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-ink"
      >
        {fmt(t.status.seeKnowledge, { zone: zone.name })}
      </Link>
    </li>
  )
}

/** A zone's progress: one bead per task (filled when it is done), then "1 of 2". Beyond `max`, to scale. */
function Progress({ counts, max }: { counts: TaskCounts[string] | undefined; max: number }) {
  const { t } = useT()
  const done = counts?.done ?? 0
  const total = done + (counts?.open ?? 0)
  if (total === 0) return <span className="text-[12px] text-trace">{t.status.noTasks}</span>
  const beads = Math.min(total, max)
  const filled = total <= max ? done : Math.round((done / total) * max)
  const long = plural(done, t.status.tasksLong, t.status.tasksLongPlural, { total })
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[12px] tabular-nums text-trace" title={long}>
      <span aria-hidden className="flex gap-[3px]">
        {Array.from({ length: beads }, (_, i) => (
          <span key={i} className={`block size-2 rounded-full border ${i < filled ? "border-ink bg-ink" : "border-trace"}`} />
        ))}
      </span>
      <span aria-hidden>{fmt(t.status.tasks, { n: done, total })}</span>
      <span className="sr-only">{long}</span>
    </span>
  )
}

function SectionTitle({ id, count, children }: { id: string; count?: number; children: ReactNode }) {
  return (
    <h2 id={id} className="text-[15px] font-medium leading-tight">
      {children}
      {count !== undefined && <span className="ml-2 tabular-nums text-trace">{count}</span>}
    </h2>
  )
}

/** The command that has Claude write the update on a workstation, to copy. */
function CommandHint() {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(REFRESH_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard refused: the command stays selectable with one click */
    }
  }
  return (
    <div className="mt-6 max-w-2xl">
      <p className="text-[13px] leading-relaxed text-trace">{t.status.claudeHint}</p>
      <div className="mt-2 flex items-center gap-2 rounded-[6px] border border-line bg-surface py-1 pl-3 pr-1">
        <code className="mono min-w-0 flex-1 select-all text-[12.5px] [overflow-wrap:anywhere]">{REFRESH_COMMAND}</code>
        <button type="button" className="btn btn-sm shrink-0" onClick={copy} aria-label={copied ? t.status.copied : t.status.copyCommand}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span aria-hidden>{copied ? t.status.copied : t.status.copy}</span>
        </button>
      </div>
      <span role="status" className="sr-only">
        {copied ? t.status.copied : ""}
      </span>
    </div>
  )
}

/**
 * A next step is done when the tasks of its zone that carry this title are all done (the heuristic reuses the task's
 * title, truncated with "…").
 */
function stepDone(step: string, zone: string, tasks: Task[]): boolean {
  const prefix = step.endsWith("…") ? step.slice(0, -1) : null
  const matches = tasks.filter((x) => x.zone === zone && (x.title === step || (prefix !== null && x.title.startsWith(prefix))))
  return matches.length > 0 && matches.every((x) => x.status === "done")
}

/** Claude often writes the first name alone, the heuristic the full name. */
function findPerson(people: Person[], name: string): Person | undefined {
  const n = name.trim().toLowerCase()
  return people.find((p) => p.name.toLowerCase() === n) ?? people.find((p) => p.name.toLowerCase().split(" ")[0] === n)
}
