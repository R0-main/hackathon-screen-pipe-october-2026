"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import type { DashboardState } from "@/lib/brain"
import { api, initials } from "./format"

export function TopBar({ state, live, activeAgents }: { state: DashboardState; live: boolean; activeAgents: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const isAdmin = state.real.role === "admin"

  async function viewAs(userId: string) {
    setBusy(true)
    try {
      await api("/api/session/view-as", { method: "POST", json: { userId: userId || null } })
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    await api("/api/session", { method: "DELETE" })
    router.push("/login")
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[rgba(4,6,12,0.75)] backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <BrainIcon />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">Cerveau · {state.org.name}</div>
            <div className="text-[11px] text-[var(--muted)]">Le contexte de toute l&apos;entreprise, au même endroit</div>
          </div>
        </Link>

        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className={`inline-block h-2 w-2 rounded-full ${live ? "pulse-dot bg-emerald-400" : "bg-slate-600"}`} />
          {live ? "En direct" : "Connexion…"}
          <span className="mx-1 text-[var(--faint)]">·</span>
          <span className="mono">{activeAgents}</span> agent{activeAgents > 1 ? "s" : ""} actif{activeAgents > 1 ? "s" : ""}
          {!state.claude && (
            <span className="chip ml-1" title="Sans ANTHROPIC_API_KEY, le résumé d'état et l'onboarding utilisent des heuristiques locales.">
              mode sans Claude
            </span>
          )}
        </div>

        <nav className="ml-auto flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <select
                aria-label="Voir en tant que"
                className="input !w-auto !py-1.5 !text-xs"
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
                Équipe &amp; accès
              </Link>
            </>
          )}
          <Link href={`/people/${state.me.id}`} className="btn" title="Mon contexte et mes connaissances">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-[rgba(34,211,238,0.18)] text-[10px] font-bold text-cyan-200">
              {initials(state.me.name)}
            </span>
            {state.me.name.split(" ")[0]}
          </Link>
          <button className="btn" onClick={logout}>
            Déconnexion
          </button>
        </nav>
      </div>
      {state.impersonating && (
        <div className="border-t border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-center text-xs text-amber-200">
          Vous voyez le cerveau avec les droits de <b>{state.me.name}</b> : zones visibles {state.me.access.readable.join(", ") || "aucune"}.
        </div>
      )}
    </header>
  )
}

export function BrainIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="bi" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <path
        d="M15 5c-2.2-1.6-5.6-.8-6.4 1.9C6 7.3 4.6 9.7 5.4 12c-2 1.4-2 4.5 0 6-.8 2.4.7 4.8 3.2 5.1.9 2.7 4.2 3.5 6.4 1.9V5zM17 5c2.2-1.6 5.6-.8 6.4 1.9 2.6.4 4 2.8 3.2 5.1 2 1.4 2 4.5 0 6 .8 2.4-.7 4.8-3.2 5.1-.9 2.7-4.2 3.5-6.4 1.9V5z"
        fill="none"
        stroke="url(#bi)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="12" r="1.4" fill="#22d3ee" />
      <circle cx="21.5" cy="18" r="1.4" fill="#a78bfa" />
      <circle cx="11.5" cy="19.5" r="1.1" fill="#f472b6" />
    </svg>
  )
}
