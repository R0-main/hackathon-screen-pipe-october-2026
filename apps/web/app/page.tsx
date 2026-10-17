import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode, landingEnabled, signupOpen } from "@/lib/auth"
import { canResume, getPageViewer } from "@/lib/session"
import { getRootStore } from "@/lib/store"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau. Screenpipe capte les sessions de chaque poste, le cerveau en garde l'essentiel.",
}

/**
 * Page d'accueil publique, pour tout le monde. Le dashboard est sur /dashboard, la démo sur /demo.
 * Cerveau lancé en local (`make dev`, BRAIN_LANDING=0) : pas de page publique, on va droit au but.
 */
export default async function HomePage() {
  // Session ouverte, ou entreprise retenue qui se rouvrira toute seule : le bouton mène droit au dashboard.
  const signedIn = Boolean(await getPageViewer()) || (await canResume())
  if (!landingEnabled()) redirect(await localStart(signedIn))
  return <Landing demo={isDemoMode()} signup={signupOpen()} signedIn={signedIn} />
}

/** En local : le dashboard si on est connecté, la démo en mode démo, /creer tant qu'aucune entreprise n'existe. */
async function localStart(signedIn: boolean): Promise<string> {
  if (signedIn) return "/dashboard"
  if (isDemoMode()) return "/demo"
  const root = getRootStore()
  const empty = (await root.isEmpty()) && (await root.countTenantOrgs()) === 0
  return empty && signupOpen() ? "/creer" : "/login"
}
