"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api, errorMessage, firstName } from "./format"
import { ErrorText } from "./ui"

/**
 * Connaissances issues d'un poste. `unreadableZones` (getPersonContext) : zones de ses propres items que la personne ne
 * lit pas. Ces items restent listés (droit de regard : relire, supprimer) avec un badge « zone non lisible ».
 * `personName` : absent quand la personne regarde son propre contexte (textes à la 2e personne).
 */
export function PersonItems({
  items,
  zones,
  canDelete,
  now,
  unreadableZones = [],
  personName,
}: {
  items: KnowledgeItem[]
  zones: { id: string; name: string; color: string; position?: number }[]
  canDelete: boolean
  now?: number
  unreadableZones?: string[]
  personName?: string
}) {
  const [list, setList] = useState(items)
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const unreadable = new Set(unreadableZones)
  const hidden = list.filter((i) => unreadable.has(i.zone))
  const who = personName ? firstName(personName) : null
  const note = who
    ? `${who} ne lit pas cette zone : cette connaissance reste visible ici parce qu'elle vient de ce poste.`
    : "Vous ne lisez pas cette zone : cette connaissance reste visible ici parce qu'elle vient de votre poste."
  const many = hidden.length > 1
  const notice =
    hidden.length === 0
      ? null
      : `${many ? `${hidden.length} connaissances sont rangées` : "1 connaissance est rangée"} ${
          new Set(hidden.map((i) => i.zone)).size > 1 ? "dans des zones" : "dans une zone"
        } que ${who ? `${who} ne lit` : "vous ne lisez"} pas (badge « zone non lisible ») : ${many ? "elles restent visibles" : "elle reste visible"} ici parce qu'${
          many ? "elles viennent" : "elle vient"
        } de ${who ? "ce" : "votre"} poste${canDelete ? ` et ${many ? "peuvent être supprimées" : "peut être supprimée"}` : ""}.`

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
      {notice && <p className="mt-2 text-[13px] leading-relaxed text-trace">{notice}</p>}
      {err && <ErrorText className="mt-2">{err}</ErrorText>}
      <div className="mt-3 grid gap-2.5 md:grid-cols-2">
        {list.map((i) => (
          <div key={i.id} className="min-w-0">
            <KnowledgeCard item={i} zone={zones.find((z) => z.id === i.zone)} now={now} unreadableNote={unreadable.has(i.zone) ? note : undefined} />
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
