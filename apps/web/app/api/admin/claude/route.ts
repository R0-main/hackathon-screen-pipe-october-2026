import { z } from "zod"
import { CLAUDE_KEY_RE, claudeKeyInfo, clearOrgClaudeKey, setOrgClaudeKey, verifyClaudeKey } from "@/lib/claude-key"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ key: z.string().trim().max(300) })

/** Admins: where the company's Claude comes from (its key, the server's, or none), never the key itself. */
export const GET = withViewer(async () => json(await claudeKeyInfo(getStore())), { admin: true })

/** Admins: saves the company's API key, after trying it against Anthropic. */
export const PUT = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const key = body.data.key
    if (!CLAUDE_KEY_RE.test(key)) return error(400, "This is not a Claude API key: it starts with \"sk-ant-\" (Anthropic Console, API Keys section).")
    const check = await verifyClaudeKey(key)
    if (!check.ok) return error(check.reason === "invalid" ? 400 : 502, check.message)
    return json(await setOrgClaudeKey(getStore(), key, viewer.real.id))
  },
  { admin: true },
)

/** Admins: removes the company's key (the server falls back to ANTHROPIC_API_KEY if it has one). */
export const DELETE = withViewer(
  async () => {
    await clearOrgClaudeKey(getStore())
    return json(await claudeKeyInfo(getStore()))
  },
  { admin: true },
)
