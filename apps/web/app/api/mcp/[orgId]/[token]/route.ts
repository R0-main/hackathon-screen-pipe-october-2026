import { handleMcp } from "@/lib/mcp"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ orgId: string; token: string }> }

/** A company's MCP server, token in the address: what `brain setup` registers in Claude Code and Codex. */
async function handler(req: Request, { params }: Ctx) {
  const { orgId, token } = await params
  return handleMcp(req, orgId, decodeURIComponent(token))
}

export { handler as GET, handler as POST, handler as DELETE }
