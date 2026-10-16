import { getStore } from "@/lib/store"
import { canRead } from "@/lib/access"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Résumé d'une zone : état, connaissances récentes, entités, tâches. */
export const GET = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  const store = getStore()
  const zone = (await store.listZones()).find((z) => z.id === id)
  if (!zone) return error(404, "Zone inconnue.")
  if (!canRead(viewer.access, id)) return error(403, "Vous n'avez pas accès à cette zone.")
  const [items, entities, tasks, status, profiles] = await Promise.all([
    store.listItems({ zones: [id], limit: 60 }),
    store.topEntities({ zones: [id], limit: 20 }),
    store.listTasks({ zones: [id] }),
    store.getStatus(),
    store.listProfiles(),
  ])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  await store.insertEvents([
    { user_id: viewer.real.id, agent: "dashboard", type: "query", zones: [id], summary: `Consulte la zone ${zone.name}`, at: new Date().toISOString() },
  ])
  return json({
    zone,
    status: status?.zones.find((z) => z.zone === id) ?? null,
    items: items.map((i) => ({ ...i, author: names.get(i.author_id) ?? "?" })),
    entities,
    tasks: tasks.map((t) => ({ ...t, assignee: t.assignee_id ? names.get(t.assignee_id) : undefined })),
  })
})
