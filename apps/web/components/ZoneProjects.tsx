"use client"

import { useState } from "react"
import { isCoreZone, type Zone } from "@brain/core"
import { api, errorMessage } from "./format"
import { CheckIcon, ErrorText, ZoneTag, zoneColor } from "./ui"

/** "encore, acme/api" → ["encore", "acme/api"]: commas or new lines, without empty entries or duplicates. */
export function splitProjects(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean))]
}

/**
 * Projects per zone: the folders or git repositories whose Claude Code and Codex sessions always land in the zone,
 * whatever Claude would have chosen. A project per zone (one repository = one zone) or several (a team's repositories).
 */
export function ZoneProjects({ zones, reload }: { zones: Zone[]; reload: () => Promise<Zone[] | null> }) {
  const editable = zones.filter((z) => !isCoreZone(z.id))
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="panel-title">Projects</h2>
        <p className="text-[13px] text-trace">
          A Claude Code or Codex session opened in one of these projects always goes to its zone, on every computer. Enter a folder name (encore) or a git
          repository (acme/encore, or its URL), separated by commas. Takes effect on each computer at its next sync. A zone left empty (its
          knowledge moved with <code className="mono">brain rezone</code>) can be deleted.
        </p>
      </div>
      <ul className="divide-y divide-line">
        {editable.map((z) => (
          <ZoneProjectsRow key={z.id} zone={z} reload={reload} deletable={editable.length > 1} />
        ))}
      </ul>
    </section>
  )
}

function ZoneProjectsRow({ zone, reload, deletable }: { zone: Zone; reload: () => Promise<Zone[] | null>; deletable: boolean }) {
  const saved = (zone.projects ?? []).join(", ")
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const id = `zone-projects-${zone.id}`
  const changed = splitProjects(text).join(", ") !== saved

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(false)
    setBusy(true)
    try {
      const updated = await api<Zone>("/api/admin/zones", { method: "POST", json: { id: zone.id, name: zone.name, projects: splitProjects(text) } })
      setText((updated.projects ?? []).join(", "))
      setOk(true)
      await reload()
    } catch (e) {
      setErr(`Could not save the projects: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // Only an empty zone goes: the server refuses (409) while knowledge, tasks, documents or skills are filed in it.
  async function remove() {
    if (!confirm(`Delete the zone "${zone.name}"? Its access rights go with it. Only possible once nothing is filed in it.`)) return
    setErr(null)
    setOk(false)
    setBusy(true)
    try {
      await api(`/api/admin/zones?id=${encodeURIComponent(zone.id)}`, { method: "DELETE" })
      await reload()
    } catch (e) {
      setErr(`Could not delete the zone: ${errorMessage(e)}`)
      setBusy(false)
    }
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <form onSubmit={save} className="space-y-2" aria-busy={busy}>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className="block">
            <ZoneTag name={zone.name} color={zoneColor(zone.color, zone.position)} />
          </label>
          {deletable && (
            <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={remove} disabled={busy} aria-label={`Delete the zone ${zone.name}`}>
              Delete
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <input
            id={id}
            className="input mono min-w-0 flex-1"
            placeholder="No project yet"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setOk(false)
              setErr(null)
            }}
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-sm shrink-0" disabled={busy || !changed}>
            {busy ? "Saving" : "Save"}
          </button>
        </div>
        {err && <ErrorText>{err}</ErrorText>}
        {ok && !changed && (
          <p role="status" className="inline-flex items-center gap-1.5 text-[12px] text-trace">
            <CheckIcon size={13} /> Saved
          </p>
        )}
      </form>
    </li>
  )
}
