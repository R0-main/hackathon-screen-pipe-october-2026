import { addAgentProgress, AgentProgressSchema, loadAgentProgress, storeForOnboardingCode } from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Claude Code or Codex reports where it stands (Bearer co_…, the prompt's upload code): start, findings, end. The
 * creation page and the Onboarding page turn them into notifications; nothing is applied here.
 */
export async function POST(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Invalid or expired upload code: copy the prompt again from the Onboarding page.")
    const body = await parseBody(req, AgentProgressSchema)
    if ("response" in body) return body.response
    const event = await addAgentProgress(store, body.data)
    return json({ ok: true, id: event.id }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins: the feed of the current run (last 2 hours). */
export const GET = withViewer(async () => json({ events: await loadAgentProgress(getStore()) }), { admin: true })
