import { handleMcp } from "@/lib/mcp"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ orgId: string }> }

/** Serveur MCP d'une entreprise, jeton en en-tête `Authorization: Bearer cb_…` (pour un client qui le permet). */
async function handler(req: Request, { params }: Ctx) {
  const { orgId } = await params
  return handleMcp(req, orgId, req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim())
}

export { handler as GET, handler as POST, handler as DELETE }
