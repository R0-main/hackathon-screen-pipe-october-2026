import { getStatusInput } from "@/lib/brain"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins : la matière du résumé « où en est la boîte » (zones, connaissances des 30 derniers jours, tâches), pour le
 * générer sur un poste avec Claude (`brain refresh-status`, via l'abonnement de l'employé) puis le renvoyer en POST /api/status.
 */
export const GET = withViewer(async () => json(await getStatusInput()), { admin: true })
