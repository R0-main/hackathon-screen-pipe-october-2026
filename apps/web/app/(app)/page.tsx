import { BrainView } from "@/components/BrainView"

export const dynamic = "force-dynamic"

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // ?bienvenue=1 : on arrive du lien ouvert par `brain.mjs setup`, juste après l'installation du poste.
  const welcome = (await searchParams).bienvenue === "1"
  return <BrainView welcome={welcome} />
}
