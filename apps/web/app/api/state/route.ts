import { getState } from "@/lib/brain"
import { runDueConnectors } from "@/lib/connectors"
import { json, withViewer } from "@/lib/http"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(async (_req, viewer) => {
  const state = await getState(viewer)
  // Due connectors (once an hour) run in the background, without delaying the response or making it fail.
  if (viewer.real.role === "admin") void runInOrg(viewer.real.org_id, () => runDueConnectors(viewer)).catch((err) => console.error("[connectors]", err))
  return json(state)
})
