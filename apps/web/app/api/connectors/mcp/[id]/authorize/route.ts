import { isMcpReturn } from "@brain/core"
import { McpUserError, mcpRedirectUri, startAuthorize } from "@/lib/remote-mcp"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/connectors/mcp/:id/authorize — prepares the OAuth connection (discovery, client, PKCE) and returns the
 * address of the provider's sign-in page, to which the browser is redirected. Optional body:
 * `{ return_to: "connectors" | "create" }`, the page to come back to afterwards.
 */
export const POST = withViewer<Ctx>(
  async (req, viewer, { params }) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { return_to?: unknown } | null
    const returnTo = isMcpReturn(body?.return_to) ? body.return_to : "connectors"
    try {
      return json({ url: await startAuthorize(id, viewer, mcpRedirectUri(publicBaseUrl(req)), returnTo) })
    } catch (err) {
      if (err instanceof McpUserError) return error(400, err.message)
      throw err
    }
  },
  { admin: true },
)
