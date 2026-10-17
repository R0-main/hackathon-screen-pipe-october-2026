"use client"

import Link from "next/link"
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react"
import type { KnowledgeItem, KnowledgeKind } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { fmt, intlLocale, plural, type Locale } from "@/lib/i18n"
import { DISPLAY_TIMEZONE, entityHref, firstName } from "./format"
import { useT } from "./I18n"
import { PersonDot, type PersonLook } from "./PersonDot"
import { RelTime } from "./RelTime"
import { CloseIcon, Dot, SearchIcon, ZoneBead, ZoneTag, zoneColor } from "./ui"

type ZoneLike = { name: string; color: string; position?: number }

/** `unreadableNote`: the item's zone is not readable by the viewer (their own item); text of the badge's tooltip. */
export function KnowledgeCard({
  item,
  author,
  zone,
  now,
  unreadableNote,
}: {
  item: KnowledgeItem
  author?: string
  zone?: ZoneView | ZoneLike
  now?: number
  unreadableNote?: string
}) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-[6px] border border-line bg-surface p-3.5 transition-colors hover:border-line-strong">
      <button type="button" className="w-full rounded-[4px] text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="chip">{t.kinds[item.kind]}</span>
          {zone && (
            <span className="chip">
              <ZoneTag name={zone.name} color={zoneColor(zone.color, zone.position ?? 0)} />
            </span>
          )}
          {unreadableNote && (
            <span className="chip text-trace" title={unreadableNote}>
              {t.common.zoneUnreadable}
            </span>
          )}
          {item.superseded_by && (
            <span className="chip text-trace" title={t.knowledge.supersededHint}>
              {t.knowledge.superseded}
            </span>
          )}
          <span className="ml-auto text-trace">
            {author ? `${firstName(author)}, ` : ""}
            <RelTime iso={item.created_at} now={now} className="tabular-nums" />
          </span>
        </div>
        <h4 className={`mt-2 break-words text-[13.5px] font-medium leading-snug ${item.superseded_by ? "text-trace" : ""}`}>{item.title}</h4>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-line text-[13px] leading-relaxed">{item.body}</p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {item.entities.map((e, i) => (
              <Link key={`${e.type}:${e.name}:${i}`} href={entityHref(e.type, e.name)} className="chip hover:border-line-strong" title={fmt(t.knowledge.entityHint, { name: e.name })}>
                {e.name}
              </Link>
            ))}
            <span className="chip text-trace">
              {fmt(t.knowledge.source, { tool: item.source.tool })}
              {item.source.app ? ` (${item.source.app})` : ""}
            </span>
            <span className="chip tabular-nums text-trace">{fmt(t.knowledge.confidence, { pct: Math.round(item.confidence * 100) })}</span>
          </div>
        </div>
      )}
    </article>
  )
}

export type KnowledgeFilters = { zone?: string; kind?: string; q?: string }

/**
 * Knowledge page: everything the brain kept in the readable zones, as a chronological thread, one day after the
 * other. Search, zone and type combine and are written in the address (?q=, ?zone=, ?type=): the "Where the company
 * stands" page links there for a zone. A row unfolds in place.
 */
