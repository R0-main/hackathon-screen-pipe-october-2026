"use client"

import { useId } from "react"
import type { DashboardState } from "@/lib/brain"
import { useBrainLiveOptional } from "./BrainLive"
import { DOT_PROFILE, assignLooks, dotLook, type DotLook } from "./dot-model"
import { zoneColor } from "./ui"

/** Comme dans le cerveau : une zone verrouillée, ou personne sans zone, donne un dot gris. */
const NEUTRAL = "#b8b8b8"
const INK = "#141414"

// Repère du modèle 3D (une unité de rayon, base à y = 0), y retourné pour le SVG. Le cadre rond entoure le dot et sa tenue.
const FRAME = { cy: -0.74, r: 1.4 }
const VIEW = `${-FRAME.r} ${FRAME.cy - FRAME.r} ${FRAME.r * 2} ${FRAME.r * 2}`

/** Silhouette de face du corps : le profil tourné, mis à plat et lissé (Catmull-Rom). */
const BODY = (() => {
  const right = DOT_PROFILE.slice(1).map(([x, y]) => [x, -y])
  const pts = [...right, ...right.slice(0, -1).reverse().map(([x, y]) => [-x, y])]
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1.map((v) => v.toFixed(3))} ${c2.map((v) => v.toFixed(3))} ${p2[0]},${p2[1]}`
  }
  return `${d}Z`
})()

const EYE_Y = -0.86

/**
 * Le dot d'une personne à plat, dans un rond : sa photo de profil. Même corps de feutrine, même couleur de zone et même
 * tenue que dans le cerveau. Décoratif : le nom est toujours écrit à côté.
 */
export function PersonDot(props: { id: string; color?: string; look?: DotLook; size: number; bg?: "bone" | "surface"; dashed?: boolean; className?: string }) {
  const { size, color = NEUTRAL, look = dotLook(props.id), bg = "bone", className = "" } = props
  const uid = useId().replace(/:/g, "")
  const px = (FRAME.r * 2) / size
  const frog = look === "frog"
  const felt = (
    <>
      {frog && [-0.42, 0.42].map((x) => <ellipse key={x} cx={x} cy={-1.36} rx={0.36} ry={0.36} />)}
      <path d={BODY} />
    </>
  )
  return (
    <svg width={size} height={size} viewBox={VIEW} aria-hidden className={`block shrink-0 ${className}`}>
      <defs>
        <clipPath id={`${uid}-frame`}>
          <circle cx={0} cy={FRAME.cy} r={FRAME.r} />
        </clipPath>
        <clipPath id={`${uid}-felt`}>{felt}</clipPath>
        {/* Lumière en haut à gauche, comme la lampe de la scène ; le bord s'assombrit (feutrine, pas de reflet net). */}
        <radialGradient id={`${uid}-light`} gradientUnits="userSpaceOnUse" cx={-0.38} cy={-1.18} r={1.5}>
          <stop offset="0" stopColor="#fff" stopOpacity={0.42} />
          <stop offset="0.65" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${uid}-rim`} gradientUnits="userSpaceOnUse" cx={0} cy={-0.8} r={1.15}>
          <stop offset="0.6" stopColor="#000" stopOpacity={0} />
          <stop offset="1" stopColor="#000" stopOpacity={0.24} />
        </radialGradient>
      </defs>
      <circle cx={0} cy={FRAME.cy} r={FRAME.r} fill={`var(--color-${bg})`} />
      <g clipPath={`url(#${uid}-frame)`}>
        <ellipse cx={0} cy={0.03} rx={0.95} ry={0.11} fill={INK} opacity={0.1} />
        <g fill={color}>{felt}</g>
        <g clipPath={`url(#${uid}-felt)`}>
          <rect x={-1.5} y={-2.2} width={3} height={2.4} fill={`url(#${uid}-light)`} />
          <rect x={-1.5} y={-2.2} width={3} height={2.4} fill={`url(#${uid}-rim)`} />
        </g>
        <Face look={look} />
      </g>
      <circle
        cx={0}
        cy={FRAME.cy}
        r={FRAME.r - px / 2}
        fill="none"
        stroke="var(--color-line-strong)"
        strokeWidth={px}
        strokeDasharray={props.dashed ? `${px * 3} ${px * 2}` : undefined}
      />
    </svg>
  )
}

function Face({ look }: { look: DotLook }) {
  const bridge = <rect x={-0.12} y={EYE_Y - 0.055} width={0.24} height={0.07} rx={0.035} fill={INK} />
  if (look === "frog")
    return (
      <>
        {[-0.42, 0.42].map((x) => (
          <g key={x}>
            <circle cx={x} cy={-1.4} r={0.23} fill="#fff" />
            <circle cx={x * 1.05} cy={-1.4} r={0.12} fill={INK} />
          </g>
        ))}
      </>
    )
  if (look === "glasses")
    return (
      <>
        {[-0.36, 0.36].map((x) => (
          <g key={x}>
            <circle cx={x} cy={EYE_Y} r={0.24} fill="none" stroke={INK} strokeWidth={0.085} />
            <ellipse cx={x} cy={EYE_Y + 0.04} rx={0.11} ry={0.035} fill={INK} />
          </g>
        ))}
        {bridge}
      </>
    )
  if (look === "shades")
    return (
      <>
        {[-0.36, 0.36].map((x) => (
          <circle key={x} cx={x} cy={EYE_Y} r={0.26} fill={INK} />
        ))}
        {bridge}
      </>
    )
  return (
    <>
      {[-0.28, 0.28].map((x) => (
        <ellipse key={x} cx={x} cy={EYE_Y} rx={0.1} ry={0.16} fill={INK} />
      ))}
      {look === "beret" && (
        <g transform="translate(-0.1 -1.5) rotate(-12.6)" fill={INK}>
          <ellipse cx={0} cy={0} rx={0.95} ry={0.28} />
          <circle cx={0} cy={-0.3} r={0.12} />
        </g>
      )}
    </>
  )
}

export type PersonLook = { color: string; look: DotLook }
const looksCache = new WeakMap<DashboardState, Map<string, PersonLook>>()

/** Couleur (sa zone) et tenue de chacun, calculées comme le cerveau les calcule : un même état, une seule fois. */
export function peopleLooks(state: DashboardState): Map<string, PersonLook> {
  const hit = looksCache.get(state)
  if (hit) return hit
  const zones = new Map(state.zones.map((z) => [z.id, z]))
  const placed = state.people.filter((p) => p.zone && zones.has(p.zone))
  const looks = assignLooks(placed)
  const out = new Map<string, PersonLook>()
  for (const p of state.people) {
    const z = p.zone ? zones.get(p.zone) : undefined
    out.set(p.id, { color: z && !z.locked ? zoneColor(z.color, z.position) : NEUTRAL, look: looks.get(p.id) ?? dotLook(p.id) })
  }
  looksCache.set(state, out)
  return out
}

/**
 * Le dot d'un membre de l'équipe, retrouvé dans l'état du cerveau (sa zone, sa tenue). Hors du cerveau (création de
 * l'entreprise), ou pour quelqu'un qu'il ne connaît pas encore, `color` et la tenue tirée de l'identifiant prennent le relais.
 */
export function PersonAvatar(props: { id: string; size: number; color?: string; bg?: "bone" | "surface"; dashed?: boolean; className?: string }) {
  const live = useBrainLiveOptional()
  const known = live ? peopleLooks(live.state).get(props.id) : undefined
  return <PersonDot {...props} color={known?.color ?? props.color} look={known?.look} />
}
