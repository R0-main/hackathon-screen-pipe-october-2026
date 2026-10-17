import { getPersonContext } from "@/lib/brain"
import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Le contexte du poste : qui je suis, mes zones, ce que mon poste utilise le plus (utile pour la passation). */
export const GET = withViewer(async (_req, viewer) => {
  const [org, context] = await Promise.all([getStore().getOrg(), getPersonContext(viewer, viewer.profile.id)])
  return json({ org: { id: org.id, name: org.name, description: org.description }, profile: viewer.profile, access: viewer.access, context })
})
