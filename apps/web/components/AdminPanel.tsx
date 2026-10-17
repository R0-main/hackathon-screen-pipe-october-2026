"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { slugify, type Profile, type Zone } from "@brain/core"
import { PageScroll } from "./AppShell"
import { useBrainLive } from "./BrainLive"
import { AgentLogos } from "./brand-logos"
import { OrgChart, type Presence } from "./OrgChart"
import { AGENT_LABEL, api, errorMessage } from "./format"
import { PersonAvatar } from "./PersonDot"
import { RelTime } from "./RelTime"
import { TeamJoin } from "./TeamJoin"
import { ADMIN_VIEWS, type AdminTab } from "./admin-views"
import { AutoZones } from "./AutoZones"
import { CheckIcon, CloseIcon, Dot, ErrorText, ZoneTag, zoneColor } from "./ui"

type User = Profile & { zones: string[] }

const ACTIVE_MS = 15 * 60_000

/** Ids de `id` et de tout son sous-arbre : on ne peut pas rattacher quelqu'un à l'un d'eux. */
function teamOf(id: string, users: User[]): Set<string> {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const u of users) {
      if (u.manager_id && out.has(u.manager_id) && !out.has(u.id)) {
        out.add(u.id)
        grew = true
      }
    }
  }
  return out
}

export function AdminPanel(props: { tab: AdminTab; orgName: string; meId: string; initialUsers: User[]; initialZones: Zone[]; storeKind: string }) {
  const { feed, now } = useBrainLive()
  const tab = props.tab
  const view = ADMIN_VIEWS.find((v) => v.id === tab)!
  const [users, setUsers] = useState(props.initialUsers)
  const [zones, setZones] = useState(props.initialZones)
  const [selected, setSelected] = useState<string | null>(null)
  const [invite, setInvite] = useState<{ managerId: string | null } | null>(null)
  const [prompt, setPrompt] = useState<{ name: string; prompt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  // Présence de chaque poste d'après le fil des agents : session récente et agents de code utilisés.
  const presence = useMemo(() => {
    const out: Record<string, Presence & { lastAt?: string }> = {}
    for (const e of feed) {
      const p = (out[e.user_id] ??= { active: false, agents: [] })
      if (!p.lastAt) {
        p.lastAt = e.at
        p.active = e.type !== "stopped" && Date.parse(e.at) > now - ACTIVE_MS
      }
      if ((e.agent === "claude-code" || e.agent === "codex") && !p.agents.includes(AGENT_LABEL[e.agent])) p.agents.push(AGENT_LABEL[e.agent])
    }
    return out
  }, [feed, now])

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

  async function patch(u: User, body: Record<string, unknown>, optimistic?: Partial<User>) {
    if (optimistic) setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...optimistic } : x)))
    setSaving(u.id)
    setErr(null)
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: body })
      if (!optimistic) await reload()
    } catch (e) {
      setErr(`${u.name} : ${errorMessage(e)}`)
      await reload()
    } finally {
      setSaving(null)
    }
  }

  function toggleZone(u: User, zone: string) {
    if (u.role === "admin") return
    const next = u.zones.includes(zone) ? u.zones.filter((z) => z !== zone) : [...u.zones, zone]
    void patch(u, { zones: next }, { zones: next })
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

  const selectedUser = users.find((u) => u.id === selected) ?? null
  const defaultManager = users.find((u) => u.role === "admin" && !u.manager_id)?.id ?? null

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-bone px-4 py-4 sm:px-8 sm:py-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-medium leading-tight">{view.label}</h1>
          <p className="mt-1 text-[13px] text-trace">
            {view.lead} Chez {props.orgName} : <span className="tabular-nums">{users.length}</span> personne{users.length > 1 ? "s" : ""},{" "}
            <span className="tabular-nums">{zones.length}</span> zone{zones.length > 1 ? "s" : ""}.
          </p>
        </div>
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setInvite({ managerId: selected ?? defaultManager })}>
          Inviter quelqu&apos;un
        </button>
      </header>

      {err && (
        <div role="alert" className="flex items-start gap-3 border-b border-line bg-surface px-4 py-2.5 text-[13px] text-danger sm:px-8">
          <span className="min-w-0 flex-1">{err}</span>
          <button type="button" className="btn btn-icon btn-sm shrink-0" onClick={() => setErr(null)} aria-label="Masquer l'erreur">
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tab === "org" && <OrgChart users={users} zones={zones} presence={presence} selected={selected} onSelect={setSelected} />}
        {tab === "access" && (
          <PageScroll width="max-w-[1300px]">
            <AccessTable
              users={users}
              zones={zones}
              meId={props.meId}
              saving={saving}
              onToggle={toggleZone}
              onRole={(u, role) => patch(u, { role })}
              onPublishSkills={(u, on) => patch(u, { can_publish_skills: on }, { can_publish_skills: on })}
              onPrompt={regenerate}
            />
          </PageScroll>
        )}
        {tab === "requests" && (
          <PageScroll width="max-w-[860px]">
            <TeamJoin zones={zones} people={users.map((u) => ({ id: u.id, name: u.name }))} defaultManager={defaultManager} onAccepted={() => void reload()} />
          </PageScroll>
        )}
        {tab === "zones" && (
          <PageScroll width="max-w-[720px]">
            <div className="space-y-4">
              <ZoneForm zones={zones} reload={reload} storeKind={props.storeKind} />
              <AutoZones onZonesChanged={() => void reload()} />
            </div>
          </PageScroll>
        )}
      </div>

      {tab === "org" && selectedUser && (
        <MemberDrawer
          user={selectedUser}
          users={users}
          zones={zones}
          meId={props.meId}
          saving={saving === selectedUser.id}
          presence={presence[selectedUser.id]}
          now={now}
          onClose={() => setSelected(null)}
          onToggleZone={(z) => toggleZone(selectedUser, z)}
          onRole={(role) => patch(selectedUser, { role })}
          onManager={(managerId) => patch(selectedUser, { manager_id: managerId }, { manager_id: managerId })}
          onPublishSkills={(on) => patch(selectedUser, { can_publish_skills: on }, { can_publish_skills: on })}
          onPrompt={() => regenerate(selectedUser)}
          onAddReport={() => setInvite({ managerId: selectedUser.id })}
        />
      )}

      {invite && (
        <Modal title="Inviter quelqu'un" onClose={() => setInvite(null)}>
          <InviteForm
            zones={zones}
            users={users}
            defaultManager={invite.managerId}
            onInvited={(name, p) => {
              setInvite(null)
              setPrompt({ name, prompt: p })
              void reload()
            }}
          />
        </Modal>
      )}
      {prompt && <PromptModal name={prompt.name} prompt={prompt.prompt} onClose={() => setPrompt(null)} />}
    </div>
  )
}

