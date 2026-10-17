import { z } from "zod"
import { MODERATION_DECISIONS, MODERATION_REASONS, KNOWLEDGE_KINDS } from "@brain/core"
import { claudeKeyInfo } from "@/lib/claude-key"
import { applyModerationVerdicts, loadModerationLog, loadModerationRuns, moderationEnabled, runModeration, setModerationEnabled } from "@/lib/moderation"
import { getStore } from "@/lib/store"
import { error, json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Admins : modérateur actif ou non, d'où vient Claude côté serveur, derniers passages et décisions (sans le texte retiré). */
export const GET = withViewer(async (req) => {
  const [enabled, runs, log, claude] = await Promise.all([moderationEnabled(), loadModerationRuns(), loadModerationLog(), claudeKeyInfo(getStore())])
  return json({ enabled, claude: claude.source, runs, log, base_url: publicBaseUrl(req) })
}, { admin: true })

const ToggleSchema = z.object({ enabled: z.boolean() })

/** Admins : active ou coupe le modérateur (coupé : `brain moderate` et « Lancer maintenant » ne font plus rien). */
export const PUT = withViewer(
  async (req) => {
    const body = await parseBody(req, ToggleSchema)
    if ("response" in body) return body.response
    await setModerationEnabled(body.data.enabled)
    return json({ enabled: await moderationEnabled() })
  },
  { admin: true },
)

const VerdictsSchema = z.object({
  ids: z.array(z.string().max(64)).max(200),
  verdicts: z
    .array(
      z.object({
        id: z.string().max(64),
        decision: z.enum(MODERATION_DECISIONS),
        category: z.enum(MODERATION_REASONS).nullable().default(null),
        reason: z.string().max(500).default(""),
        zone: z.string().max(64).nullable().default(null),
        kind: z.enum(KNOWLEDGE_KINDS).nullable().default(null),
        title: z.string().max(300).nullable().default(null),
        body: z.string().max(8000).nullable().default(null),
      }),
    )
    .max(200),
})

/**
 * Admins. Sans corps : le serveur fait un passage tout de suite, avec la clé API de l'entreprise.
 * Avec `{ids, verdicts}` : applique le passage fait par le Claude Code de l'entreprise (`brain moderate`, abonnement du
 * CEO en CI). Le jeton Claude ne quitte jamais la CI : le cerveau ne reçoit que les décisions.
 */
export const POST = withViewer(
  async (req) => {
    const raw = await req.text()
    if (!raw.trim()) return json(await runModeration())
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Corps JSON invalide.")
    }
    const parsed = VerdictsSchema.safeParse(data)
    if (!parsed.success) return error(400, "Verdicts invalides.")
    if (!(await moderationEnabled())) return error(409, "Le modérateur est coupé (Admin → Zones → Modérateur).")
    return json(await applyModerationVerdicts(parsed.data.ids, parsed.data.verdicts, "claude-code"))
  },
  { admin: true },
)
