"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Profile, Zone } from "@brain/core"
import { PersonAvatar } from "./PersonDot"
import { Dot, MinusIcon, PlusIcon, zoneColor } from "./ui"

export type OrgUser = Profile & { zones: string[] }
/** Présence d'un poste, tirée du fil des agents : session ouverte récemment, et agents utilisés. */
export type Presence = { active: boolean; agents: string[] }

const CARD_W = 248
const CARD_H = 108
const GAP_X = 36
const GAP_Y = 76
const TREE_GAP = 72
const ZOOM = { min: 0.35, max: 1.6 }
/** Largeur du panneau d'une personne (max-w-md), ouvert par-dessus la droite de l'organigramme. */
const DRAWER_W = 448

type Placed = { user: OrgUser; x: number; y: number; children: Placed[] }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Forêt de l'organigramme : une personne sans rattachement (ou rattachée à quelqu'un d'inconnu) est une tête.
 * Un rattachement en boucle (données anciennes ou modifiées à la main) est cassé : la personne devient une tête.
 */
export function buildForest(users: OrgUser[]): { roots: Placed[]; width: number; height: number } {
  const byId = new Map(users.map((u) => [u.id, u]))
  const childrenOf = new Map<string, OrgUser[]>()
  for (const u of users) {
    const m = u.manager_id
    if (m && m !== u.id && byId.has(m)) childrenOf.set(m, [...(childrenOf.get(m) ?? []), u])
  }
  const visited = new Set<string>()
  let cursor = 0
  let depthMax = 0

  const place = (u: OrgUser, depth: number): Placed => {
    visited.add(u.id)
    depthMax = Math.max(depthMax, depth)
    const kids = (childrenOf.get(u.id) ?? []).filter((c) => !visited.has(c.id)).map((c) => place(c, depth + 1))
    const y = depth * (CARD_H + GAP_Y)
    if (kids.length === 0) {
      const x = cursor
      cursor += CARD_W + GAP_X
      return { user: u, x, y, children: kids }
    }
    return { user: u, x: (kids[0].x + kids[kids.length - 1].x) / 2, y, children: kids }
  }

  const roots: Placed[] = []
  const heads = users.filter((u) => !u.manager_id || u.manager_id === u.id || !byId.has(u.manager_id))
  // Admins d'abord : la tête de l'entreprise à gauche, puis les postes non rattachés.
  heads.sort((a, b) => (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1))
  for (const u of [...heads, ...users]) {
    if (visited.has(u.id)) continue
    if (roots.length > 0) cursor += TREE_GAP - GAP_X
    roots.push(place(u, 0))
  }
  return { roots, width: Math.max(CARD_W, cursor - GAP_X), height: (depthMax + 1) * CARD_H + depthMax * GAP_Y }
}

