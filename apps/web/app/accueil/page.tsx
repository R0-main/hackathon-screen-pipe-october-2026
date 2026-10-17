import type { Metadata } from "next"
import { Landing } from "@/components/landing/Landing"
import { isDemoMode } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau. Screenpipe capte les sessions de chaque poste, le cerveau en garde l'essentiel.",
}

/** Page d'accueil publique. Le middleware y envoie `/` quand personne n'est connecté. */
export default function AccueilPage() {
  return <Landing demo={isDemoMode()} />
}
