"use client"

import { useEffect, useState } from "react"
import type { ConnectorId, ConnectorPublic, McpConnectorPublic } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { fmt } from "@/lib/i18n"
import { PageScroll } from "./AppShell"
import { useBrainLive } from "./BrainLive"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { McpConnectors } from "./McpConnectors"
import { RelTime } from "./RelTime"
import { Dot, ErrorText, zoneColor } from "./ui"

type Props = { initial: ConnectorPublic[]; mcp: McpConnectorPublic[]; redirectUri: string }

export function ConnectorsPanel({ initial, mcp, redirectUri }: Props) {
  const { t } = useT()
  const { state, refresh } = useBrainLive()
  const [connectors, setConnectors] = useState(initial)
  const zones = state.zones.filter((z) => !z.locked)

  function update(next: ConnectorPublic) {
    setConnectors((prev) => prev.map((c) => (c.id === next.id ? next : c)))
  }

  return (
    <PageScroll>
      <div className="space-y-4">
        <div>
          <h1 className="text-[22px] font-medium leading-tight">{t.connectors.title}</h1>
        </div>
        <McpConnectors initial={mcp} redirectUri={redirectUri} />
        <div className="pt-4">
          <h2 className="text-[18px] font-medium leading-tight">{t.connectors.apiTitle}</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-trace">{t.connectors.lead}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} zones={zones} onChange={update} onSynced={refresh} />
          ))}
        </div>
      </div>
    </PageScroll>
  )
}

function ConnectorCard({ connector: c, zones, onChange, onSynced }: { connector: ConnectorPublic; zones: ZoneView[]; onChange: (c: ConnectorPublic) => void; onSynced: () => void }) {
  const { t } = useT()
  const k = t.connectors
  const [token, setToken] = useState("")
  const [url, setUrl] = useState(c.url ?? "")
  const [zone, setZone] = useState(c.zone ?? "")
  const [enabled, setEnabled] = useState(c.enabled || !c.configured)
  const [busy, setBusy] = useState<"save" | "sync" | "remove" | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const isCalendar = c.id === "calendar"
  useEffect(() => {
    setUrl(c.url ?? "")
    setZone(c.zone ?? "")
  }, [c.url, c.zone])

  async function save() {
    setBusy("save")
    setErr(null)
    setMsg(null)
    try {
      const next = await api<ConnectorPublic>(`/api/connectors/${c.id}`, { method: "PUT", json: { token: token || undefined, url: isCalendar ? url : undefined, zone: zone || null, enabled } })
      onChange(next)
      setToken("")
      setMsg(k.stateSaved)
    } catch (e) {
      setErr(fmt(k.saveError, { error: errorMessage(e) }))
    } finally {
      setBusy(null)
    }
  }

  async function sync() {
    setBusy("sync")
    setErr(null)
    setMsg(null)
    try {
      const run = await api<{ ok: boolean; imported: number; error?: string; at: string }>(`/api/connectors/${c.id}/sync`, { method: "POST" })
      onChange({ ...c, last_run: run })
      if (run.ok) {
        setMsg(fmt(k.imported, { n: run.imported }))
        onSynced()
      } else setErr(fmt(k.runFailed, { error: run.error ?? "?" }))
    } catch (e) {
      setErr(fmt(k.syncError, { error: errorMessage(e) }))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setBusy("remove")
    setErr(null)
    try {
      await api(`/api/connectors/${c.id}`, { method: "DELETE" })
      onChange({ id: c.id, configured: false, enabled: false, has_token: false })
      setToken("")
      setUrl("")
      setZone("")
      setEnabled(true)
    } catch (e) {
      setErr(fmt(k.saveError, { error: errorMessage(e) }))
    } finally {
      setBusy(null)
    }
  }

  const name = k.names[c.id as ConnectorId]
  const fieldId = `${c.id}-secret`
  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-busy={busy !== null}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="panel-title">{name}</h2>
        <span className="chip">{c.configured ? (c.enabled ? k.enabled : k.disabled) : k.notConfigured}</span>
      </div>
      <p className="text-[12px] text-trace">{k.help[c.id as ConnectorId]}</p>
      <label className="block text-[13px] font-medium" htmlFor={fieldId}>
        {isCalendar ? k.url : k.token}
      </label>
      {isCalendar ? (
        <input id={fieldId} className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autoComplete="off" />
      ) : (
        <>
          <input id={fieldId} className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c.has_token ? "••••••••" : ""} autoComplete="off" />
          {c.has_token && <p className="-mt-1 text-[12px] text-trace">{k.tokenKeep}</p>}
        </>
      )}
      <label className="block text-[13px] font-medium" htmlFor={`${c.id}-zone`}>
        {k.zone}
      </label>
      <select id={`${c.id}-zone`} className="input input-sm !w-full" value={zone} onChange={(e) => setZone(e.target.value)}>
        <option value="">{k.zoneAuto}</option>
        {zones.map((z) => (
          <option key={z.id} value={z.id}>
            {z.name}
          </option>
        ))}
      </select>
      {zone && zones.find((z) => z.id === zone) && (
        <span className="-mt-1 inline-flex items-center gap-1.5 text-[12px] text-trace">
          <Dot color={zoneColor(zones.find((z) => z.id === zone)!.color, zones.find((z) => z.id === zone)!.position)} />
          {zones.find((z) => z.id === zone)!.name}
        </span>
      )}
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" className="size-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {k.enabled}
      </label>
      {err && <ErrorText>{err}</ErrorText>}
      {msg && <p className="text-[12px] text-trace">{msg}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy !== null || (!isCalendar && !token && !c.has_token) || (isCalendar && !url)}>
          {busy === "save" ? t.common.saving : t.common.save}
        </button>
        <button type="button" className="btn btn-sm" onClick={sync} disabled={busy !== null || !c.configured}>
          {busy === "sync" ? k.syncing : k.syncNow}
        </button>
        {c.configured && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={remove} disabled={busy !== null}>
            {k.remove}
          </button>
        )}
        <span className="ml-auto text-[12px] text-trace">
          {c.last_run ? (
            <>
              {k.lastRun} : <RelTime iso={c.last_run.at} />
              {c.last_run.ok ? ` (${fmt(k.imported, { n: c.last_run.imported })})` : ` (${fmt(k.runFailed, { error: c.last_run.error ?? "?" })})`}
            </>
          ) : (
            k.neverRun
          )}
        </span>
      </div>
    </section>
  )
}
