"use client"

import Link from "next/link"
import { useState } from "react"
import type { RememberedAccount } from "@/lib/auth"
import { fmt } from "@/lib/i18n"
import { api, errorMessage } from "./format"
import { LanguageSwitch, useT } from "./I18n"
import { PersonAvatar } from "./PersonDot"
import { CloseIcon, ErrorText, Logo, PlusIcon } from "./ui"

/**
 * Connexion : d'abord les entreprises retenues par ce navigateur (un clic pour revenir dans l'une d'elles), puis le jeton
 * personnel, qui en ajoute une. Sans entreprise retenue, le jeton seul.
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
  const [showToken, setShowToken] = useState(adding || accounts.length === 0)
  const [token, setToken] = useState("")
  const [err, setErr] = useState<string | null>(null)
  // « token » pendant la connexion par jeton, sinon l'identifiant du compte en cours d'ouverture ou d'oubli.
  const [busy, setBusy] = useState<string | null>(null)

  // Navigation complète (pas router.push) : le cache du routeur client, qui peut contenir le cerveau d'une autre
  // entreprise, est jeté.
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
      // Session retenue expirée (ou jeton régénéré) : retour au jeton.
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
      if (rest.length === 0) setShowToken(true)
    } catch (e) {
      setErr(fmt(t.login.forgetError, { name: a.org.name, error: errorMessage(e) }))
    } finally {
      setBusy(null)
    }
  }

  const hasList = list.length > 0

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <h1>
            <Link href="/" className="block rounded-[6px]">
              <Logo stacked height={106} />
            </Link>
          </h1>
          <p className="mt-3 text-[13px] text-trace">{t.login.tagline}</p>
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
            {!showToken && (
              <div className="mt-1 border-t border-line px-1 pt-2">
                <button type="button" className="btn btn-ghost w-full justify-start" onClick={() => setShowToken(true)}>
                  <PlusIcon size={14} />
                  {t.login.addCompany}
                </button>
              </div>
            )}
            {err && !showToken && <ErrorText className="px-3 pb-2">{err}</ErrorText>}
          </section>
        )}

        {showToken && (
          <form onSubmit={login} className={`panel space-y-3 p-5 ${hasList ? "mt-3" : ""}`} aria-busy={busy === "token"}>
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
              autoFocus={hasList}
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
          {signup && hasList && (
            <Link href="/creer" className="underline underline-offset-2 hover:text-ink">
              {t.login.create}
            </Link>
          )}
          <LanguageSwitch />
        </div>
      </div>
    </main>
  )
}
