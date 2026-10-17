"use client"

import { useState } from "react"
import type { KnowledgeItem, KnowledgeKind } from "@brain/core"
import { KnowledgeCard } from "./KnowledgeList"
import { api, errorMessage, firstName } from "./format"
import { useT } from "./I18n"
import { ErrorText } from "./ui"

/** Order of the type filters: what a handover needs first. */
const KIND_ORDER: KnowledgeKind[] = ["decision", "procedure", "fact", "task", "question"]

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
  const { t } = useT()
  const [list, setList] = useState(items)
  const [kind, setKind] = useState<KnowledgeKind | null>(null)
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
  const kinds = KIND_ORDER.map((k) => ({ kind: k, count: list.filter((i) => i.kind === k).length })).filter((k) => k.count > 0)
  const shown = kind ? list.filter((i) => i.kind === kind) : list

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
    <section className="panel min-w-0 p-5">
      <h2 className="panel-title">Knowledge from this workstation</h2>
      {notice && <p className="mt-2 text-[13px] leading-relaxed text-trace">{notice}</p>}
      {kinds.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
          <button type="button" className={`chip ${kind === null ? "chip-on" : ""}`} aria-pressed={kind === null} onClick={() => setKind(null)}>
            All <span className="tabular-nums opacity-60">{list.length}</span>
          </button>
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`chip ${kind === k.kind ? "chip-on" : ""}`}
              aria-pressed={kind === k.kind}
              onClick={() => setKind(kind === k.kind ? null : k.kind)}
            >
              {t.kindsPlural[k.kind]} <span className="tabular-nums opacity-60">{k.count}</span>
            </button>
          ))}
        </div>
      )}
      {err && <ErrorText className="mt-3">{err}</ErrorText>}
      <div className="mt-4 grid items-start gap-2.5 xl:grid-cols-2">
        {shown.map((i) => (
          <KnowledgeCard
            key={i.id}
            item={i}
            zone={zones.find((z) => z.id === i.zone)}
            now={now}
            unreadableNote={unreadable.has(i.zone) ? note : undefined}
            action={
              canDelete && (
                <button type="button" className="btn btn-sm hover:!border-danger hover:text-danger" onClick={() => remove(i.id)} disabled={pending === i.id}>
                  {pending === i.id ? "Deleting" : "Delete from the brain"}
                </button>
              )
            }
          />
        ))}
      </div>
      {list.length === 0 && (
        <p className="inset mt-4 px-4 py-6 text-center text-[13px] text-trace">
          {who ? `Nothing distilled from ${who}'s workstation yet.` : "Nothing distilled from your workstation yet."}
        </p>
      )}
    </section>
  )
}
