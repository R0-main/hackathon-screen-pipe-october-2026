"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { api } from "./format"
import { BrainIcon, ErrorText } from "./ui"

export function LoginForm({ demo }: { demo: boolean }) {
  const router = useRouter()
  const [token, setToken] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function login(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api("/api/session", { method: "POST", json: { token } })
      router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Link href="/" className="rounded-[6px]" aria-label="Page d'accueil">
            <BrainIcon size={56} />
          </Link>
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
        {demo && (
          <p className="mt-4 text-center text-[13px] text-trace">
            Pas de jeton ?{" "}
            <Link href="/demo" className="underline underline-offset-2 hover:text-ink">
              Essayer la démo
            </Link>
          </p>
        )}
      </div>
    </main>
  )
}
