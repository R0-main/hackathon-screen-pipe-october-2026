"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { api, errorMessage } from "./format"
import { BrainIcon, ErrorText } from "./ui"

type DemoUser = { id: string; name: string; title?: string; role: string }

/** Entrée de la démo : un clic sur un compte de Fournil ouvre le dashboard avec ses droits. À côté, créer le sien. */
export function DemoPicker({ signup = false }: { signup?: boolean }) {
  const router = useRouter()
  const [users, setUsers] = useState<DemoUser[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ users: DemoUser[] }>("/api/session/demo")
      .then((r) => setUsers(r.users))
      .catch((e) => setErr(`Comptes de démo indisponibles : ${errorMessage(e)}`))
  }, [])

  async function enter(id: string) {
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session/demo", { method: "POST", json: { userId: id } })
      router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setErr(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      {signup && (
        <Link href="/creer" className="btn btn-primary absolute right-4 top-4 sm:right-6 sm:top-5">
          Créer mon dashboard
        </Link>
      )}
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Link href="/" className="rounded-[6px]" aria-label="Page d'accueil">
            <BrainIcon size={56} />
          </Link>
          <h1 className="mt-3 text-[24px] font-medium leading-tight">La démo : le cerveau de Fournil</h1>
          <p className="mt-1 text-[13px] text-trace">
            Fournil est une entreprise fictive de six personnes. Choisissez qui vous êtes : chacun ne voit que les zones auxquelles il a accès.
          </p>
        </div>
        <section className="panel p-5" aria-busy={busy || users === null}>
          <h2 className="panel-title">Entrer en tant que</h2>
          {users === null && !err && (
            <p className="mt-3 text-[13px] text-trace" aria-live="polite">
              Chargement des comptes
            </p>
          )}
          <div className="mt-3 grid gap-2">
            {users?.map((u) => (
              <button key={u.id} type="button" className="btn justify-between" onClick={() => enter(u.id)} disabled={busy}>
                <span>
                  {u.name}
                  {u.title ? <span className="font-normal text-trace">, {u.title}</span> : null}
                </span>
                {u.role === "admin" && <span className="chip">admin</span>}
              </button>
            ))}
          </div>
          {err && <ErrorText className="mt-3">{err}</ErrorText>}
        </section>
        {signup && (
          <section className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 py-3">
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">Votre entreprise, plutôt que Fournil ?</span>
              <span className="block text-[13px] text-trace">Quatre questions, puis un prompt à coller dans Claude Code ou Codex.</span>
            </span>
            <Link href="/creer" className="btn">
              Créer mon dashboard
            </Link>
          </section>
        )}
        <p className="mt-4 text-center text-[13px] text-trace">
          Vous avez un jeton personnel ?{" "}
          <Link href="/login" className="underline underline-offset-2 hover:text-ink">
            Se connecter
          </Link>
        </p>
      </div>
    </main>
  )
}
