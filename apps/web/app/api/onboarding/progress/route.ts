import { addAgentProgress, AgentProgressSchema, loadAgentProgress, storeForOnboardingCode } from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Claude Code ou Codex signale où il en est (Bearer co_…, le code d'envoi du prompt) : départ, trouvailles, fin. La page
 * de création et la page Onboarding en font des notifications ; rien n'est appliqué ici.
 */
export async function POST(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Code d'envoi invalide ou expiré : recopiez le prompt depuis la page Onboarding.")
    const body = await parseBody(req, AgentProgressSchema)
    if ("response" in body) return body.response
    const event = await addAgentProgress(store, body.data)
    return json({ ok: true, id: event.id }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins : le fil du passage en cours (2 dernières heures). */
export const GET = withViewer(async () => json({ events: await loadAgentProgress(getStore()) }), { admin: true })
