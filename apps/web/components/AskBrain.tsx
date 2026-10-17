"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import type { DashboardState, ZoneView } from "@/lib/brain"
import { KnowledgeCard } from "./KnowledgeList"
import { api, firstName } from "./format"
import { ErrorText, LockIcon } from "./ui"

type QueryResult = {
  query: string
  zones_searched: string[]
  zones_hit: string[]
  zones_restricted: string[]
  items: (KnowledgeItem & { author: string; score: number })[]
}

/** Query the brain the way an agent would (same API as the MCP), with the permissions of the user shown. */
export function AskBrain({ me, zones }: { me: DashboardState["me"]; zones: ZoneView[] }) {
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<QueryResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    setErr(null)
    try {
      setRes(await api<QueryResult>("/api/query", { method: "POST", json: { query: q.trim(), agent: "dashboard", limit: 6 } }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2" aria-busy={busy}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Ask the brain as ${firstName(me.name)}, for example: how do we deploy?`}
          aria-label="Question for the brain"
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={busy}>
          {busy ? "Searching" : "Ask"}
        </button>
      </form>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      {res && (
        <div className="inset scroll-thin mt-3 max-h-[min(60dvh,560px)] overflow-y-auto p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-trace">
            <span>
              <span className="tabular-nums">{res.items.length}</span> result{res.items.length === 1 ? "" : "s"} for “{res.query}” in{" "}
              <span className="tabular-nums">{res.zones_searched.length}</span> accessible zone
              {res.zones_searched.length === 1 ? "" : "s"}
            </span>
            <button type="button" className="ml-auto underline underline-offset-2 hover:text-ink" onClick={() => setRes(null)}>
              Close
            </button>
          </div>
          {res.zones_restricted.length > 0 && (
            <p className="mt-2 flex gap-2 rounded-[6px] border border-line bg-surface px-3 py-2 text-[12px]">
              <LockIcon className="mt-0.5 shrink-0" size={14} />
              <span>
                {res.zones_restricted.length > 1 ? "The zones" : "The zone"} {res.zones_restricted.map(zoneName).join(" and ")}{" "}
                might know more, but {firstName(me.name)} has no access:{" "}
                {res.zones_restricted.length > 1 ? "their" : "its"} content stays invisible, including to their agents.
              </span>
            </p>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {res.items.map((i) => (
              <KnowledgeCard key={i.id} item={i} author={i.author} zone={zones.find((z) => z.id === i.zone)} />
            ))}
          </div>
          {res.items.length === 0 && <p className="mt-2 text-[13px] text-trace">Nothing found in the accessible zones.</p>}
        </div>
      )}
    </div>
  )
}
