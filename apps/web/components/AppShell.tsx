"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { useBrainLive } from "./BrainLive"
import { api, errorMessage, initials } from "./format"
import { usePendingJoins } from "./TeamJoin"
import { BoltIcon, BrainIcon, ChatIcon, CloseIcon, DocIcon, LogoutIcon, MenuIcon, NavBrainIcon, PulseIcon, StackIcon, TaskIcon, UsersIcon } from "./ui"

type NavItem = { href: string; label: string; icon: ComponentType<{ size?: number }>; count?: number }

/**
 * Gabarit de l'application : la barre latérale à gauche, la page à droite. La fenêtre ne défile jamais :
 * le cerveau occupe toute la hauteur, les autres pages défilent dans leur propre colonne.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  useEffect(() => setOpen(false), [pathname])

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className={`fixed inset-0 z-40 bg-ink/20 md:hidden ${open ? "" : "hidden"}`} onClick={() => setOpen(false)} aria-hidden />
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar onMenu={() => setOpen(true)} />
        <main className="relative min-h-0 flex-1">{children}</main>
      </div>
    </div>
  )
}

/** Colonne défilante d'une page secondaire (tout sauf le cerveau). */
export function PageScroll({ children, width = "max-w-[1100px]" }: { children: ReactNode; width?: string }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className={`mx-auto ${width} px-4 py-6 sm:px-8 sm:py-8`}>{children}</div>
    </div>
  )
}

function MobileBar({ onMenu }: { onMenu: () => void }) {
  const { state, live } = useBrainLive()
  return (
    <div className="flex items-center gap-3 border-b border-line bg-bone px-4 py-2.5 md:hidden">
      <button type="button" className="btn btn-icon" aria-label="Ouvrir le menu" onClick={onMenu}>
        <MenuIcon />
      </button>
      <span className="min-w-0 truncate text-[14px] font-medium">Le cerveau de {state.org.name}</span>
      <span className={`live-dot ml-auto ${live ? "is-live" : ""}`} aria-label={live ? "En direct" : "Connexion en cours"} />
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, live, activeAgents } = useBrainLive()
  const pathname = usePathname()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isAdmin = state.real.role === "admin"
  const pendingJoins = usePendingJoins(isAdmin)

  const openTasks = state.tasks.filter((t) => t.status === "open").length
  const proposed = state.automations.filter((a) => a.status === "proposed").length
  const main: NavItem[] = [
    { href: "/dashboard", label: "Cerveau", icon: NavBrainIcon },
    { href: "/activite", label: "Agents en direct", icon: PulseIcon },
    { href: "/etat", label: "Où en est la boîte", icon: DocIcon },
    { href: "/connaissances", label: "Connaissances", icon: StackIcon, count: state.totals.items },
    { href: "/taches", label: "Tâches", icon: TaskIcon, count: openTasks },
    { href: "/automatisations", label: "Automatisations", icon: BoltIcon, count: proposed },
  ]
  const config: NavItem[] = isAdmin
    ? [
        { href: "/admin", label: "Équipe et accès", icon: UsersIcon, count: pendingJoins },
        { href: "/onboarding", label: "Onboarding", icon: ChatIcon },
      ]
    : []

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

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)
  const meHref = `/people/${state.me.id}`

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-[264px] shrink-0 flex-col border-r border-line bg-bone transition-transform duration-200 ease-out md:static md:z-auto md:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
      aria-label="Barre latérale"
    >
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5 rounded-[6px]">
          <BrainIcon size={26} className="shrink-0" />
          <span className="min-w-0 truncate text-[14px] font-medium leading-tight">Le cerveau de {state.org.name}</span>
        </Link>
        <button type="button" className="btn btn-icon btn-sm ml-auto md:hidden" aria-label="Fermer le menu" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="mx-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line pb-3 text-[12px] text-trace">
        <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden />
        <span>{live ? "En direct" : "Connexion en cours"}</span>
        <span className="tabular-nums">
          {activeAgents} agent{activeAgents > 1 ? "s" : ""} actif{activeAgents > 1 ? "s" : ""}
        </span>
        {!state.claude && (
          <span className="chip !h-5" title="Sans ANTHROPIC_API_KEY, le résumé d'état et l'onboarding utilisent des heuristiques locales.">
            Sans Claude
          </span>
        )}
      </div>

      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Navigation">
        <NavList items={main} isActive={isActive} />
        {config.length > 0 && (
          <>
            <p className="mb-1 mt-5 px-2.5 text-[12px] text-trace">Configuration</p>
            <NavList items={config} isActive={isActive} />
          </>
        )}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        {err && <p role="alert" className="text-[12px] text-danger">{err}</p>}
        {state.impersonating && (
          <p className="inset px-2.5 py-2 text-[12px] leading-snug">
            Vous voyez le cerveau avec les droits de <b className="font-medium">{state.me.name}</b>. Zones visibles : {state.me.access.readable.join(", ") || "aucune"}.
          </p>
        )}
        {isAdmin && (
          <select
            aria-label="Voir en tant que"
            className="input input-sm !w-full"
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
        )}
        <div className="flex items-center gap-1">
          <Link
            href={meHref}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-1.5 hover:bg-surface ${isActive(meHref) ? "bg-surface" : ""}`}
            title="Mon contexte et mes connaissances"
            aria-current={isActive(meHref) ? "page" : undefined}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-[10px] font-medium">{initials(state.me.name)}</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium leading-tight">{state.me.name}</span>
              <span className="block truncate text-[12px] leading-tight text-trace">Mon contexte</span>
            </span>
          </Link>
          <button type="button" className="btn btn-icon shrink-0" onClick={logout} disabled={busy} aria-label="Déconnexion" title="Déconnexion">
            <LogoutIcon />
          </button>
        </div>
      </div>
    </aside>
  )
}

function NavList({ items, isActive }: { items: NavItem[]; isActive: (href: string) => boolean }) {
  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const active = isActive(it.href)
        const Icon = it.icon
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-[13px] transition-colors duration-150 ease-out ${
                active ? "bg-ink text-surface" : "hover:bg-surface"
              }`}
            >
              <Icon size={16} />
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.count !== undefined && it.count > 0 && <span className={`text-[12px] tabular-nums ${active ? "text-line-strong" : "text-trace"}`}>{it.count}</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
