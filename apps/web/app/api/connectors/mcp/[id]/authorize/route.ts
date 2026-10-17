import { McpUserError, mcpRedirectUri, startAuthorize } from "@/lib/remote-mcp"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/connectors/mcp/:id/authorize — prépare la connexion OAuth (découverte, client, PKCE) et renvoie l'adresse
 * de la page de connexion du fournisseur, vers laquelle le navigateur est redirigé.
 */
export const POST = withViewer<Ctx>(
  async (req, viewer, { params }) => {
    const { id } = await params
    try {
      return json({ url: await startAuthorize(id, viewer, mcpRedirectUri(publicBaseUrl(req))) })
    } catch (err) {
      if (err instanceof McpUserError) return error(400, err.message)
      throw err
    }
  },
  { admin: true },
)
