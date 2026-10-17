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

/** Interroger le cerveau comme le ferait un agent (même API que le MCP), avec les droits de l'utilisateur affiché. */
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
          placeholder={`Interroger le cerveau en tant que ${firstName(me.name)}, par exemple : comment on déploie ?`}
          aria-label="Question au cerveau"
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={busy}>
          {busy ? "Recherche" : "Interroger"}
        </button>
      </form>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      {res && (
        <div className="inset scroll-thin mt-3 max-h-[min(60dvh,560px)] overflow-y-auto p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-trace">
            <span>
              <span className="tabular-nums">{res.items.length}</span> résultat{res.items.length > 1 ? "s" : ""} pour « {res.query} » dans{" "}
              <span className="tabular-nums">{res.zones_searched.length}</span> zone
              {res.zones_searched.length > 1 ? "s accessibles" : " accessible"}
            </span>
            <button type="button" className="ml-auto underline underline-offset-2 hover:text-ink" onClick={() => setRes(null)}>
              Fermer
            </button>
          </div>
          {res.zones_restricted.length > 0 && (
            <p className="mt-2 flex gap-2 rounded-[6px] border border-line bg-surface px-3 py-2 text-[12px]">
              <LockIcon className="mt-0.5 shrink-0" size={14} />
              <span>
                {res.zones_restricted.length > 1 ? "Les zones" : "La zone"} {res.zones_restricted.map(zoneName).join(" et ")}{" "}
                {res.zones_restricted.length > 1 ? "pourraient" : "pourrait"} en savoir plus, mais {firstName(me.name)} n&apos;y a pas accès :{" "}
                {res.zones_restricted.length > 1 ? "leur" : "son"} contenu reste invisible, y compris pour ses agents.
              </span>
            </p>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {res.items.map((i) => (
              <KnowledgeCard key={i.id} item={i} author={i.author} zone={zones.find((z) => z.id === i.zone)} />
            ))}
          </div>
          {res.items.length === 0 && <p className="mt-2 text-[13px] text-trace">Rien trouvé dans les zones accessibles.</p>}
        </div>
      )}
    </div>
  )
}
