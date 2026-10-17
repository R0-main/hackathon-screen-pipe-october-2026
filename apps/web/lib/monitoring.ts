// Supervision côté serveur : incidents récents (erreurs des routes), alertes par webhook, informations d'instance.
//
// Les incidents vivent en mémoire (tampon circulaire par processus) : assez pour « que s'est-il passé ces dernières
// heures » sur la page Supervision, sans table ni dépendance. BRAIN_ALERT_WEBHOOK (URL, JSON `{ text }` compatible
// Slack, Discord via /slack, Mattermost, n8n…) reçoit une alerte par clé au plus une fois par ALERT_TTL_MS.

export type Incident = {
  id: number
  at: string
  /** Route ou tâche concernée (chemin sans paramètres de requête). */
  where: string
  message: string
  /** Répétitions du même incident (même route, même message) depuis la première occurrence. */
  count: number
  last_at: string
}

type MonitoringState = {
  started: number
  seq: number
  incidents: Incident[]
  alerted: Map<string, number>
}

const INCIDENTS_MAX = 100
const ALERT_TTL_MS = 60 * 60_000
const WEBHOOK_TIMEOUT_MS = 5_000

const g = globalThis as unknown as { __brainMonitoring?: MonitoringState }
const state: MonitoringState = (g.__brainMonitoring ??= { started: Date.now(), seq: 0, incidents: [] as Incident[], alerted: new Map<string, number>() })

export const SERVER_VERSION = process.env.npm_package_version ?? "0.1.0"

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500)
  return String(err).slice(0, 500)
}

/** Enregistre une erreur inattendue d'une route (déjà journalisée par l'appelant) et prévient par webhook. */
export function recordIncident(where: string, err: unknown): Incident {
  const message = describe(err)
  const now = new Date().toISOString()
  const same = state.incidents.find((i) => i.where === where && i.message === message)
  if (same) {
    same.count++
    same.last_at = now
    void sendAlert(`incident:${where}:${message}`, `Erreur répétée sur ${where} (${same.count} fois) : ${message}`)
    return same
  }
  const incident: Incident = { id: ++state.seq, at: now, where, message, count: 1, last_at: now }
  state.incidents.unshift(incident)
  if (state.incidents.length > INCIDENTS_MAX) state.incidents.length = INCIDENTS_MAX
  void sendAlert(`incident:${where}:${message}`, `Erreur sur ${where} : ${message}`)
  return incident
}

export function listIncidents(limit = 30): Incident[] {
  return state.incidents.slice(0, limit)
}

/** Chemin d'une requête sans ses paramètres (jamais de jeton ni de recherche dans un incident). */
export function routeOf(req: Request): string {
  try {
    const u = new URL(req.url)
    return `${req.method} ${u.pathname}`
  } catch {
    return req.method
  }
}

/**
 * Alerte par webhook, au plus une fois par `key` et par heure. Ne lève jamais : une alerte perdue ne doit pas casser
 * la route qui l'a déclenchée. Sans BRAIN_ALERT_WEBHOOK : rien n'est envoyé (renvoie false).
 */
export async function sendAlert(key: string, text: string): Promise<boolean> {
  const url = process.env.BRAIN_ALERT_WEBHOOK
  if (!url) return false
  const now = Date.now()
  for (const [k, at] of state.alerted) if (now - at > ALERT_TTL_MS) state.alerted.delete(k)
  if (state.alerted.has(key)) return false
  state.alerted.set(key, now)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[NOS Brainer] ${text}`, source: "company-brain", at: new Date(now).toISOString() }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    if (!res.ok) console.error(`[alert] webhook ${res.status}`)
    return res.ok
  } catch (err) {
    console.error("[alert] webhook injoignable :", err instanceof Error ? err.message : err)
    return false
  }
}

export function serverInfo() {
  return {
    version: SERVER_VERSION,
    uptime_s: Math.round((Date.now() - state.started) / 1000),
    node: process.version,
    vercel: Boolean(process.env.VERCEL),
    alert_webhook: Boolean(process.env.BRAIN_ALERT_WEBHOOK),
  }
}

/** Réservé aux tests : vide incidents et alertes. */
export function resetMonitoring() {
  state.incidents = []
  state.alerted.clear()
}
