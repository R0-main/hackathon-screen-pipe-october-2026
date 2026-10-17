import type { ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { BrainLiveProvider } from "@/components/BrainLive"
import { getState } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** All signed-in pages: sidebar on the left, page on the right, and the live state of the shared brain. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requirePageViewer()
  const state = await runInOrg(viewer.real.org_id, () => getState(viewer))
  // Same clock for the server render and hydration (identical relative dates).
  return (
    <BrainLiveProvider initial={state} now={Date.now()}>
      <AppShell>{children}</AppShell>
    </BrainLiveProvider>
  )
}
