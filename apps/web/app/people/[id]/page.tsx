import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { getPersonContext } from "@/lib/brain"
import { getStore } from "@/lib/store"
import { requirePageViewer } from "@/lib/session"
import { BrainIcon } from "@/components/TopBar"
import { PersonItems } from "@/components/PersonItems"

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

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-[rgba(4,6,12,0.75)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 sm:px-6">
          <BrainIcon />
          <div className="font-semibold">{isSelf ? "Mon contexte" : `Passation · ${ctx.person.name}`}</div>
          <Link href="/" className="btn ml-auto">
            ← Cerveau
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] space-y-4 px-4 py-6 sm:px-6">
        <section className="panel p-5">
          <h1 className="text-2xl font-semibold">{ctx.person.name}</h1>
          <p className="text-sm text-[var(--muted)]">
            {ctx.person.title ?? ""} {ctx.person.role === "admin" ? "· admin" : ""}
          </p>
          <p className="mt-3 max-w-3xl text-sm text-[var(--muted)]">
            {isSelf
              ? "Ce que le cerveau a retenu de vos sessions. Vous pouvez supprimer toute connaissance issue de votre poste."
              : `Le contexte que ce poste utilise le plus : à transmettre à la personne qui remplace ${ctx.person.name.split(" ")[0]}. Seules les connaissances distillées sont visibles, jamais les conversations brutes.`}
          </p>
        </section>

        <div className="grid gap-4 lg:grid-cols-3">
          <section className="panel p-5">
            <div className="panel-title">Zones du poste</div>
            <ul className="mt-3 space-y-2">
              {ctx.zones.map((z) => (
                <li key={z.zone}>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: zone(z.zone)?.color }}>{zone(z.zone)?.name ?? z.zone}</span>
                    <span className="mono text-[var(--faint)]">{z.weight}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-white/5">
                    <div className="h-full rounded-full" style={{ width: `${(z.weight / maxWeight) * 100}%`, background: zone(z.zone)?.color }} />
                  </div>
                </li>
              ))}
              {ctx.zones.length === 0 && <li className="text-sm text-[var(--muted)]">Pas encore d&apos;activité.</li>}
            </ul>
          </section>
          <section className="panel p-5">
            <div className="panel-title">Sujets et outils récurrents</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {ctx.entities.map((e) => (
                <span key={`${e.type}:${e.name}`} className="chip">
                  {e.name} <span className="mono text-[var(--faint)]">{e.count}</span>
                </span>
              ))}
              {ctx.entities.length === 0 && <span className="text-sm text-[var(--muted)]">—</span>}
            </div>
          </section>
          <section className="panel p-5">
            <div className="panel-title">Prompts les plus fréquents</div>
            <ul className="mt-3 space-y-2 text-sm">
              {ctx.frequent_prompts.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mono shrink-0 text-[var(--faint)]">×{p.count}</span>
                  <span>« {p.summary} »</span>
                </li>
              ))}
              {ctx.frequent_prompts.length === 0 && <li className="text-[var(--muted)]">—</li>}
            </ul>
          </section>
        </div>

        <PersonItems
          items={ctx.items}
          zones={zones.map((z) => ({ id: z.id, name: z.name, color: z.color }))}
          canDelete={isSelf || viewer.real.role === "admin"}
        />
      </main>
    </div>
  )
}
