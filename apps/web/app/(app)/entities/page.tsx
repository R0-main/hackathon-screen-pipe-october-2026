import Link from "next/link"
import { listEntitiesFor } from "@/lib/brain"
import { getT } from "@/lib/i18n/server"
import { fmt } from "@/lib/i18n"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"
import { PageScroll } from "@/components/AppShell"
import { entityHref } from "@/components/KnowledgeList"

export const dynamic = "force-dynamic"

/** Entities: the clients, projects, tools, people and documents most cited in the readable zones. */
export default async function EntitiesPage() {
  const viewer = await requirePageViewer()
  const [{ t }, entities] = await Promise.all([getT(), runInOrg(viewer.real.org_id, () => listEntitiesFor(viewer, 300))])
  const groups = new Map<string, typeof entities>()
  for (const e of entities) groups.set(e.type, [...(groups.get(e.type) ?? []), e])
  const order = ["client", "project", "tool", "person", "doc"] as const
  return (
    <PageScroll>
      <div className="space-y-4">
        <div>
          <h1 className="text-[22px] font-medium leading-tight">{t.entities.title}</h1>
          <p className="mt-1 max-w-3xl text-[13px] text-trace">{t.entities.lead}</p>
        </div>
        {entities.length === 0 && <p className="text-[13px] text-trace">{t.entities.empty}</p>}
        <div className="grid gap-4 md:grid-cols-2">
          {order
            .filter((type) => groups.has(type))
            .map((type) => (
              <section key={type} className="panel p-4 sm:p-5">
                <h2 className="panel-title">{t.entities.types[type]}</h2>
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {groups.get(type)!.map((e) => (
                    <li key={e.name}>
                      <Link href={entityHref(e.type, e.name)} className="chip hover:border-line-strong" title={fmt(t.entities.about, { name: e.name })}>
                        {e.name} <span className="tabular-nums text-trace">{e.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </div>
    </PageScroll>
  )
}
