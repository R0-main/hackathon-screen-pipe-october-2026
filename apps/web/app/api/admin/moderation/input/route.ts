import { moderationInput } from "@/lib/moderation"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins: the material for a moderator run (knowledge that arrived since the previous run, numbered, with their id and
 * the close knowledge already in place), for the company's Claude Code (`brain moderate`).
 * `{skipped: "nothing" | "off"}` if there is nothing to review.
 */
export const GET = withViewer(async () => json(await moderationInput()), { admin: true })
