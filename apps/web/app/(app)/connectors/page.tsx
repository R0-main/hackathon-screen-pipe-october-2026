import { ConnectorsPanel } from "@/components/ConnectorsPanel"
import { listConnectors } from "@/lib/connectors"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** Connectors (admins): Notion, Linear, Todoist, ICS calendar. */
export default async function ConnectorsPage() {
  const viewer = await requirePageViewer({ admin: true })
  const connectors = await runInOrg(viewer.real.org_id, () => listConnectors())
  return <ConnectorsPanel initial={connectors} />
}
