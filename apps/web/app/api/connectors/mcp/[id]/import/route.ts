import { importMcp } from "@/lib/remote-mcp"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/connectors/mcp/:id/import — imports the connector's content into the brain now (Claude explores it
 * read-only). Returns the import report, successful or not. Admins.
 */
export const POST = withViewer<Ctx>(
  async (_req, viewer, { params }) => {
    const { id } = await params
    return json(await importMcp(viewer, id))
  },
  { admin: true, demoReadOnly: true },
)
