"use client"

import Link from "next/link"
import { useState } from "react"
import type { RememberedAccount } from "@/lib/auth"
import { fmt } from "@/lib/i18n"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { PersonAvatar } from "./PersonDot"
import { ThemeToggle } from "./theme"
import { CloseIcon, ErrorText, LogoMark, PlusIcon } from "./ui"

/**
 * Sign-in: first the companies remembered by this browser (one click to go back into one of them), then, large, creating
 * a company. The personal token stays folded underneath: everything else goes through Claude Code or Codex. With no
 * creation possible (`BRAIN_SIGNUP=0`) and no remembered company, the token alone.
 */
export function LoginForm({
  demo,
  signup = false,
  accounts = [],
  currentId = null,
  adding = false,
}: {
  demo: boolean
  signup?: boolean
  accounts?: RememberedAccount[]
  currentId?: string | null
  adding?: boolean
}) {
  const { t } = useT()
  const [list, setList] = useState(accounts)
  const [showToken, setShowToken] = useState(adding || (!signup && accounts.length === 0))
  const [token, setToken] = useState("")
  const [err, setErr] = useState<string | null>(null)
  // "token" during sign-in with a token, otherwise the id of the account being opened or forgotten.
  const [busy, setBusy] = useState<string | null>(null)

  // Full navigation (not router.push): the client router's cache, which may hold another company's brain, is
  // thrown away.
  const openDashboard = () => window.location.assign("/dashboard")

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setBusy("token")
    setErr(null)
    try {
      await api("/api/session", { method: "POST", json: { token } })
      openDashboard()
    } catch (e) {
      setErr(errorMessage(e))
      setBusy(null)
    }
  }

  async function enter(a: RememberedAccount) {
    setBusy(a.userId)
    setErr(null)
    try {
      await api("/api/session/accounts", { method: "POST", json: { userId: a.userId } })
      openDashboard()
    } catch (e) {
      // Remembered session expired (or token regenerated): back to the token.
      setErr(errorMessage(e))
      setShowToken(true)
      setBusy(null)
    }
  }

  async function forget(a: RememberedAccount) {
    setBusy(a.userId)
    setErr(null)
    try {
      await api("/api/session/accounts", { method: "DELETE", json: { userId: a.userId } })
      const rest = list.filter((x) => x.userId !== a.userId)
      setList(rest)
      if (rest.length === 0 && !signup) setShowToken(true)
    } catch (e) {
      setErr(fmt(t.login.forgetError, { name: a.org.name, error: errorMessage(e) }))
    } finally {
      setBusy(null)
    }
  }

  const hasList = list.length > 0

  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <ThemeToggle className="btn btn-ghost btn-icon absolute right-4 top-4" />
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Link href="/" className="rounded-[6px]" aria-label={t.login.home}>
            <LogoMark size={56} />
          </Link>
          <h1 className="mt-3 text-[24px] font-medium leading-tight">NOS Brainer</h1>
          <p className="mt-1 text-[13px] text-trace">{t.login.tagline}</p>
        </div>

        {hasList && (
          <section className="panel p-2" aria-labelledby="companies-title" aria-busy={busy !== null}>
            <div className="px-3 pb-2 pt-2">
              <h2 id="companies-title" className="panel-title">
                {t.login.companies}
              </h2>
              <p className="mt-0.5 text-[12px] text-trace">{t.login.companiesHelp}</p>
            </div>
            <ul className="space-y-0.5">
              {list.map((a) => {
                const current = a.userId === currentId
                return (
                  <li key={a.userId} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-[6px] px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-bone disabled:cursor-default disabled:opacity-60"
                      onClick={() => enter(a)}
                      disabled={busy !== null}
                      aria-label={fmt(t.login.enter, { name: a.org.name })}
                      title={a.org.description || undefined}
                    >
                      <PersonAvatar id={a.userId} size={32} bg="surface" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium leading-tight">{a.org.name}</span>
                        <span className="block truncate text-[12px] leading-tight text-trace">
                          {a.name}
                          {a.title ? `, ${a.title}` : ""}
                        </span>
                      </span>
                      {current && <span className="chip">{t.login.current}</span>}
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm btn-ghost shrink-0"
                      onClick={() => forget(a)}
                      disabled={busy !== null}
                      aria-label={fmt(t.login.forget, { name: a.org.name })}
                      title={fmt(t.login.forget, { name: a.org.name })}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </li>
                )
              })}
            </ul>
            {err && !showToken && <ErrorText className="px-3 pb-2">{err}</ErrorText>}
          </section>
        )}

        {signup && (
          <div className={hasList ? "mt-3" : ""}>
            <Link href="/create" className="btn btn-primary btn-lg w-full">
              <PlusIcon size={14} />
              {t.login.create}
            </Link>
            <p className="mt-2 text-center text-[12px] text-trace">{t.login.createHelp}</p>
          </div>
        )}

        {showToken ? (
          <form onSubmit={login} className={`panel space-y-3 p-5 ${hasList || signup ? "mt-3" : ""}`} aria-busy={busy === "token"}>
            <label className="block text-[13px] font-medium" htmlFor="token">
              {hasList ? t.login.addTokenLabel : t.login.tokenLabel}
            </label>
            <input
              id="token"
              className="input mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="cb_"
              autoComplete="off"
              autoFocus={hasList || signup}
              aria-describedby="token-help"
              aria-invalid={err ? true : undefined}
            />
            <p id="token-help" className="text-[12px] text-trace">
              {hasList ? t.login.addTokenHelp : t.login.tokenHelp}
            </p>
            {err && <ErrorText>{err}</ErrorText>}
            <button type="submit" className="btn btn-primary w-full" disabled={busy !== null || token.length < 8}>
              {t.login.submit}
            </button>
          </form>
        ) : (
          <p className="mt-3 text-center">
            <button type="button" className="text-[13px] text-trace underline underline-offset-2 hover:text-ink" onClick={() => setShowToken(true)}>
              {t.login.useToken}
            </button>
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-[13px] text-trace">
          {demo && (
            <p>
              {t.login.noToken}{" "}
              <Link href="/demo" className="underline underline-offset-2 hover:text-ink">
                {t.login.tryDemo}
              </Link>
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
