import { z } from "zod"
import { MODERATION_DECISIONS, MODERATION_REASONS, KNOWLEDGE_KINDS, moderationReason } from "@brain/core"
import { claudeKeyInfo } from "@/lib/claude-key"
import { applyModerationVerdicts, loadModerationLog, loadModerationRuns, moderationEnabled, runModeration, setModerationEnabled } from "@/lib/moderation"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Admins: whether the moderator is on, where Claude comes from on the server side, latest runs and decisions (without the removed text). */
export const GET = withViewer(async () => {
  const [enabled, runs, log, claude] = await Promise.all([moderationEnabled(), loadModerationRuns(), loadModerationLog(), claudeKeyInfo(getStore())])
  return json({ enabled, claude: claude.source, runs, log })
}, { admin: true })

const ToggleSchema = z.object({ enabled: z.boolean() })

/** Admins: turns the moderator on or off (off: `brain moderate` and "Run now" no longer do anything). */
export const PUT = withViewer(
  async (req) => {
    const body = await parseBody(req, ToggleSchema)
    if ("response" in body) return body.response
    await setModerationEnabled(body.data.enabled)
    return json({ enabled: await moderationEnabled() })
  },
  { admin: true },
)

const VerdictsSchema = z.object({
  ids: z.array(z.string().max(64)).max(200),
  verdicts: z
    .array(
      z.object({
        id: z.string().max(64),
        decision: z.enum(MODERATION_DECISIONS),
        // Older clients send the earlier (French) reason ids.
        category: z.preprocess((c) => (typeof c === "string" ? (moderationReason(c) ?? c) : c), z.enum(MODERATION_REASONS).nullable().default(null)),
        reason: z.string().max(500).default(""),
        zone: z.string().max(64).nullable().default(null),
        kind: z.enum(KNOWLEDGE_KINDS).nullable().default(null),
        title: z.string().max(300).nullable().default(null),
        body: z.string().max(8000).nullable().default(null),
      }),
    )
    .max(200),
})

/**
 * Admins. Without a body: the server does a run right away, with the company's API key.
 * With `{ids, verdicts}`: applies the run done by Claude Code on an admin's computer (`brain moderate`, started by
 * their sync every 15 min). The Claude token never leaves the computer: the brain only receives the decisions.
 */
export const POST = withViewer(
  async (req) => {
    const raw = await req.text()
    if (!raw.trim()) return json(await runModeration())
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return error(400, "Invalid JSON body.")
    }
    const parsed = VerdictsSchema.safeParse(data)
    if (!parsed.success) return error(400, "Invalid verdicts.")
    if (!(await moderationEnabled())) return error(409, "The moderator is off (Admin → Zones → Moderator).")
    return json(await applyModerationVerdicts(parsed.data.ids, parsed.data.verdicts, "claude-code"))
  },
  { admin: true },
)
