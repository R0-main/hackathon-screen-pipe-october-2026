import { getStore } from "@/lib/store"
import { canRead } from "@/lib/access"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Summary of a zone: state, recent knowledge, entities, tasks. */
export const GET = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  const store = getStore()
  const zone = (await store.listZones()).find((z) => z.id === id)
  if (!zone) return error(404, "Unknown zone.")
  if (!canRead(viewer.access, id)) return error(403, "You don't have access to this zone.")
  const [items, entities, tasks, status, profiles] = await Promise.all([
    // A knowledge item superseded by a more recent version is no longer suggested (MCP get_zone_summary, zone drawer).
    store.listItems({ zones: [id], limit: 60, excludeSuperseded: true }),
    store.topEntities({ zones: [id], limit: 20 }),
    store.listTasks({ zones: [id] }),
    store.getStatus(),
    store.listProfiles(),
  ])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  await store.insertEvents([
    { user_id: viewer.real.id, agent: "dashboard", type: "query", zones: [id], summary: `Viewing the ${zone.name} zone`, at: new Date().toISOString() },
  ])
  return json({
    zone,
    status: status?.zones.find((z) => z.zone === id) ?? null,
    items: items.map((i) => ({ ...i, author: names.get(i.author_id) ?? "?" })),
    entities,
    tasks: tasks.map((t) => ({ ...t, assignee: t.assignee_id ? names.get(t.assignee_id) : undefined })),
  })
})