/** Panneau latéral d'une personne de l'organigramme : rattachement, rôle, zones, prompt et passation. */
function MemberDrawer(props: {
  user: User
  users: User[]
  zones: Zone[]
  meId: string
  saving: boolean
  presence?: Presence & { lastAt?: string }
  now: number
  onClose: () => void
  onToggleZone: (zone: string) => void
  onRole: (role: "admin" | "member") => void
  onManager: (managerId: string | null) => void
  onPublishSkills: (on: boolean) => void
  onPrompt: () => void
  onAddReport: () => void
}) {
  const { user: u, users, zones, presence: p, onClose } = props
  const closeRef = useRef<HTMLButtonElement>(null)
  const blocked = teamOf(u.id, users)
  const reports = users.filter((x) => x.manager_id === u.id)
  const manager = users.find((x) => x.id === u.manager_id)

  // Dialogue : focus initial sur « Fermer », Échap pour fermer, retour du focus à l'élément déclencheur.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [onClose, u.id])

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="member-drawer-title"
      className="scroll-thin fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line bg-surface p-5"
      aria-busy={props.saving}
    >
      <div className="flex items-start gap-3">
        <span className="relative shrink-0">
          <PersonAvatar id={u.id} size={48} />
          <span className={`absolute bottom-0 right-0 size-3 rounded-full border border-ink ${p?.active ? "bg-phosphor" : "bg-surface"}`} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="member-drawer-title" className="text-[20px] font-medium leading-tight">
            {u.name}
          </h2>
          <p className="text-[13px] text-trace">{[u.title, u.email].filter(Boolean).join(", ") || "Sans poste renseigné"}</p>
        </div>
        <button ref={closeRef} type="button" className="btn btn-icon shrink-0" onClick={onClose} aria-label="Fermer">
          <CloseIcon />
        </button>
      </div>

      <div className="inset mt-4 px-3 py-2.5 text-[13px]">
        {p?.lastAt ? (
          <>
            {p.active ? "Agent actif" : "Dernière activité"} <RelTime iso={p.lastAt} now={props.now} className="tabular-nums" />
            {p.agents.length > 0 && <span className="text-trace">, avec {p.agents.join(" et ")}</span>}
          </>
        ) : (
          <span className="text-trace">Aucune activité d&apos;agent pour l&apos;instant : le poste n&apos;est peut-être pas encore installé.</span>
        )}
      </div>

      <div className="mt-5 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Rattaché à</span>
          <select className="input" value={u.manager_id ?? ""} disabled={props.saving} onChange={(e) => props.onManager(e.target.value || null)}>
            <option value="">Personne (tête de l&apos;organigramme)</option>
            {users
              .filter((x) => !blocked.has(x.id))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.title ? ` (${x.title})` : ""}
                </option>
              ))}
          </select>
          {manager && <span className="mt-1 block text-[12px] text-trace">Rend compte à {manager.name.split(" ")[0]}.</span>}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Rôle</span>
          <select
            className="input"
            value={u.role}
            disabled={u.id === props.meId || props.saving}
            onChange={(e) => props.onRole(e.target.value as "admin" | "member")}
          >
            <option value="member">Membre</option>
            <option value="admin">Admin (voit tout)</option>
          </select>
          {u.id === props.meId && <span className="mt-1 block text-[12px] text-trace">Vous ne pouvez pas retirer vos propres droits admin.</span>}
        </label>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Zones visibles</span>
          {u.role === "admin" ? (
            <p className="text-[13px] text-trace">Les admins lisent toutes les zones.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Zones visibles par ${u.name}`}>
              {zones.map((z) => {
                const on = u.zones.includes(z.id)
                return (
                  <button
                    type="button"
                    key={z.id}
                    className={`chip ${on ? "chip-on" : ""}`}
                    aria-pressed={on}
                    disabled={props.saving}
                    onClick={() => props.onToggleZone(z.id)}
                  >
                    <Dot color={zoneColor(z.color, z.position)} />
                    {z.name}
                  </button>
                )
              })}
            </div>
          )}
          <p className="mt-1.5 text-[12px] text-trace">La personne et ses agents (MCP) ne lisent que ces zones ; tout le monde nourrit le cerveau.</p>
        </div>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Skills de l&apos;entreprise</span>
          {u.role === "admin" ? (
            <p className="text-[13px] text-trace">Les admins peuvent toujours publier des skills.</p>
          ) : (
            <label className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={u.can_publish_skills === true}
                disabled={props.saving}
                onChange={(e) => props.onPublishSkills(e.target.checked)}
              />
              <span>
                Peut publier des skills
                <span className="block text-[12px] text-trace">Dans toute l&apos;entreprise, ou dans les cortex qu&apos;il ou elle lit.</span>
              </span>
            </label>
          )}
        </div>

        {reports.length > 0 && (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium">Équipe directe</span>
            <ul className="flex flex-wrap gap-1.5">
              {reports.map((r) => (
                <li key={r.id} className="chip">
                  {r.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <button type="button" className="btn" onClick={props.onAddReport}>
            Ajouter quelqu&apos;un dans son équipe
          </button>
          <Link className="btn" href={`/people/${u.id}`}>
            Passation
          </Link>
          <button type="button" className="btn" onClick={props.onPrompt} disabled={props.saving}>
            Nouveau prompt
          </button>
        </div>
      </div>
    </aside>
  )
}

function AccessTable(props: {
  users: User[]
  zones: Zone[]
  meId: string
  saving: string | null
  onToggle: (u: User, zone: string) => void
  onRole: (u: User, role: "admin" | "member") => void
  onPublishSkills: (u: User, on: boolean) => void
  onPrompt: (u: User) => void
}) {
  const { users, zones, saving } = props
  return (
    <section className="panel p-4 sm:p-5">
      <h2 className="panel-title">Qui voit quelles zones</h2>
      <p className="mt-1 max-w-3xl text-[13px] text-trace">
        Un membre, et ses agents via le MCP, ne lit que les zones cochées. Tout le monde nourrit le cerveau ; seule la lecture est restreinte. Les admins voient tout.
        Publier des skills demande une autorisation ; un skill attribué à un cortex n&apos;est donné qu&apos;à ceux qui lisent cette zone.
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
              <th scope="col" className="px-2 py-2 text-center font-medium" title="Peut publier des skills de l'entreprise">
                Publie des skills
              </th>
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
                        onChange={() => props.onToggle(u, z.id)}
                        aria-label={`${u.name} : accès à ${z.name}`}
                      />
                    </td>
                  )
                })}
                <td className="px-2 py-2.5 text-center">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={u.role === "admin" || u.can_publish_skills === true}
                    disabled={u.role === "admin" || saving === u.id}
                    onChange={(e) => props.onPublishSkills(u, e.target.checked)}
                    aria-label={`${u.name} : peut publier des skills`}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <select
                    className="input input-sm"
                    aria-label={`Rôle de ${u.name}`}
                    value={u.role}
                    disabled={u.id === props.meId || saving === u.id}
                    onChange={(e) => props.onRole(u, e.target.value as "admin" | "member")}
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
                    <button type="button" className="btn btn-sm" onClick={() => props.onPrompt(u)} disabled={saving === u.id}>
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
  )
}

/** Fenêtre modale simple : Échap ou clic à l'extérieur pour fermer. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function InviteForm({
  zones,
  users,
  defaultManager,
  onInvited,
}: {
  zones: Zone[]
  users: User[]
  defaultManager: string | null
  onInvited: (name: string, prompt: string) => void
}) {
  const [name, setName] = useState("")
  const [manager, setManager] = useState(defaultManager ?? "")
  const [email, setEmail] = useState("")
  const [title, setTitle] = useState("")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [selected, setSelected] = useState<string[]>([])
  const [publishSkills, setPublishSkills] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ prompt: string }>("/api/admin/users", {
        method: "POST",
        json: { name, email, title, role, zones: selected, manager_id: manager || null, can_publish_skills: role === "member" && publishSkills },
      })
      onInvited(name, r.prompt)
      setName("")
      setEmail("")
      setTitle("")
      setSelected([])
      setPublishSkills(false)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5" aria-busy={busy}>
      <h2 className="panel-title">Inviter quelqu&apos;un</h2>
      <p className="text-[13px] text-trace">La personne reçoit un prompt à coller dans Claude Code ou Codex : une commande installe Screenpipe, le MCP et les hooks, puis ouvre le cerveau.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" aria-label="Prénom et nom" placeholder="Prénom Nom" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        <input className="input" aria-label="Poste" placeholder="Poste, par exemple Comptable" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        <input className="input" type="email" aria-label="Email (optionnel)" placeholder="Email (optionnel)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="input" aria-label="Rôle" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Membre</option>
          <option value="admin">Admin (voit tout)</option>
        </select>
        <select className="input sm:col-span-2" aria-label="Rattaché à" value={manager} onChange={(e) => setManager(e.target.value)}>
          <option value="">Rattaché à : personne (tête de l&apos;organigramme)</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              Rattaché à : {u.name}
              {u.title ? ` (${u.title})` : ""}
            </option>
          ))}
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
      {role === "member" && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4" checked={publishSkills} onChange={(e) => setPublishSkills(e.target.checked)} />
          Peut publier des skills de l&apos;entreprise
        </label>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
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
    const words = [
      ...new Set(
        keywords
          .split(/[,\n]/)
          .map((k) => k.trim().slice(0, 40))
          .filter(Boolean),
      ),
    ]
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
    <form onSubmit={submit} className="panel space-y-3 p-4 sm:p-5" aria-busy={busy}>
      <h2 className="panel-title">Zones du cerveau</h2>
      <div className="flex flex-wrap gap-1.5">
        {zones.map((z) => (
          <span key={z.id} className="chip" title={z.keywords.join(", ")}>
            <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
          </span>
        ))}
      </div>
      <input
        ref={nameRef}
        className="input"
        aria-label="Nom de la nouvelle zone"
        placeholder="Nouvelle zone, par exemple RH"
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
        <p id="zone-exists" className="text-[12px] text-trace">
          « {existing.name} » existe déjà : choisissez un autre nom.
        </p>
      )}
      <input className="input" aria-label="Description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      <textarea
        className="input min-h-[70px]"
        aria-label="Mots-clés"
        placeholder="Mots-clés pour classer automatiquement les sessions, séparés par des virgules"
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
      />
      {err && <ErrorText>{err}</ErrorText>}
      {ok && (
        <p role="status" className="inline-flex items-center gap-1.5 text-[13px]">
          <CheckIcon size={14} /> {ok}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || Boolean(existing)}>
          {busy ? "Ajout en cours" : "Ajouter la zone"}
        </button>
        <span className="text-[12px] text-trace">Stockage : {storeKind === "postgres" ? "Postgres / Supabase" : "fichier local"}</span>
      </div>
    </form>
  )
}

function PromptModal({ name, prompt, onClose }: { name: string; prompt: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState<string | null>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="prompt-modal-title" className="panel w-full max-w-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="prompt-modal-title" className="panel-title">
              Prompt d&apos;installation pour {name}
            </h2>
            <p className="mt-1 text-[13px] text-trace">
              À envoyer à {name.split(" ")[0]} par un canal privé : il contient son jeton, affiché une seule fois. Il suffit de le coller dans Claude Code ou Codex, sur son poste.
            </p>
          </div>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Fermer">
            <CloseIcon />
          </button>
        </div>
        <pre ref={preRef} className="scroll-thin mono inset mt-4 max-h-[55vh] overflow-auto whitespace-pre-wrap p-4 text-[12px] leading-relaxed">
          {prompt}
        </pre>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {copyErr && <ErrorText className="mr-auto text-[12px]">{copyErr}</ErrorText>}
          <button ref={copyRef} type="button" className="btn btn-primary" onClick={copy}>
            {copied ? (
              <>
                <CheckIcon size={14} /> Copié
              </>
            ) : (
              <>
                <AgentLogos /> Copier le prompt
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
