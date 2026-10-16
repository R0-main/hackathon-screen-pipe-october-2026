"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import type { DashboardState, ZoneView } from "@/lib/brain"
import { KnowledgeCard } from "./KnowledgeList"
import { api, firstName } from "./format"

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
      <form onSubmit={submit} className="flex gap-2">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Interroger le cerveau en tant que ${firstName(me.name)}… ex. « comment on déploie ? », « où en est La Mie Dorée ? »`}
          aria-label="Question au cerveau"
        />
        <button className="btn btn-primary shrink-0" disabled={busy}>
          {busy ? "…" : "Demander"}
        </button>
      </form>
      {err && <p className="mt-2 text-sm text-red-300">{err}</p>}
      {res && (
        <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[rgba(2,6,23,0.45)] p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span>
              {res.items.length} résultat{res.items.length > 1 ? "s" : ""} pour « {res.query} » dans {res.zones_searched.length} zone
              {res.zones_searched.length > 1 ? "s accessibles" : " accessible"}
            </span>
            <button className="ml-auto text-[var(--faint)] hover:text-[var(--text)]" onClick={() => setRes(null)}>
              fermer
            </button>
          </div>
          {res.zones_restricted.length > 0 && (
            <p className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              🔒 {res.zones_restricted.length > 1 ? "Les zones" : "La zone"} {res.zones_restricted.map(zoneName).join(" et ")}{" "}
              {res.zones_restricted.length > 1 ? "pourraient" : "pourrait"} en savoir plus, mais {firstName(me.name)} n&apos;y a pas accès :{" "}
              {res.zones_restricted.length > 1 ? "leur" : "son"} contenu reste invisible, y compris pour ses agents.
            </p>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {res.items.map((i) => (
              <KnowledgeCard key={i.id} item={i} author={i.author} zone={zones.find((z) => z.id === i.zone)} />
            ))}
          </div>
          {res.items.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">Rien trouvé dans les zones accessibles.</p>}
        </div>
      )}
    </div>
  )
}
