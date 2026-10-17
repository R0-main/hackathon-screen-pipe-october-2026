import { EventsPayloadSchema } from "@brain/core"
import { recordEvents } from "@/lib/brain"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Claude Code hooks, MCP, brain-sync: what makes the brain light up. */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, EventsPayloadSchema)
  if ("response" in body) return body.response
  const inputs = "events" in body.data ? body.data.events : [body.data]
  const events = await recordEvents(viewer, inputs)
  return json({ recorded: events.length, ids: events.map((e) => e.id), zones: [...new Set(events.flatMap((e) => e.zones))] }, 201)
})
