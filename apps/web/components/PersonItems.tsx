"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api } from "./format"

export function PersonItems({ items, zones, canDelete }: { items: KnowledgeItem[]; zones: { id: string; name: string; color: string; position?: number }[]; canDelete: boolean }) {
  const [list, setList] = useState(items)
  async function remove(id: string) {
    if (!confirm("Supprimer définitivement cette connaissance du cerveau ?")) return
    await api(`/api/items/${id}`, { method: "DELETE" })
    setList((l) => l.filter((i) => i.id !== id))
  }
  return (
    <section className="panel p-5">
      <h2 className="panel-title">
        Connaissances issues de ce poste (<span className="tabular-nums">{list.length}</span>)
      </h2>
      <div className="mt-3 grid gap-2.5 md:grid-cols-2">
        {list.map((i) => (
          <div key={i.id}>
            <KnowledgeCard item={i} zone={zones.find((z) => z.id === i.zone)} />
            {canDelete && (
              <div className="mt-1 pr-2 text-right">
                <button type="button" className="text-[12px] text-trace underline underline-offset-2 hover:text-danger" onClick={() => remove(i.id)}>
                  Supprimer du cerveau
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
