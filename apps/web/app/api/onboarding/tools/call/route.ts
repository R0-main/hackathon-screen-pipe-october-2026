import { z } from "zod"
import { storeForOnboardingCode } from "@/lib/onboarding-agent"
import { callOnboardingTool, McpUserError } from "@/lib/remote-mcp"
import { error, internalError, json, parseBody } from "@/lib/http"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const Schema = z.object({
  connector: z.string().min(1).max(80),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

/**
 * The onboarding agent calls a read-only tool of a connected server (Bearer co_…), to shape the zones and the first
 * knowledge from the company's tools. Write tools are refused (403).
 */
export async function POST(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Invalid or expired upload code: copy the prompt again from the Onboarding page.")
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const org = await store.getOrg()
    try {
      return json(await runInOrg(org.id, () => callOnboardingTool(body.data.connector, body.data.tool, body.data.arguments ?? {})))
    } catch (err) {
      if (err instanceof McpUserError) return error(err.status, err.message)
      return error(502, `The tool did not answer: ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    return internalError(err)
  }
}
