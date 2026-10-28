import { getStore } from "@/lib/store"
import { getKnowledgeFor, itemAuthorOrAdmin } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** A knowledge item the viewer reads (its zone, or their own), with its author's name and its documents: get_knowledge. */
export const GET = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  const item = await getKnowledgeFor(viewer, id)
  return item ? json({ item }) : error(404, "Knowledge item not found.")
})

/** Right of review: the employee (or an admin) can delete a piece of knowledge coming from their sessions. */
export const DELETE = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  const store = getStore()
  const item = await store.getItem(id)
  if (!item) return error(404, "Knowledge item not found.")
  if (!itemAuthorOrAdmin(viewer, item)) return error(403, "Only the author or an admin can delete this knowledge.")
  await store.deleteItem(id)
  return json({ deleted: id })
})
