"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api, errorMessage } from "./format"
import { ErrorText } from "./ui"

export function PersonItems({
  items,
  zones,
  canDelete,
  now,
}: {
  items: KnowledgeItem[]
  zones: { id: string; name: string; color: string; position?: number }[]
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
      <h2 className="panel-title">
        Connaissances issues de ce poste (<span className="tabular-nums">{list.length}</span>)
      </h2>
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      <div className="mt-3 grid gap-2.5 md:grid-cols-2">
        {list.map((i) => (
          <div key={i.id} className="min-w-0">
            <KnowledgeCard item={i} zone={zones.find((z) => z.id === i.zone)} now={now} />
            {canDelete && (
              <div className="mt-1 pr-2 text-right">
                <button
                  type="button"
                  className="text-[12px] text-trace underline underline-offset-2 hover:text-danger disabled:no-underline"
                  onClick={() => remove(i.id)}
                  disabled={pending === i.id}
                >
                  {pending === i.id ? "Suppression en cours" : "Supprimer du cerveau"}
                </button>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && <p className="text-[13px] text-trace">Aucune connaissance visible.</p>}
      </div>
    </section>
  )
}
