import type { Metadata } from "next"
import { Landing } from "@/components/landing/Landing"
import { parseVariant } from "@/components/landing/motion/variants"
import { isDemoMode } from "@/lib/auth"
import { getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau. Screenpipe capte les sessions de chaque poste, le cerveau en garde l'essentiel.",
}

/**
 * Page d'accueil publique, pour tout le monde. Le dashboard est sur /dashboard, la démo sur /demo.
 * `?v=epure|recit|cinetique` choisit une version du motion design à comparer.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ v?: string | string[] }> }) {
  const [viewer, params] = await Promise.all([getPageViewer(), searchParams])
  return <Landing demo={isDemoMode()} signedIn={Boolean(viewer)} variant={parseVariant(params.v)} />
}
