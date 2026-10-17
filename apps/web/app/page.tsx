import { Dashboard } from "@/components/Dashboard"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode } from "@/lib/auth"
import { getState } from "@/lib/brain"
import { getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function Home() {
  // Un visiteur non connecté voit la page d'accueil ; une fois connecté, son dashboard.
  const viewer = await getPageViewer()
  if (!viewer) return <Landing demo={isDemoMode()} />
  const state = await getState(viewer)
  // Même horloge pour le rendu serveur et l'hydratation (dates relatives identiques).
  return <Dashboard initial={state} now={Date.now()} />
}
