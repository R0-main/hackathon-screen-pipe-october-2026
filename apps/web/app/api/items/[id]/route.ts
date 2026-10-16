import { getStore } from "@/lib/store"
import { itemAuthorOrAdmin } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Droit de regard : l'employé (ou un admin) peut supprimer une connaissance issue de ses sessions. */
export const DELETE = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  const store = getStore()
  const item = await store.getItem(id)
  if (!item) return error(404, "Connaissance introuvable.")
  if (!itemAuthorOrAdmin(viewer, item)) return error(403, "Seul l'auteur ou un admin peut supprimer cette connaissance.")
  await store.deleteItem(id)
  return json({ deleted: id })
})