function flatten(nodes: Placed[]): Placed[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

/** Traits orthogonaux parent → enfants : descente, barre horizontale, descente vers chaque carte. */
function edgePath(n: Placed): string {
  if (n.children.length === 0) return ""
  const px = n.x + CARD_W / 2
  const mid = n.y + CARD_H + GAP_Y / 2
  const xs = n.children.map((c) => c.x + CARD_W / 2)
  let d = `M${px} ${n.y + CARD_H}V${mid}M${Math.min(px, ...xs)} ${mid}H${Math.max(px, ...xs)}`
  for (const c of n.children) d += `M${c.x + CARD_W / 2} ${mid}V${c.y}`
  return d
}

/**
 * Organigramme de l'équipe : une carte par poste, reliée à la personne à qui il est rattaché. On le déplace en
 * glissant, on zoome à la molette ou avec les boutons. Cliquer une carte l'ouvre.
 */
export function OrgChart({
  users,
  zones,
  presence,
  selected,
  onSelect,
}: {
  users: OrgUser[]
  zones: Zone[]
  presence: Record<string, Presence>
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { roots, width, height } = useMemo(() => buildForest(users), [users])
  const nodes = useMemo(() => flatten(roots), [roots])
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones])

  const selectedRef = useRef(selected)
  selectedRef.current = selected

  /** Décale la vue pour que la carte ouverte ne reste pas cachée sous le panneau latéral (écrans larges). */
  const reveal = useCallback(
    (v: { x: number; y: number; k: number }) => {
      const box = boxRef.current
      const n = nodes.find((x) => x.user.id === selectedRef.current)
      if (!box || !n || box.clientWidth < 900) return v
      const right = v.x + (n.x + CARD_W) * v.k
      const limit = box.clientWidth - DRAWER_W - 24
      return right > limit ? { ...v, x: v.x - (right - limit) } : v
    },
    [nodes],
  )

  const fit = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    const cw = box.clientWidth
    const ch = box.clientHeight
    if (!cw || !ch) return
    if (cw < 640) {
      // Téléphone : tout faire tenir rendrait les cartes illisibles ; on centre la tête à une échelle lisible.
      const k = 0.6
      const head = nodes[0]
      setView({ k, x: cw / 2 - ((head?.x ?? 0) + CARD_W / 2) * k, y: 32 })
      return
    }
    const k = clamp(Math.min((cw - 64) / width, (ch - 96) / height, 1), ZOOM.min, ZOOM.max)
    setView(reveal({ k, x: (cw - width * k) / 2, y: Math.max(48, (ch - height * k) / 2) }))
  }, [width, height, nodes, reveal])

  // Recadrage à l'ouverture, quand l'équipe change de forme (rattachements compris), et quand la fenêtre change
  // de taille.
  const shape = users.map((u) => `${u.id}:${u.manager_id ?? ""}`).join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(fit, [shape, width, height])
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    // Via une ref : un changement de données (zones cochées…) ne doit pas recréer l'observateur, qui recadrerait
    // aussitôt et perdrait le déplacement fait à la main.
    const ro = new ResizeObserver(() => fitRef.current())
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  // Une carte qu'on ouvre ne doit pas rester sous le panneau latéral.
  useEffect(() => {
    if (selected) setView((v) => reveal(v))
  }, [selected, reveal])

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const box = boxRef.current
    if (!box) return
    const v = viewRef.current
    const cx = px ?? box.clientWidth / 2
    const cy = py ?? box.clientHeight / 2
    const k = clamp(v.k * factor, ZOOM.min, ZOOM.max)
    setView({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k })
  }, [])

  // Molette : zoom autour du pointeur (écouteur non passif pour empêcher le défilement).
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = box.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
    }
    box.addEventListener("wheel", onWheel, { passive: false })
    return () => box.removeEventListener("wheel", onWheel)
  }, [zoomAt])

  // Glisser le fond pour déplacer ; un clic sur le fond (sans glisser) ferme la carte ouverte.
  const drag = useRef<{ id: number; x: number; y: number; moved: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-org-control]")) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.moved += Math.abs(dx) + Math.abs(dy)
    if (d.moved > 4) {
      if (!boxRef.current?.hasPointerCapture(e.pointerId)) boxRef.current?.setPointerCapture(e.pointerId)
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (boxRef.current?.hasPointerCapture(e.pointerId)) boxRef.current.releasePointerCapture(e.pointerId)
    if (!d || d.moved > 4) return
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-org-card]")
    if (card) onSelect(card.dataset.orgCard ?? null)
    else if (!(e.target as HTMLElement).closest("[data-org-control]")) onSelect(null)
  }

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-bone active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width, height }}>
        <svg className="absolute left-0 top-0 overflow-visible" width={width} height={height} aria-hidden>
          {nodes.map((n) => (
            <path key={n.user.id} d={edgePath(n)} fill="none" stroke="var(--color-line-strong)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <ul aria-label="Organigramme">
          {nodes.map((n) => {
            const u = n.user
            const p = presence[u.id]
            const isSel = selected === u.id
            const visible = u.role === "admin" ? zones : u.zones.map((z) => zoneById.get(z)).filter((z): z is Zone => Boolean(z))
            return (
              <li key={u.id} className="absolute" style={{ left: n.x, top: n.y, width: CARD_W, height: CARD_H }}>
                <button
                  type="button"
                  data-org-card={u.id}
                  aria-pressed={isSel}
                  // Le clic est géré au relâchement du pointeur (pour distinguer un glissé) ; le clavier passe ici.
                  onClick={(e) => e.detail === 0 && onSelect(u.id)}
                  className={`flex h-full w-full cursor-pointer flex-col justify-between rounded-[8px] border bg-surface p-3.5 text-left transition-colors duration-150 ease-out ${
                    isSel ? "border-ink" : "border-line hover:border-line-strong"
                  }`}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <span className="relative shrink-0">
                      <PersonAvatar id={u.id} size={40} />
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-ink ${p?.active ? "bg-phosphor" : "bg-surface"}`}
                        title={p?.active ? "Agent actif ces 15 dernières minutes" : "Pas d'agent actif"}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium leading-tight">{u.name}</span>
                      <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-trace">{u.title || (u.role === "admin" ? "Admin" : "Membre")}</span>
                      <span className="mono mt-1 block truncate text-[11.5px] leading-tight text-trace">
                        {p?.agents.length ? p.agents.join(", ") : "Pas encore d'agent"}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-trace">
                    {u.role === "admin" ? (
                      <span>Admin, toutes les zones</span>
                    ) : visible.length === 0 ? (
                      <span>Aucune zone</span>
                    ) : (
                      <>
                        {visible.slice(0, 8).map((z) => (
                          <span key={z.id} title={z.name}>
                            <Dot color={zoneColor(z.color, z.position)} size={7} />
                          </span>
                        ))}
                        <span className="ml-0.5 tabular-nums">
                          {visible.length} zone{visible.length > 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div data-org-control className="absolute bottom-4 right-4 flex flex-col gap-1.5">
        <button type="button" className="btn btn-icon" aria-label="Zoomer" onClick={() => zoomAt(1.2)}>
          <PlusIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Dézoomer" onClick={() => zoomAt(1 / 1.2)}>
          <MinusIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Recentrer l'organigramme" title="Recentrer" onClick={fit}>
          <FitIcon />
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-4 left-4 hidden text-[12px] text-trace sm:block">Glisser pour déplacer, molette pour zoomer, cliquer une carte pour l&apos;ouvrir.</p>
    </div>
  )
}

function FitIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </svg>
  )
}
