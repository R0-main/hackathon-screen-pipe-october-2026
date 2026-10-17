import { KnowledgeView } from "@/components/Pages"
import { KNOWLEDGE_PAGE_LIMIT, listKnowledgeFor } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

type Search = Record<string, string | string[] | undefined>

/** Connaissances des zones lisibles ; `?zone=`, `?type=` et `?q=` préremplissent les filtres (liens depuis l'état). */
export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = await requirePageViewer()
  const [items, sp] = await Promise.all([runInOrg(viewer.real.org_id, () => listKnowledgeFor(viewer)), searchParams])
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined)
  const initial = { zone: one(sp.zone), kind: one(sp.type), q: one(sp.q) }
  // Une nouvelle adresse (lien vers une autre zone, barre latérale) repart de ses propres filtres.
  return <KnowledgeView key={JSON.stringify(initial)} items={items} limit={KNOWLEDGE_PAGE_LIMIT} initial={initial} />
}
