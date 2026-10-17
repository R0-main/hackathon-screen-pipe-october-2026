import { z } from "zod"
import { refreshStatus, saveExternalStatus, statusForViewer } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** State of the company, limited to readable zones (the overall headline is only given to whoever reads all zones). */
export const GET = withViewer(async (_req, viewer) => json(await statusForViewer(viewer)))

const MAX_BODY = 1_000_000

const ZoneStatusSchema = z.object({
  zone: z.string().min(1).max(64),
  summary: z.string().max(8000).default(""),
  objectives: z.array(z.string().max(2000)).max(50).default([]),
  progress: z.string().max(4000).default(""),
  next_steps: z.array(z.string().max(2000)).max(50).default([]),
  who_did_what: z.array(z.object({ person: z.string().max(200), did: z.string().max(2000) })).max(100).default([]),
})

const Schema = z.object({
  status: z.object({ headline: z.string().trim().min(1).max(4000), zones: z.array(ZoneStatusSchema).max(100) }),
})

/**
 * Admins. Without a body: regenerates the state on the server (Claude if ANTHROPIC_API_KEY, otherwise heuristic).
 * With `{status: {headline, zones}}`: saves a summary produced on a workstation (`brain refresh-status`, Claude through
 * the employee's subscription), after validation and redaction, and returns it.
 */
export const POST = withViewer(
  async (req, viewer) => {
    const raw = await req.text()
    if (raw.length > MAX_BODY) return error(413, "Summary too large.")
    if (!raw.trim()) return json(await refreshStatus(viewer))
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Invalid JSON body.")
    }
    // Only an empty body (or {}) reruns the computation on the server: a badly wrapped summary must not overwrite Claude's.
    if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) return json(await refreshStatus(viewer))
    if (data === null || typeof data !== "object" || Array.isArray(data) || !("status" in data))
      return error(400, "Invalid status summary: send { \"status\": { \"headline\": …, \"zones\": […] } }, or an empty body to recompute.")
    const parsed = Schema.safeParse(data)
    if (!parsed.success) return error(400, "Invalid status summary.", parsed.error.issues.slice(0, 5))
    const saved = await saveExternalStatus(viewer, parsed.data.status)
    if (!saved) return error(400, "Invalid status summary: no zone known to the company.")
    return json(saved)
  },
  { admin: true },
)
