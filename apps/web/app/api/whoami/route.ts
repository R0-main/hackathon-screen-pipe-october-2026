import { getPersonContext } from "@/lib/brain"
import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The workstation's context: who I am, my zones, what my workstation uses the most (useful for handover). */
export const GET = withViewer(async (_req, viewer) => {
  const [org, context] = await Promise.all([getStore().getOrg(), getPersonContext(viewer, viewer.profile.id)])
  return json({ org: { name: org.name, description: org.description }, profile: viewer.profile, access: viewer.access, context })
})
