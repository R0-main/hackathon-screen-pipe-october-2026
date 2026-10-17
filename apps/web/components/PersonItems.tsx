"use client"

import { useState } from "react"
import type { KnowledgeItem } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api, errorMessage, firstName } from "./format"
import { ErrorText } from "./ui"

/**
 * Knowledge coming from a workstation. `unreadableZones` (getPersonContext): zones of the person's own items that they
 * don't read. Those items stay listed (right of review: read again, delete) with a "zone not readable" badge.
 * `personName`: absent when the person looks at their own context (texts in the 2nd person).
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
    ? `${who} doesn't read this zone: this item stays visible here because it comes from this workstation.`
    : "You don't read this zone: this item stays visible here because it comes from your workstation."
  const many = hidden.length > 1
  const notice =
    hidden.length === 0
      ? null
      : `${many ? `${hidden.length} items are filed` : "1 item is filed"} ${
          new Set(hidden.map((i) => i.zone)).size > 1 ? "in zones" : "in a zone"
        } that ${who ? `${who} doesn't` : "you don't"} read ("zone not readable" badge): ${many ? "they stay" : "it stays"} visible here because ${
          many ? "they come" : "it comes"
        } from ${who ? "this" : "your"} workstation${canDelete ? ` and can be deleted` : ""}.`

  async function remove(id: string) {
    if (!confirm("Permanently delete this item from the brain?")) return
    setPending(id)
    setErr(null)
    try {
      await api(`/api/items/${id}`, { method: "DELETE" })
      setList((l) => l.filter((i) => i.id !== id))
    } catch (e) {
      setErr(`Could not delete: ${errorMessage(e)}`)
    } finally {
      setPending(null)
    }
  }
  return (
    <section className="panel p-5">
      <h2 className="panel-title">
        Knowledge from this workstation (<span className="tabular-nums">{list.length}</span>)
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
                  {pending === i.id ? "Deleting" : "Delete from the brain"}
                </button>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && <p className="text-[13px] text-trace">No visible knowledge.</p>}
      </div>
    </section>
  )
}
