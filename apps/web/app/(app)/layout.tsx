import type { ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { BrainLiveProvider } from "@/components/BrainLive"
import { getState } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** Toutes les pages connectées : barre latérale à gauche, page à droite, et l'état vivant du cerveau partagé. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requirePageViewer()
  const state = await runInOrg(viewer.real.org_id, () => getState(viewer))
  // Même horloge pour le rendu serveur et l'hydratation (dates relatives identiques).
  return (
    <BrainLiveProvider initial={state} now={Date.now()}>
      <AppShell>{children}</AppShell>
    </BrainLiveProvider>
  )
}
