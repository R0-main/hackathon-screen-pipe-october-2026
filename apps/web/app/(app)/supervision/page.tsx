import { MonitoringPanel } from "@/components/MonitoringPanel"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Supervision (admins) : l'état des postes et les incidents du serveur. */
export default async function MonitoringPage() {
  await requirePageViewer({ admin: true })
  return <MonitoringPanel />
}