export function KnowledgeList({
  items,
  names,
  zones,
  looks,
  now,
  initial,
  limit,
}: {
  items: KnowledgeItem[]
  names: Record<string, string>
  zones: ZoneView[]
  looks: Map<string, PersonLook>
  now: number
  initial?: KnowledgeFilters
  limit?: number
}) {
  const { t, locale } = useT()
  const readable = zones.filter((z) => !z.locked)
  const kinds = Object.keys(t.kinds) as KnowledgeKind[]
  const [zone, setZone] = useState(() => (initial?.zone && readable.some((z) => z.id === initial.zone) ? initial.zone : "all"))
  const [kind, setKind] = useState(() => (initial?.kind && (kinds as string[]).includes(initial.kind) ? initial.kind : "all"))
  const [q, setQ] = useState(initial?.q ?? "")
  const query = useDeferredValue(q)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones])
  // Searchable text of each knowledge item, without accents or capitals: title, content, entities, author, zone, app.
  const haystacks = useMemo(
    () =>
      new Map(
        items.map((i) => [
          i.id,
          fold([i.title, i.body, names[i.author_id] ?? "", zoneById.get(i.zone)?.name ?? "", i.source.app, ...i.entities.map((e) => e.name)].join(" ")),
        ]),
      ),
    [items, names, zoneById],
  )
  const matched = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean)
    return terms.length === 0 ? items : items.filter((i) => terms.every((term) => haystacks.get(i.id)?.includes(term)))
  }, [items, haystacks, query])

  // Each row of filters counts what its choice would give, given the other filters.
  const zoneCounts = useMemo(() => countBy(matched.filter((i) => kind === "all" || i.kind === kind), (i) => i.zone), [matched, kind])
  const kindCounts = useMemo(() => countBy(matched.filter((i) => zone === "all" || i.zone === zone), (i) => i.kind), [matched, zone])
  const presentKinds = useMemo(() => kinds.filter((k) => items.some((i) => i.kind === k)), [kinds, items])
  const shown = useMemo(() => matched.filter((i) => (zone === "all" || i.zone === zone) && (kind === "all" || i.kind === kind)), [matched, zone, kind])
  const days = useMemo(() => groupByDay(shown), [shown])

  // The address follows the filters, without a new history entry.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const set = (key: string, value: string | null) => (value ? params.set(key, value) : params.delete(key))
    set("zone", zone === "all" ? null : zone)
    set("type", kind === "all" ? null : kind)
    set("q", query.trim() || null)
    const search = params.toString()
    if (search !== window.location.search.replace(/^\?/, "")) window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`)
  }, [zone, kind, query])

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const filtered = zone !== "all" || kind !== "all" || query.trim() !== ""
  const clear = () => {
    setZone("all")
    setKind("all")
    setQ("")
  }
  const today = dayKey(new Date(now).toISOString())
  const yesterday = dayKey(new Date(now - 86400_000).toISOString())

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[22px] font-medium leading-tight">{t.knowledge.title}</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] text-trace">{t.knowledge.lead}</p>
        </div>
        <p className="text-[13px] tabular-nums text-trace" aria-live="polite">
          {filtered
            ? fmt(t.knowledge.countFiltered, { n: shown.length, total: items.length })
            : plural(items.length, t.knowledge.count, t.knowledge.countPlural)}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="mt-8 max-w-[60ch] text-[14px] text-trace">{t.knowledge.empty}</p>
      ) : (
        <>
          {/* Filter bar: stays at the top of the column while browsing the thread. */}
          <div className="sticky top-0 z-10 -mx-4 mt-5 space-y-3 border-b border-line bg-bone px-4 py-3 sm:-mx-8 sm:px-8">
            <div className="relative max-w-xl">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-trace" />
              <input
                type="search"
                className="input !pl-9 !pr-10"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && q) {
                    e.preventDefault()
                    setQ("")
                  }
                }}
                placeholder={t.knowledge.searchPlaceholder}
                aria-label={t.knowledge.search}
                autoComplete="off"
                spellCheck={false}
              />
              {q && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[4px] text-trace transition-colors duration-150 ease-out hover:bg-bone hover:text-ink"
                  aria-label={t.knowledge.clearSearch}
                  onClick={() => setQ("")}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
            <ChipRow label={t.knowledge.filterByZone}>
              <FilterChip on={zone === "all"} onClick={() => setZone("all")}>
                {t.common.all}
              </FilterChip>
              {readable.map((z) => (
                <FilterChip key={z.id} on={zone === z.id} onClick={() => setZone(z.id)} count={zoneCounts.get(z.id) ?? 0}>
                  <Dot color={zoneColor(z.color, z.position)} />
                  {z.name}
                </FilterChip>
              ))}
            </ChipRow>
            {presentKinds.length > 1 && (
              <ChipRow label={t.knowledge.filterByKind}>
                <FilterChip on={kind === "all"} onClick={() => setKind("all")}>
                  {t.knowledge.allKinds}
                </FilterChip>
                {presentKinds.map((k) => (
                  <FilterChip key={k} on={kind === k} onClick={() => setKind(k)} count={kindCounts.get(k) ?? 0}>
                    {t.kindsPlural[k]}
                  </FilterChip>
                ))}
              </ChipRow>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="mt-8">
              <p className="text-[14px] text-trace">{t.knowledge.noMatch}</p>
              <button type="button" className="btn mt-3" onClick={clear}>
                {t.knowledge.clearFilters}
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-7">
              {days.map((d) => (
                <section key={d.key} aria-labelledby={`day-${d.key}`}>
                  <h2 id={`day-${d.key}`} className="pl-[35px] text-[13px] font-medium" suppressHydrationWarning>
                    {d.key === today ? t.knowledge.today : d.key === yesterday ? t.knowledge.yesterday : dayLabel(d.key, today, locale)}
                  </h2>
                  <ol className="mt-1">
                    {d.items.map((i, n) => (
                      <KnowledgeRow
                        key={i.id}
                        item={i}
                        zone={zoneById.get(i.zone)}
                        author={names[i.author_id]}
                        look={looks.get(i.author_id)}
                        open={open.has(i.id)}
                        onToggle={toggle}
                        first={n === 0}
                        last={n === d.items.length - 1}
                        locale={locale}
                      />
                    ))}
                  </ol>
                </section>
              ))}
              {limit !== undefined && items.length >= limit && <p className="pl-[35px] text-[12px] text-trace">{fmt(t.knowledge.limited, { n: limit })}</p>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * A knowledge item of the thread: its bead (its zone's color) on the day's thread, the title, the type and the zone, the
 * author and the time. Unfolded, it becomes a panel: the content, the entities mentioned, the source and the confidence.
 * Memoized: the layout's clock (400 ms) does not redraw it.
 */
const KnowledgeRow = memo(function KnowledgeRow({
  item,
  zone,
  author,
  look,
  open,
  onToggle,
  first,
  last,
  locale,
}: {
  item: KnowledgeItem
  zone?: ZoneView
  author?: string
  look?: PersonLook
  open: boolean
  onToggle: (id: string) => void
  first: boolean
  last: boolean
  locale: Locale
}) {
  const { t } = useT()
  const panel = `knowledge-${item.id}`
  return (
    <li className="flex gap-3">
      {/* The day's thread: it links the beads, from the first to the last knowledge item. */}
      <div aria-hidden className="relative w-[11px] shrink-0">
        {!first && <span className="absolute left-[5px] top-0 h-[17px] w-px bg-line-strong" />}
        <ZoneBead color={zone ? zoneColor(zone.color, zone.position) : "var(--color-line-strong)"} className="absolute left-0 top-[17px]" />
        {!last && <span className="absolute bottom-0 left-[5px] top-[28px] w-px bg-line-strong" />}
      </div>
      <div className={`mb-1 min-w-0 flex-1 rounded-[8px] border ${open ? "border-line bg-surface" : "border-transparent"}`}>
        <button
          type="button"
          onClick={() => onToggle(item.id)}
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-[7px] px-3 py-3 text-left transition-colors duration-150 ease-out ${
            open ? "" : "hover:bg-surface"
          }`}
        >
          <span className="min-w-0">
            <span className="block text-[14px] font-medium leading-snug [overflow-wrap:anywhere]">{item.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
              <span>{t.kinds[item.kind]}</span>
              {zone && <span className="text-trace">{zone.name}</span>}
            </span>
          </span>
          <span className="flex items-center gap-2 text-[12px] text-trace">
            <PersonDot id={item.author_id} color={look?.color} look={look?.look} size={22} bg="surface" />
            {author && <span className="hidden sm:inline">{firstName(author)}</span>}
            <time dateTime={item.created_at} className="w-[38px] text-right tabular-nums" suppressHydrationWarning>
              {clock(item.created_at, locale)}
            </time>
          </span>
        </button>
        {open && (
          <div id={panel} className="bubble-in px-3 pb-4">
            <p className="max-w-[68ch] whitespace-pre-line text-[14px] leading-relaxed [overflow-wrap:anywhere]">{item.body}</p>
            {item.entities.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
                {item.entities.map((e, n) => (
                  <li key={`${e.type}:${e.name}:${n}`}>
                    <Link href={entityHref(e.type, e.name)} className="chip hover:border-line-strong" title={fmt(t.knowledge.entityHint, { name: e.name })}>
                      {e.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-trace">
              {author && (
                <span>
                  {fmt(t.knowledge.by, { name: author })}, <RelTime iso={item.created_at} />
                </span>
              )}
              <span>
                {fmt(t.knowledge.source, { tool: item.source.tool })}
                {item.source.app ? ` (${item.source.app})` : ""}
              </span>
              <span className="tabular-nums">{fmt(t.knowledge.confidence, { pct: Math.round(item.confidence * 100) })}</span>
            </p>
          </div>
        )}
      </div>
    </li>
  )
})

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Small screen: a row that scrolls; beyond that, it wraps.
    <div className="scroll-thin -mx-4 overflow-x-auto px-4 sm:mx-0 sm:overflow-visible sm:px-0">
      <div className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

function FilterChip({ on, onClick, count, children }: { on: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <button type="button" className={`chip ${on ? "chip-on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
      {count !== undefined && <span className={`tabular-nums ${on ? "text-line-strong" : "text-trace"}`}>{count}</span>}
    </button>
  )
}

function countBy<T>(list: T[], key: (x: T) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const x of list) out.set(key(x), (out.get(key(x)) ?? 0) + 1)
  return out
}

/** Lowercase without accents: "Café" is found by typing "cafe". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
}

/** Day (YYYY-MM-DD) in the company's time zone: the server and the browser group the same way. */
function dayKey(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("en-CA", { timeZone: DISPLAY_TIMEZONE })
}

function groupByDay(items: KnowledgeItem[]): { key: string; items: KnowledgeItem[] }[] {
  const out: { key: string; items: KnowledgeItem[] }[] = []
  for (const i of items) {
    const key = dayKey(i.created_at)
    const last = out[out.length - 1]
    if (last?.key === key) last.items.push(i)
    else out.push({ key, items: [i] })
  }
  return out
}

/** "Wednesday, 15 October"; the year only if it is not the current one. */
function dayLabel(key: string, today: string, locale: Locale): string {
  if (!key) return "—"
  const date = new Date(`${key}T12:00:00Z`)
  const label = date.toLocaleDateString(intlLocale(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function clock(iso: string, locale: Locale): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TIMEZONE })
}
