import { AdminPanel } from "@/components/AdminPanel"
import { getStore } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  const viewer = await requirePageViewer({ admin: true })
  const store = getStore()
  const [profiles, access, zones, org] = await Promise.all([store.listProfiles(), store.listZoneAccess(), store.listZones(), store.getOrg()])
  const users = profiles.map((p) => ({ ...p, zones: access.filter((a) => a.user_id === p.id).map((a) => a.zone_id) }))
  return <AdminPanel orgName={org.name} meId={viewer.real.id} initialUsers={users} initialZones={zones} storeKind={store.kind} />
}
