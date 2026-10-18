"use client"

import { useCallback, useEffect, useState } from "react"
import { isCoreZone } from "@brain/core"
import { AgentLogos } from "./brand-logos"
import { PersonDot } from "./PersonDot"
import { copyText } from "./PromptActions"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { CheckIcon, Dot, ErrorText, zoneColor } from "./ui"
import { possessive } from "@/lib/install-prompt"

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
 * The second way to add someone: a single message for the whole team. Each person pastes it into Claude Code or Codex, which
 * sends a pre-filled request; an admin completes it (role, zones, manager) and accepts it, and the computer finishes
 * its install on its own. Pending requests are re-read regularly.
 */
export function TeamJoin(props: { orgName: string; zones: ZoneLite[]; people?: Person[]; defaultManager?: string | null; onAccepted?: (p: Accepted) => void; compact?: boolean }) {
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
      setErr(`Could not copy: ${errorMessage(e)}`)
    }
  }

  async function rotate() {
    if (!confirm("Change the code? The old message will stop working; requests already received stay.")) return
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
        {!props.compact && <h2 className="panel-title">One message for {possessive(props.orgName)} whole team</h2>}
        <p className={`${props.compact ? "" : "mt-1.5"} max-w-[40em] text-[14px] leading-relaxed text-trace`}>
          The same message for everyone: each person pastes it into Claude Code or Codex, which asks to join {props.orgName} with what it already knows about the person
          (name, role, email). You complete the request and accept it here, and their computer sets itself up.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn" onClick={copy} disabled={busy}>
            {copied ? (
              <>
                <CheckIcon size={14} /> Message copied
              </>
            ) : (
              <>
                <AgentLogos /> Copy the team message
              </>
            )}
          </button>
          <button type="button" className="text-[13px] text-trace hover:text-ink" onClick={rotate} disabled={busy}>
            Change the code
          </button>
        </div>
        <p className="mt-3 max-w-[40em] text-[12px] leading-relaxed text-trace">
          Send it to your colleagues only (Slack, internal email), never publicly: anyone who has it can ask to join. Nothing opens without your approval.
        </p>
        {err && <ErrorText className="mt-2">{err}</ErrorText>}
      </div>

      <section aria-label="Pending requests">
        <h3 className="text-[14px] font-medium">
          Pending requests{requests && requests.length > 0 && <span className="ml-1.5 tabular-nums text-trace">{requests.length}</span>}
        </h3>
        {requests === null ? (
          <p className="mt-2 text-[13px] text-trace">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="mt-2 text-[13px] text-trace">None yet. They show up here as soon as a colleague runs the message.</p>
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

/** A request: what the requester's Claude pre-filled, to check or complete, then accept or decline. */
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
    if (action === "reject" && !confirm(`Decline the request${r.name ? ` from ${r.name}` : ""}? Nothing will be installed on their computer.`)) return
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

  const missing = [!r.name && "name", !r.title && "role", !r.email && "email"].filter(Boolean) as string[]

  return (
    <li className="panel bubble-in px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <PersonDot id={r.id} size={36} bg="surface" dashed />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{r.name ?? "Unknown name"}</p>
          <p className="text-[12px] text-trace">
            {[r.title, r.email, r.hostname && `computer ${r.hostname}`].filter(Boolean).join(", ") || "Nothing pre-filled"}
            {", "}
            <RelTime iso={r.created_at} now={Date.now()} />
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <input className="input" value={name} maxLength={80} aria-label="Name" placeholder="First Last (to fill in)" onChange={(e) => setName(e.target.value)} />
        <input className="input" value={title} maxLength={80} aria-label="Role" placeholder="Role (to fill in)" onChange={(e) => setTitle(e.target.value)} />
        <input className="input" value={email} maxLength={200} aria-label="Email" placeholder="Email (optional)" onChange={(e) => setEmail(e.target.value)} />
      </div>
      {missing.length > 0 && <p className="mt-1.5 text-[12px] text-trace">Their agent didn't know: {missing.join(", ")}.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Member</option>
          <option value="admin">Admin (reads everything)</option>
        </select>
        {props.people && props.people.length > 0 && (
          <select className="input w-auto max-w-[220px]" aria-label="Manager" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">No manager</option>
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                Reports to {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {role === "member" && (
        <div className="mt-3">
          <p className="text-[12px] text-trace">Zones they can read</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {props.zones.map((z) => {
              const core = isCoreZone(z.id)
              const on = core || zones.includes(z.id)
              return (
                <button
                  key={z.id}
                  type="button"
                  className={`chip h-7 text-[13px] ${on ? "chip-on" : ""}`}
                  aria-pressed={on}
                  disabled={core}
                  title={core ? "Everyone reads the core." : undefined}
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
          {busy === "accept" ? "Accepting…" : "Accept"}
        </button>
        <button type="button" className="btn" onClick={() => decide("reject")} disabled={busy !== null}>
          {busy === "reject" ? "Declining…" : "Decline"}
        </button>
        {!name.trim() && <span className="text-[12px] text-trace">Enter at least their name to accept.</span>}
        {err && <ErrorText>{err}</ErrorText>}
      </div>
    </li>
  )
}

/** Number of pending requests, re-read regularly (sidebar, "Requests" sub-page); 0 for non-admins. */
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
