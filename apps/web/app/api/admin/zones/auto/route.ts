import { z } from "zod"
import { runDailyReview } from "@/lib/daily-review"
import { applyAgentProposals, loadNewZonesLog } from "@/lib/new-zones"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Admins : historique des passages du job « nouvelles zones » (le plus récent d'abord), et l'URL du cerveau pour la CI. */
export const GET = withViewer(async (req) => json({ runs: await loadNewZonesLog(), base_url: publicBaseUrl(req) }), { admin: true })

const AgentSchema = z.object({
  zones: z
    .array(
      z.object({
        name: z.string().max(80),
        description: z.string().max(600).default(""),
        keywords: z.array(z.string().max(60)).max(50).default([]),
        item_ids: z.array(z.string().max(64)).max(300),
      }),
    )
    .max(5),
})

/**
 * Admins. Sans corps : le serveur lance tout de suite la revue quotidienne (nouvelles zones, automatisations, état) avec
 * Claude (clé de l'entreprise, sinon celle du serveur).
 * Avec `{zones: [...]}` : applique ce qu'a proposé le Claude Code de l'entreprise (`brain refresh-zones`, abonnement),
 * avec les mêmes garde-fous. Le jeton Claude ne quitte jamais le poste ou la CI de l'entreprise.
 */
export const POST = withViewer(
  async (req) => {
    const raw = await req.text()
    if (!raw.trim()) {
      const review = await runDailyReview()
      return json({ ...review.zones, review: { automations: review.automations, status: review.status } })
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Corps JSON invalide.")
    }
    const parsed = AgentSchema.safeParse(data)
    if (!parsed.success) return error(400, "Proposition invalide : envoyez { \"zones\": [{ name, description, keywords, item_ids }] }.", parsed.error.issues.slice(0, 5))
    return json(await applyAgentProposals(parsed.data.zones))
  },
  { admin: true },
)
