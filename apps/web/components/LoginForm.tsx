"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { BrainIcon } from "./TopBar"
import { api } from "./format"

type DemoUser = { id: string; name: string; title?: string; role: string }

export function LoginForm({ demo }: { demo: boolean }) {
  const router = useRouter()
  const [token, setToken] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [users, setUsers] = useState<DemoUser[]>([])

  useEffect(() => {
    if (demo) api<{ users: DemoUser[] }>("/api/session/demo").then((r) => setUsers(r.users)).catch(() => {})
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
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrainIcon size={56} />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Cerveau d&apos;entreprise</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Le contexte de toute l&apos;équipe, capté par Screenpipe, distillé, partagé.</p>
        </div>
        <form onSubmit={login} className="panel space-y-3 p-5">
          <label className="block text-sm font-medium" htmlFor="token">
            Votre jeton personnel
          </label>
          <input id="token" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cb_…" autoComplete="off" />
          <p className="text-xs text-[var(--faint)]">Le même jeton que celui de votre prompt d&apos;installation, fourni par l&apos;admin.</p>
          {err && <p className="text-sm text-red-300">{err}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={busy || token.length < 8}>
            Se connecter
          </button>
        </form>
        {demo && users.length > 0 && (
          <div className="panel mt-4 p-5">
            <div className="panel-title">Mode démo — connexion en un clic</div>
            <div className="mt-3 grid gap-2">
              {users.map((u) => (
                <button key={u.id} className="btn justify-between" onClick={() => quick(u.id)} disabled={busy}>
                  <span>
                    {u.name}
                    {u.title ? <span className="text-[var(--muted)]"> · {u.title}</span> : null}
                  </span>
                  {u.role === "admin" && <span className="chip !py-0">admin</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
