import { z } from "zod"
import { applyAgentProposals, loadNewZonesLog, runNewZones } from "@/lib/new-zones"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Admins: history of the "new zones" job runs (most recent first), and the brain's URL for CI. */
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
 * Admins. Without a body: the server runs a pass right away with the company's API key.
 * With `{zones: [...]}`: applies what the company's Claude Code proposed (`brain refresh-zones`, subscription),
 * with the same safeguards. The Claude token never leaves the company's workstation or CI.
 */
export const POST = withViewer(
  async (req) => {
    const raw = await req.text()
    if (!raw.trim()) return json(await runNewZones())
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Invalid JSON body.")
    }
    const parsed = AgentSchema.safeParse(data)
    if (!parsed.success) return error(400, "Invalid proposal: send { \"zones\": [{ name, description, keywords, item_ids }] }.", parsed.error.issues.slice(0, 5))
    return json(await applyAgentProposals(parsed.data.zones))
  },
  { admin: true },
)
