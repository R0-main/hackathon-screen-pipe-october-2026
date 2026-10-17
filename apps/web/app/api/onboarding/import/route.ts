import {
  addAgentProgress,
  AgentDraftSchema,
  clearAgentDraft,
  clearAgentProgress,
  loadAgentDraft,
  loadAgentProgress,
  saveAgentDraft,
  storeForOnboardingCode,
} from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`

/**
 * Claude Code or Codex uploads its onboarding proposal, with the prompt's upload code (Bearer co_…). It replaces
 * the previous one (the agent sends a first version then completes it) and waits for the admin to review and validate it.
 */
export async function POST(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Invalid or expired upload code: copy the prompt again from the Onboarding page.")
    const body = await parseBody(req, AgentDraftSchema)
    if ("response" in body) return body.response
    // Already a proposal in this run (even if validated since at the zones step): this one completes it.
    const run = await loadAgentProgress(store)
    const previous = run.slice(run.findLastIndex((e) => e.step === "start") + 1).some((e) => e.step === "draft")
    const draft = await saveAgentDraft(store, body.data)
    const counts = `${plural(draft.zones.length, "zone")}, ${plural(draft.items.length, "knowledge item")}`
    await addAgentProgress(store, { step: "draft", message: previous ? `Proposal completed: ${counts}` : `First proposal received: ${counts}` })
    return json({ ok: true, zones: draft.zones.length, items: draft.items.length, review: "Proposal received: review and validate it on screen (company creation, or the dashboard's Onboarding page)." }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins: the pending proposal (null if there is none). The Onboarding page re-reads it to fill itself in. */
export const GET = withViewer(async () => json({ draft: await loadAgentDraft(getStore()) }), { admin: true })

/** Admins: discards the proposal, and the feed of the run that produced it. */
export const DELETE = withViewer(
  async () => {
    await clearAgentDraft(getStore())
    await clearAgentProgress(getStore())
    return json({ ok: true })
  },
  { admin: true },
)
