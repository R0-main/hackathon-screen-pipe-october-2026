import { isConnectorId } from "@brain/core"
import { runConnector } from "@/lib/connectors"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

type Ctx = { params: Promise<{ id: string }> }

/** POST /api/connectors/:id/sync — syncs now; answers 200 with the result, successful or not. */
export const POST = withViewer<Ctx>(
  async (_req, viewer, { params }) => {
    const { id } = await params
    if (!isConnectorId(id)) return error(404, "Unknown connector.")
    return json(await runConnector(viewer, id))
  },
  { admin: true, demoReadOnly: true },
)
