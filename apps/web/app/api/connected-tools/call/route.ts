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
 * POST /api/connected-tools/call — an agent calls a tool of an MCP connector, with the account the admin connected and
 * within the limits they chose (read-only by default). Response: the text the tool returned.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    return json(await callAgentTool(viewer, body.data.connector, body.data.tool, body.data.arguments ?? {}))
  } catch (err) {
    if (err instanceof McpUserError) return error(err.status, err.message)
    // Remote server unreachable, token revoked, unreadable response: the agent gets the reason.
    return error(502, `The tool did not answer: ${err instanceof Error ? err.message : String(err)}`)
  }
})
