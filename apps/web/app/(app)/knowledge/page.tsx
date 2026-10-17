import { KnowledgeView } from "@/components/Pages"
import { KNOWLEDGE_PAGE_LIMIT, listKnowledgeFor } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

type Search = Record<string, string | string[] | undefined>

/** Knowledge of the readable zones; `?zone=`, `?type=` and `?q=` prefill the filters (links from the status page). */
export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = await requirePageViewer()
  const [items, sp] = await Promise.all([runInOrg(viewer.real.org_id, () => listKnowledgeFor(viewer)), searchParams])
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined)
  const initial = { zone: one(sp.zone), kind: one(sp.type), q: one(sp.q) }
  // A new address (link to another zone, sidebar) starts from its own filters.
  return <KnowledgeView key={JSON.stringify(initial)} items={items} limit={KNOWLEDGE_PAGE_LIMIT} initial={initial} />
}
