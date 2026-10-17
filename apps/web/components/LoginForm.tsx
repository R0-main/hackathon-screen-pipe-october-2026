"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { api } from "./format"
import { BrainIcon, ErrorText } from "./ui"

type DemoUser = { id: string; name: string; title?: string; role: string }

export function LoginForm({ demo }: { demo: boolean }) {
  const router = useRouter()
  const [token, setToken] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [users, setUsers] = useState<DemoUser[]>([])

  useEffect(() => {
    if (demo)
      api<{ users: DemoUser[] }>("/api/session/demo")
        .then((r) => setUsers(r.users))
        .catch(() => {})
  }, [demo])

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session", { method: "POST", json: { token } })
      router.push("/")
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function quick(id: string) {
    setBusy(true)
    try {
      await api("/api/session/demo", { method: "POST", json: { userId: id } })
      router.push("/")
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrainIcon size={56} />
          <h1 className="mt-3 text-[24px] font-medium leading-tight">NOS Brainer</h1>
          <p className="mt-1 text-[13px] text-trace">Le contexte de toute l&apos;équipe, capté par Screenpipe, distillé, partagé.</p>
        </div>
        <form onSubmit={login} className="panel space-y-3 p-5" aria-busy={busy}>
          <label className="block text-[13px] font-medium" htmlFor="token">
            Votre jeton personnel
          </label>
          <input
            id="token"
            className="input mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="cb_"
            autoComplete="off"
            aria-describedby="token-help"
            aria-invalid={err ? true : undefined}
          />
          <p id="token-help" className="text-[12px] text-trace">
            Le même jeton que celui de votre prompt d&apos;installation, fourni par l&apos;admin.
          </p>
          {err && <ErrorText>{err}</ErrorText>}
          <button type="submit" className="btn btn-primary w-full" disabled={busy || token.length < 8}>
            Se connecter
          </button>
        </form>
        {demo && users.length > 0 && (
          <div className="panel mt-4 p-5">
            <h2 className="panel-title">Mode démo</h2>
            <p className="mt-1 text-[12px] text-trace">Connexion en un clic avec un compte de démonstration.</p>
            <div className="mt-3 grid gap-2">
              {users.map((u) => (
                <button key={u.id} type="button" className="btn justify-between" onClick={() => quick(u.id)} disabled={busy}>
                  <span>
                    {u.name}
                    {u.title ? <span className="font-normal text-trace">, {u.title}</span> : null}
                  </span>
                  {u.role === "admin" && <span className="chip">admin</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
