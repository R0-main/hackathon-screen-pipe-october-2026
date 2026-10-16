import { getPersonContext } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Passation de poste : le contexte qu'une personne utilise le plus (admins, ou soi-même). */
export const GET = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  if (viewer.real.role !== "admin" && viewer.real.id !== id) return error(403, "Réservé aux admins.")
  const ctx = await getPersonContext(viewer, id)
  return ctx ? json(ctx) : error(404, "Personne introuvable.")
})
