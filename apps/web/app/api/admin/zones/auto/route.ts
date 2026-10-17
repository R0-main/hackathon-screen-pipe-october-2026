import { loadNewZonesLog, runNewZones } from "@/lib/new-zones"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Admins : historique des passages du job « nouvelles zones » (le plus récent d'abord). */
export const GET = withViewer(async () => json({ runs: await loadNewZonesLog() }), { admin: true })

/** Admins : lance tout de suite le passage quotidien pour leur entreprise (mêmes garde-fous, rien à valider). */
export const POST = withViewer(async () => json(await runNewZones()), { admin: true })
