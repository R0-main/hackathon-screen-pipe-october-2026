"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { fmt, plural } from "@/lib/i18n"
import { useBrainLive } from "./BrainLive"
import { api, errorMessage, initials } from "./format"
import { LanguageSwitch, useT } from "./I18n"
import { usePendingJoins } from "./TeamJoin"
import { ADMIN_VIEWS } from "./admin-views"
import { BoltIcon, BrainIcon, ChatIcon, CloseIcon, DocIcon, LinkIcon, LogoutIcon, MenuIcon, NavBrainIcon, SkillIcon, StackIcon, TagIcon, TaskIcon, UsersIcon, WatchIcon } from "./ui"

type SubItem = { href: string; label: string; count?: number }
type NavItem = { href: string; label: string; icon: ComponentType<{ size?: number }>; count?: number; children?: SubItem[] }

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
  const { t } = useT()
  return (
    <div className="flex items-center gap-3 border-b border-line bg-bone px-4 py-2.5 md:hidden">
      <button type="button" className="btn btn-icon" aria-label={t.shell.openMenu} onClick={onMenu}>
        <MenuIcon />
      </button>
      <span className="min-w-0 truncate text-[14px] font-medium">{fmt(t.shell.brainOf, { name: state.org.name })}</span>
      <span className={`live-dot ml-auto ${live ? "is-live" : ""}`} aria-label={live ? t.shell.live : t.shell.connecting} />
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, live, activeAgents } = useBrainLive()
  const { t } = useT()
  const pathname = usePathname()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isAdmin = state.real.role === "admin"
  const pendingJoins = usePendingJoins(isAdmin)

  const openTasks = state.tasks.filter((x) => x.status === "open").length
  const proposed = state.automations.filter((a) => a.status === "proposed").length
  const main: NavItem[] = [
    { href: "/dashboard", label: t.nav.brain, icon: NavBrainIcon },
    { href: "/etat", label: t.nav.status, icon: DocIcon },
    { href: "/connaissances", label: t.nav.knowledge, icon: StackIcon, count: state.totals.items },
    { href: "/entites", label: t.nav.entities, icon: TagIcon },
    { href: "/skills", label: t.nav.skills, icon: SkillIcon, count: state.totals.skills },
    { href: "/taches", label: t.nav.tasks, icon: TaskIcon, count: openTasks },
    { href: "/automatisations", label: t.nav.automations, icon: BoltIcon, count: proposed },
  ]
  const config: NavItem[] = isAdmin
    ? [
        {
          href: "/admin",
          label: t.nav.team,
          icon: UsersIcon,
          count: pendingJoins,
          children: ADMIN_VIEWS.map((v) => ({ href: v.href, label: t.adminViews[v.id], count: v.id === "requests" ? pendingJoins : undefined })),
        },
        { href: "/onboarding", label: t.nav.onboarding, icon: ChatIcon },
        { href: "/connecteurs", label: t.nav.connectors, icon: LinkIcon },
        { href: "/supervision", label: t.nav.monitoring, icon: WatchIcon },
      ]
    : []

  async function viewAs(userId: string) {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session/view-as", { method: "POST", json: { userId: userId || null } })
      window.location.reload()
    } catch (e) {
      setErr(fmt(t.shell.viewAsError, { error: errorMessage(e) }))
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session", { method: "DELETE" })
    } catch (e) {
      setErr(fmt(t.shell.logoutError, { error: errorMessage(e) }))
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
      aria-label={t.shell.sidebar}
    >
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5 rounded-[6px]">
          <BrainIcon size={26} className="shrink-0" />
          <span className="min-w-0 truncate text-[14px] font-medium leading-tight">{fmt(t.shell.brainOf, { name: state.org.name })}</span>
        </Link>
        <button type="button" className="btn btn-icon btn-sm ml-auto md:hidden" aria-label={t.shell.closeMenu} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="mx-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line pb-3 text-[12px] text-trace">
        <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden />
        <span>{live ? t.shell.live : t.shell.connecting}</span>
        <span className="tabular-nums">{plural(activeAgents, t.shell.activeAgents, t.shell.activeAgentsPlural)}</span>
        {!state.claude && (
          <span className="chip !h-5" title={t.shell.noClaudeHint}>
            {t.shell.noClaude}
          </span>
        )}
      </div>

      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label={t.nav.navigation}>
        <NavList items={main} isActive={isActive} pathname={pathname} />
        {config.length > 0 && (
          <>
            <p className="mb-1 mt-5 px-2.5 text-[12px] text-trace">{t.nav.configuration}</p>
            <NavList items={config} isActive={isActive} pathname={pathname} />
          </>
        )}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        {err && <p role="alert" className="text-[12px] text-danger">{err}</p>}
        {state.impersonating && (
          <p className="inset px-2.5 py-2 text-[12px] leading-snug">{fmt(t.shell.impersonating, { name: state.me.name, zones: state.me.access.readable.join(", ") || t.common.none.toLowerCase() })}</p>
        )}
        {isAdmin && (
          <select
            aria-label={t.shell.viewAs}
            className="input input-sm !w-full"
            value={state.impersonating ? state.me.id : ""}
            disabled={busy}
            onChange={(e) => viewAs(e.target.value)}
          >
            <option value="">{t.shell.viewAsMe}</option>
            {state.people
              .filter((p) => p.id !== state.real.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {fmt(t.shell.viewAsPerson, { name: p.name })}
                  {p.title ? ` (${p.title})` : ""}
                </option>
              ))}
          </select>
        )}
        <div className="flex items-center gap-1">
          <Link
            href={meHref}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-1.5 hover:bg-surface ${isActive(meHref) ? "bg-surface" : ""}`}
            title={t.shell.myContextHint}
            aria-current={isActive(meHref) ? "page" : undefined}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-[10px] font-medium">{initials(state.me.name)}</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium leading-tight">{state.me.name}</span>
              <span className="block truncate text-[12px] leading-tight text-trace">{t.shell.myContext}</span>
            </span>
          </Link>
          <button type="button" className="btn btn-icon shrink-0" onClick={logout} disabled={busy} aria-label={t.shell.logout} title={t.shell.logout}>
            <LogoutIcon />
          </button>
        </div>
        <LanguageSwitch className="justify-end" />
      </div>
    </aside>
  )
}

function NavList({ items, isActive, pathname }: { items: NavItem[]; isActive: (href: string) => boolean; pathname: string }) {
  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const active = isActive(it.href)
        const Icon = it.icon
        // Rubrique à sous-pages : ouverte quand on y est ; la page courante est marquée dans le sous-menu, pas sur la rubrique.
        const open = Boolean(it.children) && active
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={active && !it.children ? "page" : undefined}
              aria-expanded={it.children ? open : undefined}
              className={`flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-[13px] transition-colors duration-150 ease-out ${
                open ? "bg-surface font-medium" : active ? "bg-ink text-surface" : "hover:bg-surface"
              }`}
            >
              <Icon size={16} />
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {!open && it.count !== undefined && it.count > 0 && (
                <span className={`text-[12px] tabular-nums ${active ? "text-line-strong" : "text-trace"}`}>{it.count}</span>
              )}
            </Link>
            {it.children && <SubNav items={it.children} open={open} current={pathname} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Sous-menu d'une rubrique : un fil vertical aligné sur l'icône, et une barre d'encre qui glisse le long du fil
 * jusqu'à la page courante. S'ouvre en hauteur (grille 0fr → 1fr), sans chevron ; fermé, il est inerte.
 */
function SubNav({ items, open, current }: { items: SubItem[]; open: boolean; current: string }) {
  const { t } = useT()
  const index = items.findIndex((c) => c.href === current)
  return (
    <div className={`nav-sub ${open ? "is-open" : ""}`} inert={!open}>
      <div className="min-h-0 overflow-hidden">
        <ul className="relative mb-1.5 ml-[17px] mt-1 border-l border-line" aria-label={t.nav.subpages}>
          {index >= 0 && <span className="nav-sub-mark" style={{ transform: `translateY(${index * 32}px)` }} aria-hidden />}
          {items.map((c) => {
            const here = c.href === current
            return (
              <li key={c.href}>
                <Link
                  href={c.href}
                  aria-current={here ? "page" : undefined}
                  className={`flex h-8 items-center gap-2 pl-3.5 pr-2.5 text-[13px] transition-colors duration-150 ease-out ${
                    here ? "font-medium text-ink" : "text-trace hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.count !== undefined && c.count > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1.5 text-[11px] tabular-nums text-surface">{c.count}</span>}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
