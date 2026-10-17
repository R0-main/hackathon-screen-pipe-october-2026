import { checkMcp, McpUserError } from "@/lib/remote-mcp"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** POST /api/connectors/mcp/:id/test — teste la connexion : liste des outils du serveur (jeton rafraîchi au besoin). */
export const POST = withViewer<Ctx>(
  async (_req, _viewer, { params }) => {
    const { id } = await params
    try {
      return json(await checkMcp(id))
    } catch (err) {
      if (err instanceof McpUserError) return error(400, err.message)
      throw err
    }
  },
  { admin: true },
)
