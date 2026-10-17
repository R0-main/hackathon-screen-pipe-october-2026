"use client"

import Link from "next/link"
import { useState } from "react"
import { useBrainLive } from "./BrainLive"
import { Brain3D } from "./Brain3D"
import { AskBrain } from "./AskBrain"
import { ZoneDrawer } from "./ZoneDrawer"
import { WelcomeBanner } from "./WelcomeBanner"

/** Page d'accueil : le cerveau occupe tout l'espace à droite de la barre latérale. Rien ne défile, on zoome. */
export function BrainView({ welcome }: { welcome?: boolean }) {
  const { state, activity, ripples, now } = useBrainLive()
  const [selected, setSelected] = useState<string | null>(null)
  const selectedZone = state.zones.find((z) => z.id === selected) ?? null
  const isAdmin = state.real.role === "admin"

  return (
    <div className="relative h-full w-full overflow-hidden bg-surface">
      {state.zones.length === 0 ? (
        <div className="grid h-full place-items-center p-6">
          <div className="inset max-w-md p-8 text-center">
            <p className="text-[13px] text-trace">Le cerveau n&apos;a pas encore de zones.</p>
            {isAdmin && (
              <Link href="/onboarding" className="btn btn-primary mt-3">
                Lancer l&apos;onboarding
              </Link>
            )}
          </div>
        </div>
      ) : (
        <Brain3D
          zones={state.zones}
          synapses={state.synapses}
          activity={activity}
          ripples={ripples}
          now={now}
          selected={selected}
          onSelect={(z) => setSelected((s) => (s === z ? null : z))}
        />
      )}

      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex flex-col gap-2 sm:right-auto sm:w-[min(560px,calc(100%-2rem))]">
        <div className="panel pointer-events-auto p-3">
          <AskBrain me={state.me} zones={state.zones} />
        </div>
        {welcome && (
          <div className="pointer-events-auto">
            <WelcomeBanner name={state.me.name} meId={state.me.id} />
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute right-4 top-4 z-10 hidden gap-1.5 text-[12px] lg:flex">
        <span className="chip tabular-nums">{state.totals.items} connaissances</span>
        <span className="chip tabular-nums">{state.zones.length} zones</span>
        <span className="chip tabular-nums">{state.people.length} personnes</span>
      </div>

      {selectedZone && <ZoneDrawer zone={selectedZone} onClose={() => setSelected(null)} />}
    </div>
  )
}
