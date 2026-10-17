import type { Metadata } from "next"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode } from "@/lib/auth"
import { getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Cerveau d'entreprise",
  description: "Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau. Screenpipe capte les sessions de chaque poste, le cerveau en garde l'essentiel.",
}

/** Page d'accueil publique, pour tout le monde. Le dashboard est sur /dashboard, la démo sur /demo. */
export default async function HomePage() {
  const signedIn = Boolean(await getPageViewer())
  return <Landing demo={isDemoMode()} signedIn={signedIn} />
}
