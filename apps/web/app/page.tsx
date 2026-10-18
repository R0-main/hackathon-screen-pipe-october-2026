import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode, landingEnabled, signupOpen } from "@/lib/auth"
import { canResume, getPageViewer } from "@/lib/session"
import { getRootStore } from "@/lib/store"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Everything your team learns with AI, in a single brain. Screenpipe captures each computer's AI chats and meetings, the brain keeps what matters.",
}

/**
 * Public home page, for everyone. The dashboard is on /dashboard, the demo on /demo.
 * Brain run locally (`make dev`, BRAIN_LANDING=0): no public page, straight to the point.
 */
export default async function HomePage() {
  // Session open, or a remembered company that will reopen on its own: the button goes straight to the dashboard.
  const signedIn = Boolean(await getPageViewer()) || (await canResume())
  if (!landingEnabled()) redirect(await localStart(signedIn))
  return <Landing demo={isDemoMode()} signup={signupOpen()} signedIn={signedIn} />
}

/** Locally: the dashboard if signed in, the demo in demo mode, /create as long as no company exists. */
async function localStart(signedIn: boolean): Promise<string> {
  if (signedIn) return "/dashboard"
  if (isDemoMode()) return "/demo"
  const root = getRootStore()
  const empty = (await root.isEmpty()) && (await root.countTenantOrgs()) === 0
  return empty && signupOpen() ? "/create" : "/login"
}
