import type { Metadata } from "next"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode, signupOpen } from "@/lib/auth"
import { canResume, getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau. Screenpipe capte les sessions de chaque poste, le cerveau en garde l'essentiel.",
}

/** Page d'accueil publique, pour tout le monde. Le dashboard est sur /dashboard, la démo sur /demo. */
export default async function HomePage() {
  // Session ouverte, ou entreprise retenue qui se rouvrira toute seule : le bouton mène droit au dashboard.
  const signedIn = Boolean(await getPageViewer()) || (await canResume())
  return <Landing demo={isDemoMode()} signup={signupOpen()} signedIn={signedIn} />
}
