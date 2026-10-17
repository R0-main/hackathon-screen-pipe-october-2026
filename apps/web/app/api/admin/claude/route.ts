import { z } from "zod"
import { CLAUDE_KEY_RE, claudeKeyInfo, clearOrgClaudeKey, setOrgClaudeKey, verifyClaudeKey } from "@/lib/claude-key"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({ key: z.string().trim().max(300) })

/** Admins : d'où vient Claude pour l'entreprise (sa clé, celle du serveur, ou aucune), sans jamais la clé elle-même. */
export const GET = withViewer(async () => json(await claudeKeyInfo(getStore())), { admin: true })

/** Admins : enregistre la clé API de l'entreprise, après l'avoir essayée auprès d'Anthropic. */
export const PUT = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const key = body.data.key
    if (!CLAUDE_KEY_RE.test(key)) return error(400, "Ce n'est pas une clé API Claude : elle commence par « sk-ant- » (Console Anthropic, rubrique API Keys).")
    const check = await verifyClaudeKey(key)
    if (!check.ok) return error(check.reason === "invalid" ? 400 : 502, check.message)
    return json(await setOrgClaudeKey(getStore(), key, viewer.real.id))
  },
  { admin: true },
)

/** Admins : retire la clé de l'entreprise (le serveur retombe sur ANTHROPIC_API_KEY s'il en a une). */
export const DELETE = withViewer(
  async () => {
    await clearOrgClaudeKey(getStore())
    return json(await claudeKeyInfo(getStore()))
  },
  { admin: true },
)
