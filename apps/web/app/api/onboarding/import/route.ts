import { verifyOnboardingCode } from "@/lib/auth"
import { AgentDraftSchema, clearAgentDraft, loadAgentDraft, saveAgentDraft } from "@/lib/onboarding-agent"
import { getRootStore, getStore, storeForOrg } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Claude Code ou Codex dépose sa proposition d'onboarding, avec le code d'envoi du prompt (Bearer co_…). Elle remplace
 * la précédente et attend que l'admin la relise et la valide dans la page Onboarding.
 */
export async function POST(req: Request) {
  const code = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  try {
    const userId = await verifyOnboardingCode(code)
    const orgId = userId ? await getRootStore().findUserOrg({ id: userId }) : null
    const store = orgId ? storeForOrg(orgId) : null
    const admin = store && userId ? await store.getProfile(userId) : null
    if (!store || admin?.role !== "admin") return error(401, "Code d'envoi invalide ou expiré : recopiez le prompt depuis la page Onboarding.")
    const body = await parseBody(req, AgentDraftSchema)
    if ("response" in body) return body.response
    const draft = await saveAgentDraft(store, body.data)
    return json({ ok: true, zones: draft.zones.length, items: draft.items.length, review: "Proposition reçue : à relire et valider dans la page Onboarding du dashboard." }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins : la proposition en attente (null s'il n'y en a pas). La page Onboarding la relit pour se remplir toute seule. */
export const GET = withViewer(async () => json({ draft: await loadAgentDraft(getStore()) }), { admin: true })

/** Admins : écarte la proposition. */
export const DELETE = withViewer(
  async () => {
    await clearAgentDraft(getStore())
    return json({ ok: true })
  },
  { admin: true },
)
