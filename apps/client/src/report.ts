// Sync report sent to the brain (POST /api/sync/report): counters only, never any content.

import type { SyncReport } from "@brain/core"
import { redactText } from "@brain/core"
import type { SyncSummary } from "./sync"

export type ReportInput = {
  summary: SyncSummary | null
  startedAt: number
  /** Error that interrupted the sync, if any. */
  error?: unknown
  version: string
  now?: number
}

/** Short, redacted error message (a token or a URL with a password must never go up). */
export function reportError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactText(raw.replace(/\s+/g, " ").trim()).slice(0, 500)
}

export function buildSyncReport({ summary, startedAt, error, version, now = Date.now() }: ReportInput): SyncReport {
  const conversations: Record<string, number> = {}
  for (const [k, v] of Object.entries(summary?.conversations ?? {})) if (typeof v === "number") conversations[k] = v
  return {
    at: new Date(now).toISOString(),
    ok: error === undefined,
    duration_ms: Math.max(0, now - startedAt),
    items_sent: summary?.sent ?? 0,
    duplicates: summary?.duplicates ?? 0,
    conversations,
    distiller: summary?.distiller ?? "heuristic",
    failed: summary?.failed ?? 0,
    deferred: summary?.deferred ?? 0,
    error: error === undefined ? undefined : reportError(error),
    client_version: version,
    platform: process.platform,
  }
}
