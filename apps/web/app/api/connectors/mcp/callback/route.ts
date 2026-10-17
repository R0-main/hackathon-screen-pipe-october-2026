import { NextResponse } from "next/server"
import { viewerFromRequest } from "@/lib/auth"
import { internalError, publicBaseUrl } from "@/lib/http"
import { completeAuthorize, McpUserError } from "@/lib/remote-mcp"
import { runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/connectors/mcp/callback — retour du fournisseur après la connexion : le navigateur arrive ici avec sa
 * session (cookie SameSite=Lax, navigation de premier niveau), on échange le code puis on revient sur /connecteurs.
 */
export async function GET(req: Request) {
  const base = publicBaseUrl(req)
  const back = (params: Record<string, string>) => NextResponse.redirect(`${base}/connecteurs?${new URLSearchParams(params)}`, 303)
  try {
    const viewer = await viewerFromRequest(req)
    if (!viewer) return NextResponse.redirect(`${base}/login`, 303)
    if (viewer.real.role !== "admin") return back({ mcp: "error", reason: "Réservé aux admins." })
    const q = new URL(req.url).searchParams
    const state = q.get("state")
    if (!state) return back({ mcp: "error", reason: "Retour OAuth sans état." })
    return await runInOrg(viewer.real.org_id, async () => {
      try {
        const id = await completeAuthorize(viewer, { state, code: q.get("code"), error: q.get("error"), error_description: q.get("error_description") })
        return back({ mcp: "connected", id })
      } catch (err) {
        if (err instanceof McpUserError) return back({ mcp: "error", reason: err.message })
        throw err
      }
    })
  } catch (err) {
    internalError(err, "/api/connectors/mcp/callback")
    return back({ mcp: "error", reason: "Erreur interne du cerveau." })
  }
}
