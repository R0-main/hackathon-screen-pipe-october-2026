"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import type { RememberedAccount } from "@/lib/auth"
import { fmt, plural } from "@/lib/i18n"
import { useBrainLive } from "./BrainLive"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { PersonAvatar } from "./PersonDot"
import { usePendingJoins } from "./TeamJoin"
import { ADMIN_VIEWS } from "./admin-views"
import {
  ArchiveIcon,
  BoltIcon,
  BrainIcon,
  ChatIcon,
  CheckIcon,
  ChevronsIcon,
  CloseIcon,
  DocIcon,
  LinkIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  NavBrainIcon,
  PaperclipIcon,
  PlusIcon,
  SkillIcon,
  StackIcon,
  TagIcon,
  TaskIcon,
  UsersIcon,
  WatchIcon,
} from "./ui"

type SubItem = { href: string; label: string; count?: number }
type NavItem = { href: string; label: string; icon: ComponentType<{ size?: number }>; count?: number; children?: SubItem[] }

/**
 * The app layout: the sidebar on the left, the page on the right. The window never scrolls:
 * the brain takes the full height, the other pages scroll in their own column.
 */
export function AppShell({ children, accounts = [], signup = false }: { children: ReactNode; accounts?: RememberedAccount[]; signup?: boolean }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  useEffect(() => setOpen(false), [pathname])

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className={`fixed inset-0 z-40 bg-ink/20 md:hidden ${open ? "" : "hidden"}`} onClick={() => setOpen(false)} aria-hidden />
      <Sidebar open={open} onClose={() => setOpen(false)} accounts={accounts} signup={signup} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar onMenu={() => setOpen(true)} />
        <main className="relative min-h-0 flex-1">{children}</main>
      </div>
    </div>
  )
}

/** Scrolling column of a secondary page (everything but the brain). */
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

