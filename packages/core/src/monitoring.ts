// Workstation monitoring: the state of a workstation from its last sync report and its activity.

import type { WorkstationHealth, SyncReport } from "./types"

/** Normal cadence of the scheduled sync (install-schedule): every 15 minutes. */
export const SYNC_EVERY_MS = 15 * 60_000
/** Beyond 4 missed syncs, the workstation is "late". */
export const LATE_AFTER_MS = 4 * SYNC_EVERY_MS

export type WorkstationHealthInput = {
  report: Pick<SyncReport, "at" | "ok" | "error"> | null
  /** Last agent event from the workstation (hooks, MCP…), or null. */
  lastEventAt: string | null
  now: number
}

export type WorkstationHealthResult = { status: WorkstationHealth; since: string | null; reason: string }

/**
 * - `never`: no report and no activity, the workstation is not connected (or has never synced);
 * - `error`: the last sync failed;
 * - `late`: the last successful sync is older than LATE_AFTER_MS;
 * - `ok`: otherwise.
 * A workstation with no report but with activity (hooks) is "late": it feeds the brain without a scheduled sync.
 */
export function workstationHealth({ report, lastEventAt, now }: WorkstationHealthInput): WorkstationHealthResult {
  if (!report) {
    if (!lastEventAt) return { status: "never", since: null, reason: "No sync or activity received from this workstation." }
    return { status: "late", since: lastEventAt, reason: "Activity received (hooks) but no sync report: the scheduled sync is not running." }
  }
  if (!report.ok) return { status: "error", since: report.at, reason: report.error ?? "The last sync failed." }
  const age = now - Date.parse(report.at)
  if (!(age < LATE_AFTER_MS)) return { status: "late", since: report.at, reason: `Last successful sync ${Math.round(age / 60_000)} min ago (expected every ${SYNC_EVERY_MS / 60_000} min).` }
  return { status: "ok", since: report.at, reason: "Recent sync." }
}

/** Display order: workstations that need action first. */
export const HEALTH_ORDER: Record<WorkstationHealth, number> = { error: 0, late: 1, never: 2, ok: 3 }
