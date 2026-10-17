"use client"

import { useCallback, useEffect, useState } from "react"
import { copyText } from "./PromptActions"
import { api, errorMessage, initials } from "./format"
import { RelTime } from "./RelTime"
import { CheckIcon, Dot, ErrorText, zoneColor } from "./ui"

type ZoneLite = { id: string; name: string; color: string; position: number }
type Person = { id: string; name: string }
export type JoinRequest = {
  id: string
  name: string | null
  title: string | null
  email: string | null
  hostname: string | null
  created_at: string
}
export type Accepted = { id: string; name: string; title?: string; zones: string[] }

const POLL_MS = 4000

/**
 * Le deuxième moyen d'ajouter quelqu'un : un seul message pour toute l'équipe. Chacun le colle dans Claude Code, qui
 * envoie une demande préremplie ; un admin la complète (rôle, zones, rattachement) et l'accepte, et le poste termine
 * son installation tout seul. Les demandes en attente sont relues régulièrement.
 */
export function TeamJoin(props: { zones: ZoneLite[]; people?: Person[]; defaultManager?: string | null; onAccepted?: (p: Accepted) => void; compact?: boolean }) {
  const [prompt, setPrompt] = useState<string | null>(null)
  const [requests, setRequests] = useState<JoinRequest[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<{ prompt: string; requests: JoinRequest[] }>("/api/admin/join")
      setPrompt(r.prompt)
      setRequests(r.requests)
    } catch (e) {
      setErr(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  async function copy() {
    setErr(null)
    try {
      await copyText(prompt ?? api<{ prompt: string }>("/api/admin/join").then((r) => r.prompt))
      setCopied(true)
    } catch (e) {
      setErr(`Copie impossible : ${errorMessage(e)}`)
    }
  }

  async function rotate() {
    if (!confirm("Changer le code ? L'ancien message cessera de marcher ; les demandes déjà reçues restent.")) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ prompt: string }>("/api/admin/join", { method: "POST", json: { rotate: true } })
      setPrompt(r.prompt)
      setCopied(false)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className={props.compact ? "" : "panel px-5 py-5"}>
        {!props.compact && <h2 className="panel-title">Un message pour toute l'équipe</h2>}
        <p className={`${props.compact ? "" : "mt-1.5"} max-w-[40em] text-[14px] leading-relaxed text-trace`}>
          Le même message pour tout le monde : chacun le colle dans Claude Code, qui envoie une demande avec ce qu'il sait déjà (nom, poste, email). Vous la complétez
          et l'acceptez ici, et son poste s'installe tout seul.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn" onClick={copy} disabled={busy}>
            {copied ? (
              <>
                <CheckIcon size={14} /> Message copié
              </>
            ) : (
              "Copier le message d'équipe"
            )}
          </button>
          <button type="button" className="text-[13px] text-trace hover:text-ink" onClick={rotate} disabled={busy}>
            Changer le code
          </button>
        </div>
        <p className="mt-3 max-w-[40em] text-[12px] leading-relaxed text-trace">
          À envoyer à vos collègues seulement (Slack, mail interne), jamais en public : quiconque l'a peut demander à entrer. Rien ne s'ouvre sans votre accord.
        </p>
        {err && <ErrorText className="mt-2">{err}</ErrorText>}
      </div>

      <section aria-label="Demandes en attente">
        <h3 className="text-[14px] font-medium">
          Demandes en attente{requests && requests.length > 0 && <span className="ml-1.5 tabular-nums text-trace">{requests.length}</span>}
        </h3>
        {requests === null ? (
          <p className="mt-2 text-[13px] text-trace">Chargement…</p>
        ) : requests.length === 0 ? (
          <p className="mt-2 text-[13px] text-trace">Aucune pour l'instant. Elles apparaissent ici dès qu'un collègue lance le message.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {requests.map((r) => (
              <RequestCard
                key={r.id}
                request={r}
                zones={props.zones}
                people={props.people}
                defaultManager={props.defaultManager ?? null}
                onDone={(accepted) => {
                  setRequests((list) => list?.filter((x) => x.id !== r.id) ?? null)
                  if (accepted) props.onAccepted?.(accepted)
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Une demande : ce que le Claude du demandeur a prérempli, à vérifier ou compléter, puis accepter ou refuser. */
function RequestCard(props: { request: JoinRequest; zones: ZoneLite[]; people?: Person[]; defaultManager: string | null; onDone: (accepted: Accepted | null) => void }) {
  const r = props.request
  const [name, setName] = useState(r.name ?? "")
  const [title, setTitle] = useState(r.title ?? "")
  const [email, setEmail] = useState(r.email ?? "")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [zones, setZones] = useState<string[]>([])
  const [manager, setManager] = useState<string>(props.defaultManager ?? "")
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function decide(action: "accept" | "reject") {
    if (action === "reject" && !confirm(`Refuser la demande${r.name ? ` de ${r.name}` : ""} ? Rien ne sera installé sur son poste.`)) return
    setBusy(action)
    setErr(null)
    try {
      const body =
        action === "accept"
          ? { action, name: name.trim(), title: title.trim() || undefined, email: email.trim(), role, zones: role === "admin" ? [] : zones, manager_id: manager || null }
          : { action }
      const out = await api<{ profile?: { id: string; name: string } }>(`/api/admin/join/${r.id}`, { method: "POST", json: body })
      props.onDone(out.profile ? { id: out.profile.id, name: out.profile.name, title: title.trim() || undefined, zones } : null)
    } catch (e) {
      setErr(errorMessage(e))
      setBusy(null)
    }
  }

  const missing = [!r.name && "nom", !r.title && "poste", !r.email && "email"].filter(Boolean) as string[]

  return (
    <li className="panel bubble-in px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-line-strong bg-surface text-[12px] font-medium">
          {r.name ? initials(r.name) : "?"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{r.name ?? "Nom inconnu"}</p>
          <p className="text-[12px] text-trace">
            {[r.title, r.email, r.hostname && `poste ${r.hostname}`].filter(Boolean).join(", ") || "Rien de prérempli"}
            {", "}
            <RelTime iso={r.created_at} now={Date.now()} />
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <input className="input" value={name} maxLength={80} aria-label="Nom" placeholder="Prénom Nom (à compléter)" onChange={(e) => setName(e.target.value)} />
        <input className="input" value={title} maxLength={80} aria-label="Poste" placeholder="Poste (à compléter)" onChange={(e) => setTitle(e.target.value)} />
        <input className="input" value={email} maxLength={200} aria-label="Email" placeholder="Email (facultatif)" onChange={(e) => setEmail(e.target.value)} />
      </div>
      {missing.length > 0 && <p className="mt-1.5 text-[12px] text-trace">Son Claude ne connaissait pas : {missing.join(", ")}.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label="Rôle" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Membre</option>
          <option value="admin">Admin (lit tout)</option>
        </select>
        {props.people && props.people.length > 0 && (
          <select className="input w-auto max-w-[220px]" aria-label="Rattachement" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">Sans rattachement</option>
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                Rattaché à {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {role === "member" && (
        <div className="mt-3">
          <p className="text-[12px] text-trace">Zones qu'il ou elle peut lire</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {props.zones.map((z) => {
              const on = zones.includes(z.id)
              return (
                <button
                  key={z.id}
                  type="button"
                  className={`chip h-7 text-[13px] ${on ? "chip-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setZones((list) => (on ? list.filter((x) => x !== z.id) : [...list, z.id]))}
                >
                  <Dot color={zoneColor(z.color, z.position)} />
                  {z.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={() => decide("accept")} disabled={busy !== null || !name.trim()}>
          {busy === "accept" ? "Acceptation…" : "Accepter"}
        </button>
        <button type="button" className="btn" onClick={() => decide("reject")} disabled={busy !== null}>
          {busy === "reject" ? "Refus…" : "Refuser"}
        </button>
        {!name.trim() && <span className="text-[12px] text-trace">Indiquez au moins son nom pour accepter.</span>}
        {err && <ErrorText>{err}</ErrorText>}
      </div>
    </li>
  )
}

/** Nombre de demandes en attente, relu régulièrement (barre latérale, onglet « Demandes ») ; 0 hors admin. */
export function usePendingJoins(enabled: boolean, everyMs = 15_000): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const tick = async () => {
      try {
        const r = await api<{ pending: number }>("/api/admin/join?count=1")
        if (!stop) setN(r.pending)
      } catch {}
    }
    void tick()
    const id = setInterval(tick, everyMs)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [enabled, everyMs])
  return n
}
