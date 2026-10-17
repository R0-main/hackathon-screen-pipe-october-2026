"use client"

import Link from "next/link"
import { useState } from "react"

/** After `brain.mjs setup`: the workstation was just connected, we say what to look at. Once closed, it does not come back on reload. */
export function WelcomeBanner({ name, meId }: { name: string; meId: string }) {
  const [open, setOpen] = useState(true)
  if (!open) return null

  function close() {
    setOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete("welcome")
    window.history.replaceState(null, "", url.pathname + url.search + url.hash)
  }

  return (
    <section role="status" className="panel flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 max-w-3xl">
        <h2 className="panel-title">Your computer is connected, {name.split(" ")[0]}</h2>
        <p className="mt-1 text-[13px] text-trace">
          Keep working with Claude Code: at every session, your zone lights up here and shows in the live feed. Every 15 minutes, what
          you learned is distilled and joins the brain. Nothing raw leaves your computer; your knowledge is in{" "}
          <Link href={`/people/${meId}`} className="underline underline-offset-2">
            your context
          </Link>
          , where you can delete some.
        </p>
      </div>
      <button type="button" className="btn" onClick={close}>
        Close
      </button>
    </section>
  )
}
