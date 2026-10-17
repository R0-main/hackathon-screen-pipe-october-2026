// Revue quotidienne d'une entreprise (cron de 10 h, ou « Lancer maintenant ») : nouvelles zones, revue des
// automatisations, puis « où en est la boîte ». Tout tourne sur le serveur avec Claude : la clé de l'entreprise si un
// admin en a réglé une, sinon celle du serveur (ANTHROPIC_API_KEY) ; rien n'est demandé aux postes.

import { getAccess } from "./access"
import { getClaude } from "./ai"
import { refreshStatus, runAutomationDetection } from "./brain"
import { runNewZones, type NewZonesRun } from "./new-zones"
import { getStore } from "./store"

export type DailyReview = {
  zones: NewZonesRun
  /** Suggestions d'automatisation détectées ce jour (relues par Claude s'il est disponible). */
  automations: { count: number; reviewed: boolean }
  /** Résumé « où en est la boîte » rédigé par Claude ; jamais remplacé par l'heuristique (un résumé de poste resterait écrasé). */
  status: "claude" | "skipped"
}

export async function runDailyReview(): Promise<DailyReview> {
  const claude = await getClaude()
  const zones = await runNewZones()
  const automations = await runAutomationDetection()
  let status: DailyReview["status"] = "skipped"
  const admin = claude ? (await getStore().listProfiles()).find((p) => p.role === "admin") : undefined
  if (admin) {
    const s = await refreshStatus({ profile: admin, real: admin, access: await getAccess(admin) })
    if (s.generator === "claude") status = "claude"
  }
  return { zones, automations: { count: automations.length, reviewed: Boolean(claude) }, status }
}
