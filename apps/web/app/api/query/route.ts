import { QueryPayloadSchema } from "@brain/core"
import { queryBrain } from "@/lib/brain"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** An agent (MCP, dashboard) queries the brain, within the user's zones. */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, QueryPayloadSchema)
  if ("response" in body) return body.response
  return json(await queryBrain(viewer, { ...body.data, agent: body.data.agent ?? "mcp" }))
})
