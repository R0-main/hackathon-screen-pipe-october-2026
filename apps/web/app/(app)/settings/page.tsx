import { SettingsPanel } from "@/components/SettingsPanel"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Settings: how the brain searches and what agents receive. Admins change them, members read them. */
export default async function SettingsPage() {
  await requirePageViewer()
  return <SettingsPanel />
}
