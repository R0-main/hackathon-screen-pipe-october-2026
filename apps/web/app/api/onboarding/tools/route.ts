import { storeForOnboardingCode } from "@/lib/onboarding-agent"
import { onboardingConnectors } from "@/lib/remote-mcp"
import { error, internalError, json } from "@/lib/http"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * The onboarding agent (Bearer co_…, the prompt's upload code) lists the tools connected to the brain — Notion, Linear…,
 * connected by the admin on the creation page while it reads — with their read-only tools and input schemas.
 */
export async function GET(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Invalid or expired upload code: copy the prompt again from the Onboarding page.")
    const org = await store.getOrg()
    const connectors = await runInOrg(org.id, () => onboardingConnectors())
    return json({
      connectors: connectors.map((c) => ({ id: c.id, name: c.name, tools: c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) })),
      ...(connectors.length ? {} : { hint: "No tool connected yet: the admin may still be connecting some, check again later." }),
    })
  } catch (err) {
    return internalError(err)
  }
}
