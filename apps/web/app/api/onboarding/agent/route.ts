import { createOnboardingCode, ONBOARDING_CODE_HOURS } from "@/lib/auth"
import { buildOnboardingAgentPrompt } from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Admins: the prompt that has Claude Code or Codex prepare the onboarding, with a fresh upload code (2 h). */
export const POST = withViewer(
  async (req, viewer) => {
    const store = getStore()
    const [org, zones, code] = await Promise.all([store.getOrg(), store.listZones(), createOnboardingCode(viewer.real.id)])
    const prompt = buildOnboardingAgentPrompt({ baseUrl: publicBaseUrl(req), code, orgName: org.name, description: org.description, zones })
    return json({ prompt, expires_in: ONBOARDING_CODE_HOURS * 3600 })
  },
  { admin: true },
)
