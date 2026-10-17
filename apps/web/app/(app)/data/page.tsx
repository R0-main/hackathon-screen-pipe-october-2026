import { PageScroll } from "@/components/AppShell"
import { DataPanel } from "@/components/DataPanel"
import { canPublishSkills } from "@/lib/skills"
import { storeForOrg } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Import and export: the brain, its skills, its clients and the employee sheets. */
export default async function DataPage() {
  const viewer = await requirePageViewer()
  const isAdmin = viewer.real.role === "admin"
  const store = storeForOrg(viewer.real.org_id)
  const [profiles, zones] = await Promise.all([isAdmin ? store.listProfiles() : Promise.resolve([]), store.listZones()])
  const people = profiles
    .map((p) => ({ id: p.id, name: p.name, title: p.title }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <PageScroll width="max-w-[900px]">
      <DataPanel
        isAdmin={isAdmin}
        canPublish={canPublishSkills(viewer)}
        meId={viewer.real.id}
        people={people}
        zones={zones.map((z) => ({ id: z.id, name: z.name }))}
      />
    </PageScroll>
  )
}
