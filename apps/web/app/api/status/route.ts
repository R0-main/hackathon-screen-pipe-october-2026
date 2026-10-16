import { refreshStatus, statusForViewer } from "@/lib/brain"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** État de l'entreprise, limité aux zones lisibles (le titre global n'est donné qu'à qui lit toutes les zones). */
export const GET = withViewer(async (_req, viewer) => json(await statusForViewer(viewer)))

/** Régénère l'état (Claude si ANTHROPIC_API_KEY, sinon heuristique). */
export const POST = withViewer(async (_req, viewer) => json(await refreshStatus(viewer)), { admin: true })
