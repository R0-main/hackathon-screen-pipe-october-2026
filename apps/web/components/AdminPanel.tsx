"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { Profile, Zone } from "@brain/core"
import { BrainIcon } from "./TopBar"
import { api } from "./format"
import { CheckIcon, CloseIcon, Dot, ErrorText, ZoneTag, zoneColor } from "./ui"

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
    <div className="min-h-dvh">
      <header className="border-b border-line bg-bone">
        <div className="mx-auto flex max-w-[1300px] items-center gap-3 px-4 py-3 sm:px-6">
          <BrainIcon />
          <h1 className="text-[15px] font-medium">
            Équipe et accès <span className="font-normal text-trace">{props.orgName}</span>
          </h1>
          <Link href="/" className="btn ml-auto">
            Retour au cerveau
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1300px] space-y-4 px-4 py-6 sm:px-6">
        {err && <ErrorText className="panel px-4 py-2">{err}</ErrorText>}

        <section className="panel p-4 sm:p-5">
          <h2 className="panel-title">Qui voit quelles zones</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-trace">
            Un membre, et ses agents via le MCP, ne lit que les zones cochées. Tout le monde nourrit le cerveau ; seule la lecture est restreinte. Les admins voient tout.
          </p>
          <div className="scroll-thin mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-trace">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Membre
                  </th>
                  {zones.map((z) => (
                    <th key={z.id} scope="col" className="px-2 py-2 text-center font-medium text-ink">
                      <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
                    </th>
                  ))}
                  <th scope="col" className="px-2 py-2 font-medium">
                    Rôle
                  </th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-line">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-[12px] text-trace">{u.title ?? u.email ?? ""}</div>
                    </td>
                    {zones.map((z) => {
                      const on = u.role === "admin" || u.zones.includes(z.id)
                      return (
                        <td key={z.id} className="px-2 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="size-4"
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
                        className="input input-sm"
                        aria-label={`Rôle de ${u.name}`}
                        value={u.role}
                        disabled={u.id === props.meId || saving === u.id}
                        onChange={(e) => setRole(u, e.target.value as "admin" | "member")}
                      >
                        <option value="member">Membre</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right">
                      <div className="inline-flex gap-1.5">
                        <Link className="btn btn-sm" href={`/people/${u.id}`}>
                          Passation
                        </Link>
                        <button type="button" className="btn btn-sm" onClick={() => regenerate(u)}>
                          Nouveau prompt
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <InviteForm
            zones={zones}
            onInvited={async (name, p) => {
              setPrompt({ name, prompt: p })
              await reload()
            }}
          />
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
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5" aria-busy={busy}>
      <h2 className="panel-title">Inviter quelqu&apos;un</h2>
      <p className="text-[13px] text-trace">La personne reçoit un prompt à coller dans Claude Code : il installe Screenpipe, brain-sync, le MCP et les hooks.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" aria-label="Prénom et nom" placeholder="Prénom Nom" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" aria-label="Poste" placeholder="Poste, par exemple Comptable" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input" type="email" aria-label="Email (optionnel)" placeholder="Email (optionnel)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="input" aria-label="Rôle" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Membre</option>
          <option value="admin">Admin (voit tout)</option>
        </select>
      </div>
      {role === "member" && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Zones accessibles">
          {zones.map((z) => {
            const on = selected.includes(z.id)
            return (
              <button
                type="button"
                key={z.id}
                className={`chip ${on ? "chip-on" : ""}`}
                aria-pressed={on}
                onClick={() => setSelected((s) => (on ? s.filter((x) => x !== z.id) : [...s, z.id]))}
              >
                <Dot color={zoneColor(z.color, z.position)} />
                {z.name}
              </button>
            )
          })}
        </div>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
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
        json: {
          name,
          description,
          keywords: keywords
            .split(/[,\n]/)
            .map((k) => k.trim())
            .filter(Boolean),
        },
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
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5" aria-busy={busy}>
      <h2 className="panel-title">Zones du cerveau</h2>
      <div className="flex flex-wrap gap-1.5">
        {zones.map((z) => (
          <span key={z.id} className="chip" title={z.keywords.join(", ")}>
            <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
          </span>
        ))}
      </div>
      <input className="input" aria-label="Nom de la nouvelle zone" placeholder="Nouvelle zone, par exemple RH" value={name} onChange={(e) => setName(e.target.value)} required />
      <input className="input" aria-label="Description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <textarea
        className="input min-h-[70px]"
        aria-label="Mots-clés"
        placeholder="Mots-clés pour classer automatiquement les sessions, séparés par des virgules"
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          Ajouter la zone
        </button>
        <span className="text-[12px] text-trace">Stockage : {storeKind === "postgres" ? "Postgres / Supabase" : "fichier local"}</span>
      </div>
    </form>
  )
}

function PromptModal({ name, prompt, onClose }: { name: string; prompt: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    copyRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [onClose])

  async function copy() {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="prompt-modal-title" className="panel w-full max-w-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="prompt-modal-title" className="panel-title">
              Prompt d&apos;installation pour {name}
            </h2>
            <p className="mt-1 text-[13px] text-trace">
              À envoyer à {name.split(" ")[0]} par un canal privé : il contient son jeton, affiché une seule fois. Il suffit de le coller dans Claude Code.
            </p>
          </div>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Fermer">
            <CloseIcon />
          </button>
        </div>
        <pre className="scroll-thin mono inset mt-4 max-h-[55vh] overflow-auto whitespace-pre-wrap p-4 text-[12px] leading-relaxed">{prompt}</pre>
        <div className="mt-4 flex justify-end gap-2">
          <button ref={copyRef} type="button" className="btn btn-primary" onClick={copy}>
            {copied ? (
              <>
                <CheckIcon size={14} /> Copié
              </>
            ) : (
              "Copier le prompt"
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
