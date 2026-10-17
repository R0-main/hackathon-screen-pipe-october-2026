// Compte rendu de synchro envoyé au cerveau (POST /api/sync/report) : compteurs seulement, jamais de contenu.

import type { SyncReport } from "@brain/core"
import { redactText } from "@brain/core"
import type { SyncSummary } from "./sync"

export type ReportInput = {
  summary: SyncSummary | null
  startedAt: number
  /** Erreur qui a interrompu la synchro, le cas échéant. */
  error?: unknown
  version: string
  now?: number
}

/** Message d'erreur court et masqué (un jeton ou une URL avec mot de passe ne doit jamais remonter). */
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
