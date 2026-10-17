import { McpUserError, mcpRedirectUri, startAuthorize } from "@/lib/remote-mcp"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/connectors/mcp/:id/authorize — prepares the OAuth connection (discovery, client, PKCE) and returns the
 * address of the provider's sign-in page, to which the browser is redirected.
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
