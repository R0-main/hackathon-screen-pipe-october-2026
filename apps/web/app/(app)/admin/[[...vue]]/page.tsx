import { notFound } from "next/navigation"
import { AdminPanel } from "@/components/AdminPanel"
import { ADMIN_VIEWS } from "@/components/admin-views"
import { storeForOrg } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Équipe et accès : /admin (organigramme), /admin/acces, /admin/demandes, /admin/zones. */
export default async function AdminPage({ params }: { params: Promise<{ vue?: string[] }> }) {
  const { vue = [] } = await params
  const view = vue.length <= 1 ? ADMIN_VIEWS.find((v) => v.slug === (vue[0] ?? "")) : undefined
  if (!view) notFound()
  const viewer = await requirePageViewer({ admin: true })
  const store = storeForOrg(viewer.real.org_id)
  const [profiles, access, zones, org] = await Promise.all([store.listProfiles(), store.listZoneAccess(), store.listZones(), store.getOrg()])
  const users = profiles.map((p) => ({ ...p, zones: access.filter((a) => a.user_id === p.id).map((a) => a.zone_id) }))
  return <AdminPanel tab={view.id} orgName={org.name} meId={viewer.real.id} initialUsers={users} initialZones={zones} storeKind={store.kind} />
}
