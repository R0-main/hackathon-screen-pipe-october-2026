import { notFound, redirect } from "next/navigation"
import { getPersonContext } from "@/lib/brain"
import { canRead } from "@/lib/access"
import { getStore } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"
import { PageScroll } from "@/components/AppShell"
import { PersonItems } from "@/components/PersonItems"
import { ZoneTag, zoneColor } from "@/components/ui"

export const dynamic = "force-dynamic"

/** Passation de poste : ce que le poste de cette personne utilise le plus. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const viewer = await requirePageViewer()
  if (viewer.real.role !== "admin" && viewer.real.id !== id) redirect("/")
  const ctx = await getPersonContext(viewer, id)
  if (!ctx) notFound()
  const zones = await getStore().listZones()
  const zone = (zid: string) => zones.find((z) => z.id === zid)
  const isSelf = viewer.real.id === id
  const maxWeight = Math.max(1, ...ctx.zones.map((z) => z.weight))
  // Zones que la personne ne lit pas mais où se trouvent ses propres connaissances (unreadable_zones) ou son activité
  // (sur son propre contexte) : signalées, jamais masquées (droit de regard).
  const own = viewer.profile.id === id
  const unreadable = new Set([...(ctx.unreadable_zones ?? []), ...(own ? ctx.zones.map((z) => z.zone).filter((z) => !canRead(viewer.access, z)) : [])])

  return (
    <PageScroll width="max-w-[1200px]">
      <div className="space-y-4">
        <p className="text-[13px] text-trace">{isSelf ? "Mon contexte" : `Passation de ${ctx.person.name}`}</p>
        <section className="panel p-5">
          <h1 className="text-[22px] font-medium leading-tight">{ctx.person.name}</h1>
          <p className="text-[13px] text-trace">
            {ctx.person.title ?? ""}
            {ctx.person.role === "admin" ? (ctx.person.title ? ", admin" : "admin") : ""}
          </p>
          <p className="mt-3 max-w-3xl text-[13px] text-trace">
            {isSelf
              ? "Ce que le cerveau a retenu de vos sessions. Vous pouvez supprimer toute connaissance issue de votre poste."
              : `Le contexte que ce poste utilise le plus, à transmettre à la personne qui remplace ${ctx.person.name.split(" ")[0]}. Seules les connaissances distillées sont visibles, jamais les conversations brutes.`}
          </p>
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <section className="panel min-w-0 p-5">
            <h2 className="panel-title">Zones du poste</h2>
            <ul className="mt-3 space-y-2.5">
              {ctx.zones.map((z) => {
                const zv = zone(z.zone)
                return (
                  <li key={z.zone}>
                    <div className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ZoneTag name={zv?.name ?? z.zone} color={zoneColor(zv?.color, zv?.position ?? 0)} />
                        {unreadable.has(z.zone) && (
                          <span className="chip !py-0 text-[11px] text-trace" title="Zone non lisible : seules les connaissances issues de ce poste y sont visibles ici">
                            zone non lisible
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-trace">{z.weight}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-line" aria-hidden>
                      <div className="h-full rounded-full bg-ink" style={{ width: `${(z.weight / maxWeight) * 100}%` }} />
                    </div>
                  </li>
                )
              })}
              {ctx.zones.length === 0 && <li className="text-[13px] text-trace">Pas encore d&apos;activité.</li>}
            </ul>
          </section>
          <section className="panel min-w-0 p-5">
            <h2 className="panel-title">Sujets et outils récurrents</h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {ctx.entities.map((e) => (
                <span key={`${e.type}:${e.name}`} className="chip">
                  {e.name} <span className="tabular-nums text-trace">{e.count}</span>
                </span>
              ))}
              {ctx.entities.length === 0 && <span className="text-[13px] text-trace">Rien pour l&apos;instant.</span>}
            </div>
          </section>
          <section className="panel min-w-0 p-5">
            <h2 className="panel-title">Prompts les plus fréquents</h2>
            <ul className="mt-3 space-y-2 text-[13px]">
              {ctx.frequent_prompts.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-trace">{p.count} fois</span>
                  <span className="min-w-0 break-words">« {p.summary} »</span>
                </li>
              ))}
              {ctx.frequent_prompts.length === 0 && <li className="text-trace">Rien pour l&apos;instant.</li>}
            </ul>
          </section>
        </div>

        <PersonItems
          items={ctx.items}
          zones={zones.map((z) => ({ id: z.id, name: z.name, color: z.color, position: z.position }))}
          canDelete={isSelf || viewer.real.role === "admin"}
          now={Date.now()}
          unreadableZones={[...unreadable]}
          personName={isSelf ? undefined : ctx.person.name}
        />
      </div>
    </PageScroll>
  )
}
