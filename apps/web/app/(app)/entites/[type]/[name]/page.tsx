import Link from "next/link"
import { notFound } from "next/navigation"
import { ENTITY_TYPES } from "@brain/core"
import { getEntityContext } from "@/lib/brain"
import { getT } from "@/lib/i18n/server"
import { fmt } from "@/lib/i18n"
import { requirePageViewer } from "@/lib/session"
import { runInOrg, storeForOrg } from "@/lib/store"
import { PageScroll } from "@/components/AppShell"
import { KnowledgeCard } from "@/components/KnowledgeList"
import { entityHref } from "@/components/format"
import { ZoneTag, zoneColor } from "@/components/ui"

export const dynamic = "force-dynamic"

/** Tout ce qui concerne une entité (client, projet, outil…) : connaissances lisibles qui la citent, entités liées. */
export default async function EntityPage({ params }: { params: Promise<{ type: string; name: string }> }) {
  const { type, name: rawName } = await params
  if (!(ENTITY_TYPES as readonly string[]).includes(type)) notFound()
  const name = decodeURIComponent(rawName)
  const viewer = await requirePageViewer()
  const [{ t }, ctx, zones] = await Promise.all([getT(), runInOrg(viewer.real.org_id, () => getEntityContext(viewer, type, name)), storeForOrg(viewer.real.org_id).listZones()])
  if (!ctx) notFound()
  const zone = (id: string) => zones.find((z) => z.id === id)
  return (
    <PageScroll>
      <div className="space-y-4">
        <p className="text-[13px] text-trace">
          <Link href="/entites" className="underline underline-offset-2 hover:text-ink">
            {t.entities.backToList}
          </Link>
        </p>
        <section className="panel p-5">
          <p className="text-[12px] text-trace">{t.entities.types[type as keyof typeof t.entities.types]}</p>
          <h1 className="text-[22px] font-medium leading-tight">{ctx.name}</h1>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            <span className="text-trace">{fmt(t.entities.mentions, { n: ctx.items.length })}</span>
            {ctx.zones.map((zid) => {
              const z = zone(zid)
              return z ? <ZoneTag key={zid} name={z.name} color={zoneColor(z.color, z.position)} /> : null
            })}
          </div>
          {ctx.related.length > 0 && (
            <div className="mt-4">
              <h2 className="panel-title">{t.entities.related}</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ctx.related.map((e) => (
                  <Link key={`${e.type}:${e.name}`} href={entityHref(e.type, e.name)} className="chip hover:border-line-strong">
                    {e.name} <span className="tabular-nums text-trace">{e.count}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="panel p-4 sm:p-5">
          <h2 className="panel-title">{fmt(t.entities.about, { name: ctx.name })}</h2>
          {ctx.items.length === 0 && <p className="mt-3 text-[13px] text-trace">{t.entities.noItems}</p>}
          <div className="mt-3 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {ctx.items.map((i) => (
              <KnowledgeCard key={i.id} item={i} author={ctx.names[i.author_id]} zone={zone(i.zone)} now={Date.now()} />
            ))}
          </div>
        </section>
      </div>
    </PageScroll>
  )
}
