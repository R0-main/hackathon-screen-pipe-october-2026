import { z } from "zod"
import { callAgentTool, McpUserError } from "@/lib/remote-mcp"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const Schema = z.object({
  connector: z.string().min(1).max(80),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

/**
 * POST /api/connected-tools/call — un agent appelle un outil d'un connecteur MCP, avec le compte branché par l'admin et
 * dans les limites qu'il a choisies (lecture seule par défaut). Réponse : le texte rendu par l'outil.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    return json(await callAgentTool(viewer, body.data.connector, body.data.tool, body.data.arguments ?? {}))
  } catch (err) {
    if (err instanceof McpUserError) return error(err.status, err.message)
    // Serveur distant injoignable, jeton révoqué, réponse illisible : l'agent reçoit la raison.
    return error(502, `L'outil n'a pas répondu : ${err instanceof Error ? err.message : String(err)}`)
  }
})