function Sidebar({ open, onClose, accounts, signup }: { open: boolean; onClose: () => void; accounts: RememberedAccount[]; signup: boolean }) {
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
    { href: "/status", label: t.nav.status, icon: DocIcon },
    { href: "/knowledge", label: t.nav.knowledge, icon: StackIcon, count: state.totals.items },
    { href: "/documents", label: t.nav.documents, icon: PaperclipIcon, count: state.totals.documents || undefined },
    { href: "/entities", label: t.nav.entities, icon: TagIcon },
    { href: "/skills", label: t.nav.skills, icon: SkillIcon, count: state.totals.skills },
    { href: "/tasks", label: t.nav.tasks, icon: TaskIcon, count: openTasks },
    { href: "/automations", label: t.nav.automations, icon: BoltIcon, count: proposed },
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
        { href: "/connectors", label: t.nav.connectors, icon: LinkIcon },
        { href: "/monitoring", label: t.nav.monitoring, icon: WatchIcon },
        { href: "/data", label: t.nav.data, icon: ArchiveIcon },
      ]
    : []
  // Members export their skills, clients and sheet from the same page, without the configuration section.
  if (!isAdmin) main.push({ href: "/data", label: t.nav.data, icon: ArchiveIcon })

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
    // Full navigation (not router.push): the client router cache, which still holds the signed-in person's
    // brain, is thrown away, and the "/" entry is replaced in the history.
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
      <CompanySwitcher accounts={accounts} signup={signup} onClose={onClose} />

      <div className="mx-4 space-y-1 border-b border-line pb-3 text-[12px] text-trace">
        <p className="flex items-center gap-2" title={live ? t.shell.agentsHint : undefined}>
          <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden />
          <span className="tabular-nums">
            {!live ? t.shell.connecting : activeAgents === 0 ? t.shell.noAgents : plural(activeAgents, t.shell.activeAgents, t.shell.activeAgentsPlural)}
          </span>
        </p>
        {!state.claude && isAdmin && (
          <Link href="/admin/zones" onClick={onClose} title={t.shell.noClaudeHint} className="block pl-4 underline-offset-2 hover:text-ink hover:underline">
            {t.shell.noClaude} →
          </Link>
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
            <PersonAvatar id={state.me.id} size={28} bg="surface" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium leading-tight">{state.me.name}</span>
              <span className="block truncate text-[12px] leading-tight text-trace">{t.shell.myContext}</span>
            </span>
          </Link>
          <button type="button" className="btn btn-icon shrink-0" onClick={logout} disabled={busy} aria-label={t.shell.logout} title={t.shell.logout}>
            <LogoutIcon />
          </button>
        </div>
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
        // Section with sub-pages: open while on it; the current page is marked in the sub-menu, not on the section.
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
 * A section's sub-menu: a vertical thread aligned with the icon, and an ink bar that slides along the thread
 * to the current page. Opens in height (grid 0fr → 1fr), without a chevron; closed, it is inert.
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

/**
 * Sidebar header: the open company. A click unfolds the companies remembered by this browser (one more click to switch
 * from one to another), then a way to add one (its token) or create one.
 */
function CompanySwitcher({ accounts, signup, onClose }: { accounts: RememberedAccount[]; signup: boolean; onClose: () => void }) {
  const { state } = useBrainLive()
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Session opened before the browser remembered companies: it shows in the list anyway.
  const here = accounts.some((a) => a.org.id === state.org.id)
  const companies: RememberedAccount[] = here
    ? accounts
    : [{ userId: state.real.id, name: state.real.name, title: state.real.title, role: state.real.role, org: { id: state.org.id, name: state.org.name, description: state.org.description } }, ...accounts]

  async function switchTo(a: RememberedAccount) {
    setBusy(a.userId)
    setErr(null)
    try {
      await api("/api/session/accounts", { method: "POST", json: { userId: a.userId } })
      // Full navigation: nothing from the previous company's brain stays in the router cache.
      window.location.assign("/dashboard")
    } catch (e) {
      setErr(fmt(t.shell.switchError, { error: errorMessage(e) }))
      setBusy(null)
    }
  }

  const row = "flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[13px] transition-colors duration-150 ease-out hover:bg-bone"

  return (
    <div className="px-2 pb-3 pt-3" onKeyDown={(e) => e.key === "Escape" && open && setOpen(false)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-surface"
          aria-expanded={open}
          aria-controls="company-switcher"
          title={t.shell.switchCompany}
          onClick={() => setOpen((o) => !o)}
        >
          <LogoMark size={26} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-tight">{fmt(t.shell.brainOf, { name: state.org.name })}</span>
          <ChevronsIcon size={14} className="shrink-0 text-trace" />
        </button>
        <button type="button" className="btn btn-icon btn-sm md:hidden" aria-label={t.shell.closeMenu} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      {open && (
        <div id="company-switcher" className="panel mt-1.5 p-1" aria-busy={busy !== null}>
          <p className="px-2.5 pb-1 pt-1.5 text-[12px] text-trace">{t.shell.companies}</p>
          <ul>
            {companies.map((a) => {
              const current = a.org.id === state.org.id
              return (
                <li key={a.userId}>
                  <button
                    type="button"
                    className={`${row} disabled:cursor-default`}
                    aria-current={current ? "true" : undefined}
                    aria-label={current ? fmt(t.shell.currentCompany, { name: a.org.name }) : fmt(t.shell.openCompany, { name: a.org.name })}
                    title={a.org.description || undefined}
                    disabled={busy !== null}
                    onClick={() => (current ? setOpen(false) : switchTo(a))}
                  >
                    <PersonAvatar id={a.userId} size={24} bg="surface" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium leading-tight">{a.org.name}</span>
                      <span className="block truncate text-[12px] leading-tight text-trace">{a.name}</span>
                    </span>
                    {current && <CheckIcon size={14} className="shrink-0" />}
                  </button>
                </li>
              )
            })}
          </ul>
          {err && (
            <p role="alert" className="px-2.5 py-1.5 text-[12px] text-danger">
              {err}
            </p>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <Link href="/login?add=1" className={row}>
              <PlusIcon size={14} className="shrink-0" />
              {t.shell.addCompany}
            </Link>
            {signup && (
              <Link href="/create" className={`${row} text-trace hover:text-ink`}>
                <BrainIcon size={14} className="shrink-0" />
                {t.shell.createCompany}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
