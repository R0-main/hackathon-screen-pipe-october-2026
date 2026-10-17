import { z } from "zod"
import { refreshStatus, saveExternalStatus, statusForViewer } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** État de l'entreprise, limité aux zones lisibles (le titre global n'est donné qu'à qui lit toutes les zones). */
export const GET = withViewer(async (_req, viewer) => json(await statusForViewer(viewer)))

const MAX_BODY = 1_000_000

const ZoneStatusSchema = z.object({
  zone: z.string().min(1).max(64),
  summary: z.string().max(8000).default(""),
  objectives: z.array(z.string().max(2000)).max(50).default([]),
  progress: z.string().max(4000).default(""),
  next_steps: z.array(z.string().max(2000)).max(50).default([]),
  who_did_what: z.array(z.object({ person: z.string().max(200), did: z.string().max(2000) })).max(100).default([]),
})

const Schema = z.object({
  status: z.object({ headline: z.string().trim().min(1).max(4000), zones: z.array(ZoneStatusSchema).max(100) }),
})

/**
 * Admins. Sans corps : régénère l'état côté serveur (Claude si ANTHROPIC_API_KEY, sinon heuristique).
 * Avec `{status: {headline, zones}}` : enregistre un résumé produit sur un poste (`brain refresh-status`, Claude via
 * l'abonnement de l'employé), après validation et masquage, et le renvoie.
 */
export const POST = withViewer(
  async (req, viewer) => {
    const raw = await req.text()
    if (raw.length > MAX_BODY) return error(413, "Résumé trop volumineux.")
    if (!raw.trim()) return json(await refreshStatus(viewer))
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Corps JSON invalide.")
    }
    // Seul un corps vide (ou {}) relance le calcul côté serveur : un résumé mal emballé ne doit pas écraser celui de Claude.
    if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) return json(await refreshStatus(viewer))
    if (data === null || typeof data !== "object" || Array.isArray(data) || !("status" in data))
      return error(400, "Résumé d'état invalide : envoyez { \"status\": { \"headline\": …, \"zones\": […] } }, ou un corps vide pour recalculer.")
    const parsed = Schema.safeParse(data)
    if (!parsed.success) return error(400, "Résumé d'état invalide.", parsed.error.issues.slice(0, 5))
    const saved = await saveExternalStatus(viewer, parsed.data.status)
    if (!saved) return error(400, "Résumé d'état invalide : aucune zone connue de l'entreprise.")
    return json(saved)
  },
  { admin: true },
)
