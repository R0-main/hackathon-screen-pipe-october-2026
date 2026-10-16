"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { slugify, type Profile, type Zone } from "@brain/core"
import { BrainIcon } from "./TopBar"
import { api, errorMessage } from "./format"

type User = Profile & { zones: string[] }

export function AdminPanel(props: { orgName: string; meId: string; initialUsers: User[]; initialZones: Zone[]; storeKind: string }) {
  const [users, setUsers] = useState(props.initialUsers)
  const [zones, setZones] = useState(props.initialZones)
  const [prompt, setPrompt] = useState<{ name: string; prompt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  /** Relit membres et zones ; ne lève jamais (l'erreur s'affiche en haut de page). Renvoie les zones à jour. */
  async function reload(): Promise<Zone[] | null> {
    try {
      const r = await api<{ users: User[]; zones: Zone[] }>("/api/admin/users")
      setUsers(r.users)
      setZones(r.zones)
      return r.zones
    } catch (e) {
      setErr(`Rechargement impossible : ${errorMessage(e)}`)
      return null
    }
  }

  async function toggleZone(u: User, zone: string) {
    if (u.role === "admin") return
    const next = u.zones.includes(zone) ? u.zones.filter((z) => z !== zone) : [...u.zones, zone]
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, zones: next } : x)))
    setSaving(u.id)
    setErr(null)
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
    setErr(null)
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
    setSaving(u.id)
    setErr(null)
    try {
      const r = await api<{ prompt: string }>(`/api/admin/users/${u.id}/token`, { method: "POST" })
      setPrompt({ name: u.name, prompt: r.prompt })
    } catch (e) {
      setErr(`Nouveau prompt impossible pour ${u.name} : ${errorMessage(e)}`)
    } finally {
      setSaving(null)
    }
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
        {err && (
          <p role="alert" className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2 text-sm text-red-200">
            <span className="min-w-0 flex-1">{err}</span>
            <button className="shrink-0 text-xs text-red-200/70 hover:text-red-100" onClick={() => setErr(null)} aria-label="Masquer l'erreur">
              ✕
            </button>
          </p>
        )}

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
                      <button className="btn !py-1 !text-xs" onClick={() => regenerate(u)} disabled={saving === u.id}>
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
          <InviteForm
            zones={zones}
            onInvited={(name, p) => {
              setPrompt({ name, prompt: p })
              void reload()
            }}
          />
          <ZoneForm zones={zones} reload={reload} storeKind={props.storeKind} />
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
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5">
      <div className="panel-title">Inviter quelqu&apos;un</div>
      <p className="text-sm text-[var(--muted)]">La personne reçoit un prompt à coller dans Claude Code : il installe Screenpipe, brain-sync, le MCP et les hooks.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Prénom Nom" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        <input className="input" placeholder="Poste (ex. Comptable)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
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

/** Zone existante qui porterait le même identifiant (slug) ou le même nom. */
function conflictingZone(name: string, zones: Zone[]): Zone | undefined {
  const id = slugify(name)
  const lower = name.trim().toLowerCase()
  return zones.find((z) => z.id === id || z.name.trim().toLowerCase() === lower)
}

const ZONE_NAME_MAX = 40
const ZONE_KEYWORDS_MAX = 80

function ZoneForm({ zones, reload, storeKind }: { zones: Zone[]; reload: () => Promise<Zone[] | null>; storeKind: string }) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [keywords, setKeywords] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const existing = name.trim() ? conflictingZone(name, zones) : undefined

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(null)
    const words = [...new Set(keywords.split(/[,\n]/).map((k) => k.trim().slice(0, 40)).filter(Boolean))]
    if (words.length > ZONE_KEYWORDS_MAX) {
      setErr(`${ZONE_KEYWORDS_MAX} mots-clés au maximum (${words.length} saisis).`)
      return
    }
    setBusy(true)
    try {
      // Liste fraîche : un autre admin a pu créer la zone depuis l'ouverture de la page. L'API remplace une zone
      // existante au même identifiant (mots-clés compris) : on refuse plutôt que d'écraser en silence.
      const fresh = (await reload()) ?? zones
      const clash = conflictingZone(name, fresh)
      if (clash) {
        setErr(`La zone « ${clash.name} » existe déjà (identifiant « ${clash.id} »). Choisissez un autre nom : ajouter cette zone écraserait sa description et ses mots-clés.`)
        nameRef.current?.focus()
        return
      }
      const created = await api<Zone>("/api/admin/zones", { method: "POST", json: { name: name.trim(), description: description.trim(), keywords: words } })
      setName("")
      setDescription("")
      setKeywords("")
      setOk(`Zone « ${created.name ?? name.trim()} » ajoutée.`)
      await reload()
    } catch (e) {
      setErr(`Ajout de la zone impossible : ${errorMessage(e)}`)
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
      <input
        ref={nameRef}
        className="input"
        placeholder="Nouvelle zone (ex. RH)"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setErr(null)
          setOk(null)
        }}
        maxLength={ZONE_NAME_MAX}
        aria-invalid={existing ? true : undefined}
        aria-describedby={existing ? "zone-exists" : undefined}
        required
      />
      {existing && (
        <p id="zone-exists" className="text-xs text-amber-200">
          « {existing.name} » existe déjà : choisissez un autre nom.
        </p>
      )}
      <input className="input" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      <textarea
        className="input min-h-[70px]"
        placeholder="Mots-clés pour classer automatiquement les sessions (séparés par des virgules)"
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
      />
      {err && (
        <p role="alert" className="text-sm text-red-300">
          {err}
        </p>
      )}
      {ok && <p className="text-sm text-emerald-300">{ok}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button className="btn btn-primary" disabled={busy || !name.trim() || Boolean(existing)}>
          {busy ? "Ajout…" : "Ajouter la zone"}
        </button>
        <span className="text-xs text-[var(--faint)]">Stockage : {storeKind === "postgres" ? "Postgres / Supabase" : "fichier local"}</span>
      </div>
    </form>
  )
}

function PromptModal({ name, prompt, onClose }: { name: string; prompt: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  /** Sélectionne le prompt : copie manuelle possible même sans presse-papiers. */
  function selectPrompt(): boolean {
    const el = preRef.current
    const sel = typeof window !== "undefined" ? window.getSelection() : null
    if (!el || !sel) return false
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  }

  async function copy() {
    setCopyErr(null)
    try {
      // navigator.clipboard n'existe qu'en contexte sécurisé (https ou localhost), pas sur http://<ip-du-réseau>.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt)
      else if (!(selectPrompt() && document.execCommand("copy"))) throw new Error("presse-papiers indisponible")
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      selectPrompt()
      setCopyErr("Copie automatique impossible ici : le prompt est sélectionné, copiez-le avec Ctrl+C (⌘C sur Mac).")
    }
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
        <pre ref={preRef} className="scroll-thin mono mt-4 max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-black/40 p-4 text-[12px] leading-relaxed text-slate-300">
          {prompt}
        </pre>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {copyErr && (
            <p role="alert" className="mr-auto text-xs text-amber-200">
              {copyErr}
            </p>
          )}
          <button className="btn btn-primary" onClick={copy}>
            {copied ? "✓ Copié" : "Copier le prompt"}
          </button>
        </div>
      </div>
    </div>
  )
}
