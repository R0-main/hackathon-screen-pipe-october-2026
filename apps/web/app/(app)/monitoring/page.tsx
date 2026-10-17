import { MonitoringPanel } from "@/components/MonitoringPanel"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Monitoring (admins): the state of the workstations and the server's incidents. */
export default async function MonitoringPage() {
  await requirePageViewer({ admin: true })
  return <MonitoringPanel />
}
