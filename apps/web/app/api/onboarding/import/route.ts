import { verifyOnboardingCode } from "@/lib/auth"
import { AgentDraftSchema, clearAgentDraft, loadAgentDraft, saveAgentDraft } from "@/lib/onboarding-agent"
import { getRootStore, getStore, storeForOrg } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Claude Code or Codex uploads its onboarding proposal, with the prompt's upload code (Bearer co_…). It replaces
 * the previous one and waits for the admin to review and validate it on the Onboarding page.
 */
export async function POST(req: Request) {
  const code = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  try {
    const userId = await verifyOnboardingCode(code)
    const orgId = userId ? await getRootStore().findUserOrg({ id: userId }) : null
    const store = orgId ? storeForOrg(orgId) : null
    const admin = store && userId ? await store.getProfile(userId) : null
    if (!store || admin?.role !== "admin") return error(401, "Invalid or expired upload code: copy the prompt again from the Onboarding page.")
    const body = await parseBody(req, AgentDraftSchema)
    if ("response" in body) return body.response
    const draft = await saveAgentDraft(store, body.data)
    return json({ ok: true, zones: draft.zones.length, items: draft.items.length, review: "Proposal received: review and validate it on the dashboard's Onboarding page." }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins: the pending proposal (null if there is none). The Onboarding page re-reads it to fill itself in. */
export const GET = withViewer(async () => json({ draft: await loadAgentDraft(getStore()) }), { admin: true })

/** Admins: discards the proposal. */
export const DELETE = withViewer(
  async () => {
    await clearAgentDraft(getStore())
    return json({ ok: true })
  },
  { admin: true },
)
