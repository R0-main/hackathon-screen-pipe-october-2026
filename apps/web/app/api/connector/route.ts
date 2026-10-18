import { createConnectorKey } from "@/lib/auth"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"
import { getStore } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The address of the company's MCP server for Claude (Settings → Connectors), with a member's connector key: one's
 * own, or any member's for an admin. Recomputed on each call, the same until the member's token is regenerated.
 */
export const GET = withViewer(async (req, viewer) => {
  const userId = new URL(req.url).searchParams.get("user") || viewer.real.id
  if (userId !== viewer.real.id && viewer.real.role !== "admin") return error(403, "Admins only.")
  const store = getStore()
  const [person, org] = await Promise.all([store.getProfile(userId), store.getOrg()])
  if (!person) return error(404, "Member not found.")
  const key = await createConnectorKey(person.id)
  return json({
    name: person.name,
    connector_name: `NOS Brainer (${org.name})`,
    url: `${publicBaseUrl(req)}/api/mcp/${encodeURIComponent(org.id)}/${encodeURIComponent(key)}`,
  })
})
