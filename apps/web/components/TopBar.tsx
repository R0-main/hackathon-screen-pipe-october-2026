"use client"

import Link from "next/link"
import { useState } from "react"
import type { DashboardState } from "@/lib/brain"
import { api, errorMessage, initials } from "./format"

export function TopBar({ state, live, activeAgents }: { state: DashboardState; live: boolean; activeAgents: number }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isAdmin = state.real.role === "admin"

  async function viewAs(userId: string) {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session/view-as", { method: "POST", json: { userId: userId || null } })
      window.location.reload()
    } catch (e) {
      setErr(`Changement de vue impossible : ${errorMessage(e)}`)
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session", { method: "DELETE" })
    } catch (e) {
      setErr(`Déconnexion impossible : ${errorMessage(e)}`)
      setBusy(false)
      return
    }
    // Navigation complète (pas router.push) : le cache du routeur client, qui contient encore le cerveau de la
    // personne connectée, est jeté, et l'entrée « / » est remplacée dans l'historique.
    window.location.replace("/login")
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bone">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-[6px]">
          <BrainIcon />
          <span className="text-[15px] font-medium">Le cerveau de {state.org.name}</span>
        </Link>

        <div className="flex items-center gap-2 text-[13px] text-trace">
          <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden />
          <span>{live ? "En direct" : "Connexion en cours"}</span>
          <span className="tabular-nums">
            {activeAgents} agent{activeAgents > 1 ? "s" : ""} actif{activeAgents > 1 ? "s" : ""}
          </span>
          {!state.claude && (
            <span className="chip" title="Sans ANTHROPIC_API_KEY, le résumé d'état et l'onboarding utilisent des heuristiques locales.">
              Sans Claude
            </span>
          )}
        </div>

        <nav className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2" aria-label="Navigation">
          {isAdmin && (
            <>
              <select
                aria-label="Voir en tant que"
                className="input input-sm max-w-full"
                value={state.impersonating ? state.me.id : ""}
                disabled={busy}
                onChange={(e) => viewAs(e.target.value)}
              >
                <option value="">Voir en tant que : moi (admin)</option>
                {state.people
                  .filter((p) => p.id !== state.real.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      Voir en tant que : {p.name}
                      {p.title ? ` (${p.title})` : ""}
                    </option>
                  ))}
              </select>
              <Link href="/onboarding" className="btn">
                Onboarding
              </Link>
              <Link href="/admin" className="btn">
                Équipe et accès
              </Link>
            </>
          )}
          <Link href={`/people/${state.me.id}`} className="btn" title="Mon contexte et mes connaissances">
            <span className="grid size-5 place-items-center rounded-full border border-line-strong text-[10px] font-medium">{initials(state.me.name)}</span>
            {state.me.name.split(" ")[0]}
          </Link>
          <button type="button" className="btn" onClick={logout} disabled={busy}>
            Déconnexion
          </button>
        </nav>
      </div>
      {err && (
        <div role="alert" className="border-t border-line bg-surface px-4 py-1.5 text-center text-[13px] text-danger">
          {err}
        </div>
      )}
      {state.impersonating && (
        <div className="border-t border-line bg-surface px-4 py-1.5 text-center text-[13px]">
          Vous voyez le cerveau avec les droits de <b className="font-medium">{state.me.name}</b>. Zones visibles : {state.me.access.readable.join(", ") || "aucune"}.
        </div>
      )}
    </header>
  )
}

/** Pictogramme du cerveau : un trait d'encre, deux points. Jamais de couleur. */
export function BrainIcon({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <path
        d="M15 5c-2.2-1.6-5.6-.8-6.4 1.9C6 7.3 4.6 9.7 5.4 12c-2 1.4-2 4.5 0 6-.8 2.4.7 4.8 3.2 5.1.9 2.7 4.2 3.5 6.4 1.9V5zM17 5c2.2-1.6 5.6-.8 6.4 1.9 2.6.4 4 2.8 3.2 5.1 2 1.4 2 4.5 0 6 .8 2.4-.7 4.8-3.2 5.1-.9 2.7-4.2 3.5-6.4 1.9V5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="21.5" cy="18" r="1.5" fill="currentColor" />
    </svg>
  )
}
