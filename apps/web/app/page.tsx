import type { Metadata } from "next"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode, signupOpen } from "@/lib/auth"
import { getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Everything your team learns with AI, in a single brain. Screenpipe captures each workstation's sessions, the brain keeps what matters.",
}

/** Public home page, for everyone. The dashboard is on /dashboard, the demo on /demo. */
export default async function HomePage() {
  const signedIn = Boolean(await getPageViewer())
  return <Landing demo={isDemoMode()} signup={signupOpen()} signedIn={signedIn} />
}
