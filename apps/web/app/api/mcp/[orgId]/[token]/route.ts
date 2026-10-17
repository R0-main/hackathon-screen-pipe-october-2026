import { handleMcp } from "@/lib/mcp"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ orgId: string; token: string }> }

/** Serveur MCP d'une entreprise, jeton dans l'adresse : ce que `brain setup` enregistre dans Claude Code et Codex. */
async function handler(req: Request, { params }: Ctx) {
  const { orgId, token } = await params
  return handleMcp(req, orgId, decodeURIComponent(token))
}

export { handler as GET, handler as POST, handler as DELETE }
