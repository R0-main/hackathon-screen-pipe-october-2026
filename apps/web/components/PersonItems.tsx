"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api, errorMessage } from "./format"

export function PersonItems({
  items,
  zones,
  canDelete,
  now,
}: {
  items: KnowledgeItem[]
  zones: { id: string; name: string; color: string }[]
  canDelete: boolean
  now?: number
}) {
  const [list, setList] = useState(items)
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function remove(id: string) {
    if (!confirm("Supprimer définitivement cette connaissance du cerveau ?")) return
    setPending(id)
    setErr(null)
    try {
      await api(`/api/items/${id}`, { method: "DELETE" })
      setList((l) => l.filter((i) => i.id !== id))
    } catch (e) {
      setErr(`Suppression impossible : ${errorMessage(e)}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="panel p-5">
      <div className="panel-title">Connaissances issues de ce poste ({list.length})</div>
      {err && (
        <p role="alert" className="mt-2 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {err}
        </p>
      )}
      <div className="mt-3 grid gap-2.5 md:grid-cols-2">
        {list.map((i) => (
          <div key={i.id} className="min-w-0">
            <KnowledgeCard item={i} zone={zones.find((z) => z.id === i.zone)} now={now} />
            {canDelete && (
              <div className="mt-1 pr-2 text-right">
                <button className="text-[11px] text-[var(--faint)] hover:text-red-300 disabled:opacity-50" onClick={() => remove(i.id)} disabled={pending === i.id}>
                  {pending === i.id ? "suppression…" : "supprimer du cerveau"}
                </button>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-[var(--muted)]">Aucune connaissance visible.</p>}
      </div>
    </section>
  )
}
