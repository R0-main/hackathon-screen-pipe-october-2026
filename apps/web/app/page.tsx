import { Dashboard } from "@/components/Dashboard"
import { getState } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function Home() {
  const viewer = await requirePageViewer()
  const state = await getState(viewer)
  // Même horloge pour le rendu serveur et l'hydratation (dates relatives identiques).
  return <Dashboard initial={state} now={Date.now()} />
}
