import type { ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { BrainLiveProvider } from "@/components/BrainLive"
import { signupOpen } from "@/lib/auth"
import { getState } from "@/lib/brain"
import { getRememberedAccounts, requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** All signed-in pages: sidebar on the left, page on the right, and the live state of the shared brain. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requirePageViewer()
  const [state, accounts] = await Promise.all([runInOrg(viewer.real.org_id, () => getState(viewer)), getRememberedAccounts()])
  // Same clock for the server render and hydration (identical relative dates).
  return (
    <BrainLiveProvider initial={state} now={Date.now()}>
      <AppShell accounts={accounts} signup={signupOpen()}>
        {children}
      </AppShell>
    </BrainLiveProvider>
  )
}
