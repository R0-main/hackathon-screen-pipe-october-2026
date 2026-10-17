import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { getPersonContext } from "@/lib/brain"
import { canRead } from "@/lib/access"
import { runInOrg, storeForOrg } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"
import { PageScroll } from "@/components/AppShell"
import { entityHref } from "@/components/format"
import { PersonAvatar } from "@/components/PersonDot"
import { PersonItems } from "@/components/PersonItems"
import { ZoneTag, zoneColor } from "@/components/ui"

export const dynamic = "force-dynamic"

/** Handover: what this person's workstation uses the most. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const viewer = await requirePageViewer()
  if (viewer.real.role !== "admin" && viewer.real.id !== id) redirect("/dashboard")
  const ctx = await runInOrg(viewer.real.org_id, () => getPersonContext(viewer, id))
  if (!ctx) notFound()
  const zones = await storeForOrg(viewer.real.org_id).listZones()
  const zone = (zid: string) => zones.find((z) => z.id === zid)
  const isSelf = viewer.real.id === id
  const totalWeight = ctx.zones.reduce((n, z) => n + z.weight, 0) || 1
  const colorOf = (zid: string) => {
    const zv = zone(zid)
    return zoneColor(zv?.color, zv?.position ?? 0)
  }
  const main = ctx.zones[0]
  const first = ctx.person.name.split(" ")[0]
  const count = (k: string) => ctx.items.filter((i) => i.kind === k).length
  const stats = [
    { label: "Knowledge", value: ctx.items.length },
    { label: "Decisions", value: count("decision") },
    { label: "Procedures", value: count("procedure") },
    { label: ctx.zones.length === 1 ? "Zone" : "Zones", value: ctx.zones.length },
  ]
  // Zones the person does not read but that hold their own knowledge (unreadable_zones) or their activity
  // (on their own context): flagged, never hidden (right of review).
  const own = viewer.profile.id === id
  const unreadable = new Set([...(ctx.unreadable_zones ?? []), ...(own ? ctx.zones.map((z) => z.zone).filter((z) => !canRead(viewer.access, z)) : [])])

  return (
    <PageScroll width="max-w-[1200px]">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
        <PersonAvatar id={ctx.person.id} size={112} bg="surface" color={main ? colorOf(main.zone) : undefined} className="size-20 sm:size-28" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[28px] font-medium leading-tight sm:text-[32px]">{ctx.person.name}</h1>
            {ctx.person.role === "admin" && <span className="chip">Admin</span>}
            {isSelf && <span className="chip chip-on">You</span>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-trace">
            {ctx.person.title && <span className="text-ink">{ctx.person.title}</span>}
            {main && (
              <span className="inline-flex items-center gap-1.5">
                Mostly in <ZoneTag name={zone(main.zone)?.name ?? main.zone} color={colorOf(main.zone)} className="text-ink" />
              </span>
            )}
          </p>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-trace">
            {isSelf
              ? "What the brain kept from your sessions. Open any item that comes from your workstation to delete it."
              : `The context ${first}'s workstation uses the most, ready to hand over to whoever takes over. Only distilled knowledge is shown, never the raw conversations.`}
          </p>
        </div>
        {/* The employee sheet: who did what, to read or hand over (Markdown), or to import into another brain (JSON). */}
        <div className="flex shrink-0 flex-wrap gap-2 sm:self-start">
          <a href={`/api/export?what=person&id=${encodeURIComponent(id)}&format=md`} download className="btn btn-sm">
            Export sheet
          </a>
          <a href={`/api/export?what=person&id=${encodeURIComponent(id)}`} download className="btn btn-sm" title="To import into another brain">
            JSON
          </a>
        </div>
      </header>

      <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-line bg-line sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface px-5 py-4">
            <dt className="text-[12px] text-trace">{s.label}</dt>
            <dd className="mt-1 text-[26px] font-medium leading-none tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <PersonItems
          items={ctx.items}
          zones={zones.map((z) => ({ id: z.id, name: z.name, color: z.color, position: z.position }))}
          canDelete={isSelf || viewer.real.role === "admin"}
          now={Date.now()}
          unreadableZones={[...unreadable]}
          personName={isSelf ? undefined : ctx.person.name}
        />

        <aside className="order-first grid min-w-0 gap-4 sm:grid-cols-2 lg:order-none lg:grid-cols-1">
          <section className="panel min-w-0 p-5">
            <h2 className="panel-title">Where the work happens</h2>
            {ctx.zones.length > 0 ? (
              <>
                {/* Share of each zone, in its color: the same split as the list below. */}
                <div className="mt-4 flex h-2 gap-0.5" aria-hidden>
                  {ctx.zones.map((z) => (
                    <span key={z.zone} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flex: z.weight, background: colorOf(z.zone) }} />
                  ))}
                </div>
                <ul className="mt-4 space-y-2.5 text-[13px]">
                  {ctx.zones.map((z) => (
                    <li key={z.zone} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ZoneTag name={zone(z.zone)?.name ?? z.zone} color={colorOf(z.zone)} />
                        {unreadable.has(z.zone) && (
                          <span className="chip text-[11px] text-trace" title="Zone not readable: only the knowledge coming from this workstation is visible here">
                            zone not readable
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-trace">{Math.round((z.weight / totalWeight) * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-3 text-[13px] text-trace">No activity yet.</p>
            )}
          </section>

          <section className="panel min-w-0 p-5">
            <h2 className="panel-title">Recurring topics and tools</h2>
            {ctx.entities.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {ctx.entities.map((e) => (
                  <li key={`${e.type}:${e.name}`}>
                    <Link href={entityHref(e.type, e.name)} className="chip transition-colors hover:border-ink">
                      {e.name} <span className="tabular-nums text-trace">{e.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-trace">Nothing yet.</p>
            )}
          </section>

          <section className="panel min-w-0 p-5 sm:col-span-2 lg:col-span-1">
            <h2 className="panel-title">Most frequent prompts</h2>
            {ctx.frequent_prompts.length > 0 ? (
              <ol className="mt-2 divide-y divide-line text-[13px]">
                {ctx.frequent_prompts.map((p, i) => (
                  <li key={i} className="flex gap-3 py-2.5 last:pb-0">
                    <span className="inset h-fit shrink-0 px-1.5 py-0.5 text-[12px] tabular-nums text-trace">{p.count}×</span>
                    <span className="min-w-0 break-words leading-relaxed">{p.summary}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-[13px] text-trace">Nothing yet.</p>
            )}
          </section>
        </aside>
      </div>
    </PageScroll>
  )
}
