import { newZonesInput } from "@/lib/new-zones"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins : la matière d'un passage « nouvelles zones » (zones, connaissances récentes numérotées), pour que le Claude
 * Code de l'entreprise fasse l'analyse avec son abonnement (`brain refresh-zones`). `{skipped}` s'il n'y a rien à faire.
 */
export const GET = withViewer(async () => json(await newZonesInput()), { admin: true })
