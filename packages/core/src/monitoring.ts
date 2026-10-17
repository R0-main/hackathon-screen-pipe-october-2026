// Supervision des postes : l'état d'un poste à partir de son dernier compte rendu de synchro et de son activité.

import type { PosteHealth, SyncReport } from "./types"

/** Cadence normale de la synchro planifiée (install-schedule) : toutes les 15 minutes. */
export const SYNC_EVERY_MS = 15 * 60_000
/** Au-delà de 4 synchros manquées, le poste est « en retard ». */
export const LATE_AFTER_MS = 4 * SYNC_EVERY_MS

export type PosteHealthInput = {
  report: Pick<SyncReport, "at" | "ok" | "error"> | null
  /** Dernier événement d'agent du poste (hooks, MCP…), ou null. */
  lastEventAt: string | null
  /** Client désinstallé du poste (profil), ou null. */
  uninstalledAt?: string | null
  now: number
}

export type PosteHealthResult = { status: PosteHealth; since: string | null; reason: string }

/**
 * - `never` : aucun compte rendu ni activité, le poste n'est pas branché (ou n'a jamais synchronisé) ;
 * - `error` : la dernière synchro a échoué ;
 * - `late` : la dernière synchro réussie date de plus de LATE_AFTER_MS ;
 * - `ok` : sinon ;
 * - `uninstalled` : avant tout le reste, le client a été désinstallé (jeton révoqué) : plus rien n'est attendu du poste.
 * Un poste sans compte rendu mais avec de l'activité (hooks) est « late » : il nourrit le cerveau sans synchro planifiée.
 */
export function posteHealth({ report, lastEventAt, uninstalledAt, now }: PosteHealthInput): PosteHealthResult {
  if (uninstalledAt) return { status: "uninstalled", since: uninstalledAt, reason: "Client désinstallé du poste, jeton révoqué : un nouveau prompt le rebranche." }
  if (!report) {
    if (!lastEventAt) return { status: "never", since: null, reason: "Aucune synchronisation ni activité reçue de ce poste." }
    return { status: "late", since: lastEventAt, reason: "Activité reçue (hooks) mais aucun compte rendu de synchronisation : la synchro planifiée ne tourne pas." }
  }
  if (!report.ok) return { status: "error", since: report.at, reason: report.error ?? "La dernière synchronisation a échoué." }
  const age = now - Date.parse(report.at)
  if (!(age < LATE_AFTER_MS)) return { status: "late", since: report.at, reason: `Dernière synchronisation réussie il y a ${Math.round(age / 60_000)} min (attendue toutes les ${SYNC_EVERY_MS / 60_000} min).` }
  return { status: "ok", since: report.at, reason: "Synchronisation récente." }
}

/** Ordre d'affichage : les postes qui demandent une action d'abord. */
export const HEALTH_ORDER: Record<PosteHealth, number> = { error: 0, late: 1, never: 2, ok: 3, uninstalled: 4 }
