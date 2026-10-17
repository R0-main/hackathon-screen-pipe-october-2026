import { z } from "zod"
import { getStore } from "@/lib/store"
import { itemAuthorOrAdmin } from "@/lib/brain"
import { error, json, parseBody, withViewer } from "@/lib/http"

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

const PatchSchema = z.object({ current: z.literal(true) })

/** Marquée « remplacée » à tort : l'auteur (ou un admin) la rend de nouveau d'actualité. */
export const PATCH = withViewer<Ctx>(async (req, viewer, { params }) => {
  const { id } = await params
  const body = await parseBody(req, PatchSchema)
  if ("response" in body) return body.response
  const store = getStore()
  const item = await store.getItem(id)
  if (!item) return error(404, "Connaissance introuvable.")
  if (!itemAuthorOrAdmin(viewer, item)) return error(403, "Seul l'auteur ou un admin peut modifier cette connaissance.")
  const restored = await store.restoreItem(id)
  return json({ id, current: !restored?.superseded_by })
})
