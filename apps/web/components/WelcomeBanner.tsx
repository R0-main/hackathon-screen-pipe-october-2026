"use client"

import Link from "next/link"
import { useState } from "react"

/** Après `brain.mjs setup` : le poste vient d'être branché, on dit quoi regarder. Fermé, il ne revient pas au rechargement. */
export function WelcomeBanner({ name, meId }: { name: string; meId: string }) {
  const [open, setOpen] = useState(true)
  if (!open) return null

  function close() {
    setOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete("bienvenue")
    window.history.replaceState(null, "", url.pathname + url.search + url.hash)
  }

  return (
    <section role="status" className="panel mb-4 flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
      <div className="min-w-0 max-w-3xl">
        <h2 className="panel-title">Ton poste est branché, {name.split(" ")[0]}</h2>
        <p className="mt-1 text-[13px] text-trace">
          Continue à travailler avec Claude Code : à chaque session, ta zone s&apos;allume ici et apparaît dans le fil en direct. Toutes les 15 minutes, ce
          que tu as appris est distillé et rejoint le cerveau. Rien de brut ne quitte ton poste ; tes connaissances sont dans{" "}
          <Link href={`/people/${meId}`} className="underline underline-offset-2">
            ton contexte
          </Link>
          , où tu peux en supprimer.
        </p>
      </div>
      <button type="button" className="btn" onClick={close}>
        Fermer
      </button>
    </section>
  )
}
