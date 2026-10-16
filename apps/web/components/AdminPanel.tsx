"use client"

import Link from "next/link"
import { useState } from "react"
import type { Profile, Zone } from "@brain/core"
import { BrainIcon } from "./TopBar"
import { api } from "./format"

type User = Profile & { zones: string[] }

export function AdminPanel(props: { orgName: string; meId: string; initialUsers: User[]; initialZones: Zone[]; storeKind: string }) {
  const [users, setUsers] = useState(props.initialUsers)
  const [zones, setZones] = useState(props.initialZones)
  const [prompt, setPrompt] = useState<{ name: string; prompt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  async function reload() {
    const r = await api<{ users: User[]; zones: Zone[] }>("/api/admin/users")
    setUsers(r.users)
    setZones(r.zones)
  }

  async function toggleZone(u: User, zone: string) {
    if (u.role === "admin") return
    const next = u.zones.includes(zone) ? u.zones.filter((z) => z !== zone) : [...u.zones, zone]
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, zones: next } : x)))
    setSaving(u.id)
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: { zones: next } })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      await reload()
    } finally {
      setSaving(null)
    }
  }

  async function setRole(u: User, role: "admin" | "member") {
    setSaving(u.id)
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: { role } })
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  async function regenerate(u: User) {
    if (!confirm(`Régénérer le jeton de ${u.name} ? L'ancien cessera de fonctionner sur son poste.`)) return
    const r = await api<{ prompt: string }>(`/api/admin/users/${u.id}/token`, { method: "POST" })
    setPrompt({ name: u.name, prompt: r.prompt })
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-[rgba(4,6,12,0.75)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1300px] items-center gap-3 px-4 py-3 sm:px-6">
          <BrainIcon />
          <div className="font-semibold">Équipe &amp; accès · {props.orgName}</div>
          <Link href="/" className="btn ml-auto">
            ← Retour au cerveau
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1300px] space-y-4 px-4 py-6 sm:px-6">
        {err && <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2 text-sm text-red-200">{err}</p>}

        <section className="panel p-4 sm:p-5">
          <div className="panel-title">Qui voit quelles zones</div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Un membre (et ses agents, via le MCP) ne lit que les zones cochées. Tout le monde nourrit le cerveau ; seule la lecture est restreinte. Les admins voient tout.
          </p>
          <div className="scroll-thin mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--muted)]">
                  <th className="py-2 pr-3 font-medium">Membre</th>
                  {zones.map((z) => (
                    <th key={z.id} className="px-2 py-2 text-center font-semibold uppercase tracking-wider" style={{ color: z.color }}>
                      {z.name}
                    </th>
                  ))}
                  <th className="px-2 py-2 font-medium">Rôle</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-[var(--border)]">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-[var(--faint)]">{u.title ?? u.email ?? ""}</div>
                    </td>
                    {zones.map((z) => {
                      const on = u.role === "admin" || u.zones.includes(z.id)
                      return (
                        <td key={z.id} className="px-2 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-cyan-400"
                            checked={on}
                            disabled={u.role === "admin" || saving === u.id}
                            onChange={() => toggleZone(u, z.id)}
                            aria-label={`${u.name} : accès à ${z.name}`}
                          />
                        </td>
                      )
                    })}
                    <td className="px-2 py-2.5">
                      <select
                        className="input !w-auto !py-1 !text-xs"
                        value={u.role}
                        disabled={u.id === props.meId || saving === u.id}
                        onChange={(e) => setRole(u, e.target.value as "admin" | "member")}
                      >
                        <option value="member">Membre</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right">
                      <Link className="btn !py-1 !text-xs" href={`/people/${u.id}`}>
                        Passation
                      </Link>{" "}
                      <button className="btn !py-1 !text-xs" onClick={() => regenerate(u)}>
                        Nouveau prompt
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <InviteForm zones={zones} onInvited={async (name, p) => { setPrompt({ name, prompt: p }); await reload() }} />
          <ZoneForm zones={zones} onSaved={reload} storeKind={props.storeKind} />
        </div>
      </main>
      {prompt && <PromptModal name={prompt.name} prompt={prompt.prompt} onClose={() => setPrompt(null)} />}
    </div>
  )
}

function InviteForm({ zones, onInvited }: { zones: Zone[]; onInvited: (name: string, prompt: string) => void }) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [title, setTitle] = useState("")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ prompt: string }>("/api/admin/users", { method: "POST", json: { name, email, title, role, zones: selected } })
      onInvited(name, r.prompt)
      setName("")
      setEmail("")
      setTitle("")
      setSelected([])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5">
      <div className="panel-title">Inviter quelqu&apos;un</div>
      <p className="text-sm text-[var(--muted)]">La personne reçoit un prompt à coller dans Claude Code : il installe Screenpipe, brain-sync, le MCP et les hooks.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Prénom Nom" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Poste (ex. Comptable)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input" type="email" placeholder="email (optionnel)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Membre</option>
          <option value="admin">Admin (voit tout)</option>
        </select>
      </div>
      {role === "member" && (
        <div className="flex flex-wrap gap-1.5">
          {zones.map((z) => {
            const on = selected.includes(z.id)
            return (
              <button
                type="button"
                key={z.id}
                className="chip"
                style={on ? { color: z.color, borderColor: z.color, background: `${z.color}18` } : undefined}
                onClick={() => setSelected((s) => (on ? s.filter((x) => x !== z.id) : [...s, z.id]))}
              >
                {on ? "✓ " : ""}
                {z.name}
              </button>
            )
          })}
        </div>
      )}
      {err && <p className="text-sm text-red-300">{err}</p>}
      <button className="btn btn-primary" disabled={busy || !name.trim()}>
        Créer le compte et le prompt
      </button>
    </form>
  )
}

function ZoneForm({ zones, onSaved, storeKind }: { zones: Zone[]; onSaved: () => void; storeKind: string }) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [keywords, setKeywords] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api("/api/admin/zones", {
        method: "POST",
        json: { name, description, keywords: keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean) },
      })
      setName("")
      setDescription("")
      setKeywords("")
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5">
      <div className="panel-title">Zones du cerveau</div>
      <div className="flex flex-wrap gap-1.5">
        {zones.map((z) => (
          <span key={z.id} className="chip" style={{ color: z.color, borderColor: `${z.color}55` }} title={z.keywords.join(", ")}>
            {z.name}
          </span>
        ))}
      </div>
      <input className="input" placeholder="Nouvelle zone (ex. RH)" value={name} onChange={(e) => setName(e.target.value)} required />
      <input className="input" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <textarea
        className="input min-h-[70px]"
        placeholder="Mots-clés pour classer automatiquement les sessions (séparés par des virgules)"
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          Ajouter la zone
        </button>
        <span className="text-xs text-[var(--faint)]">Stockage : {storeKind === "postgres" ? "Postgres / Supabase" : "fichier local"}</span>
      </div>
    </form>
  )
}

function PromptModal({ name, prompt, onClose }: { name: string; prompt: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-3xl bg-[#070b16] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="panel-title">Prompt d&apos;installation pour {name}</div>
            <p className="mt-1 text-sm text-[var(--muted)]">
              À envoyer à {name.split(" ")[0]} par un canal privé : il contient son jeton, affiché une seule fois. Il suffit de le coller dans Claude Code.
            </p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>
        <pre className="scroll-thin mono mt-4 max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-black/40 p-4 text-[12px] leading-relaxed text-slate-300">
          {prompt}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-primary" onClick={copy}>
            {copied ? "✓ Copié" : "Copier le prompt"}
          </button>
        </div>
      </div>
    </div>
  )
}
