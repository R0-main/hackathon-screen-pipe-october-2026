import { headers } from "next/headers"
import { ConnectorsPanel } from "@/components/ConnectorsPanel"
import { listConnectors } from "@/lib/connectors"
import { isDemoCompany } from "@/lib/demo-mode"
import { publicBaseUrlFrom } from "@/lib/http"
import { listMcpConnectors, mcpRedirectUri } from "@/lib/remote-mcp"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** Connectors (admins): MCP servers (catalog, OAuth sign-in) and token imports (Notion, Linear, Todoist, ICS). */
export default async function ConnectorsPage() {
  const viewer = await requirePageViewer({ admin: true })
  const [connectors, mcp] = await runInOrg(viewer.real.org_id, () => Promise.all([listConnectors(), listMcpConnectors()]))
  // The public demo's connectors are read-only: shown as they are, nothing to click.
  const readOnly = await isDemoCompany(viewer.real.org_id)
  return <ConnectorsPanel initial={connectors} mcp={mcp} redirectUri={mcpRedirectUri(publicBaseUrlFrom(await headers()))} readOnly={readOnly} />
}
