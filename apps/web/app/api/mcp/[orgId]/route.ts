import { handleMcp } from "@/lib/mcp"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ orgId: string }> }

/** A company's MCP server, token in the `Authorization: Bearer cb_…` header (for a client that allows it). */
async function handler(req: Request, { params }: Ctx) {
  const { orgId } = await params
  return handleMcp(req, orgId, req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim())
}

export { handler as GET, handler as POST, handler as DELETE }
