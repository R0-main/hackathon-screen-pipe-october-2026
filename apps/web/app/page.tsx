import { Dashboard } from "@/components/Dashboard"
import { getState } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requirePageViewer()
  const state = await getState(viewer)
  // ?bienvenue=1 : on arrive du lien ouvert par `brain.mjs setup`, juste après l'installation du poste.
  const welcome = (await searchParams).bienvenue === "1"
  // Même horloge pour le rendu serveur et l'hydratation (dates relatives identiques).
  return <Dashboard initial={state} now={Date.now()} welcome={welcome} />
}
