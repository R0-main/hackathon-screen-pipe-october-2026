"use client"

import { useMemo } from "react"
import type { ZoneView } from "@/lib/brain"
import {
  CENTER,
  HEMISPHERES,
  VIEW_H,
  VIEW_W,
  gyriPaths,
  hemispherePolygon,
  layoutZones,
  neuronPositions,
  polygonPath,
  round2,
  smoothPath,
  type Pt,
} from "./brain-geometry"

export type ZoneActivity = { until: number; startedAt: number; who?: string; label?: string }
export type Ripple = { key: string; zone: string }

type Synapse = { a: string; b: string; weight: number; via: string[] }

const bubble = (label: string) => (label.length > 32 ? `${label.slice(0, 31)}…` : label)

export function BrainViz(props: {
  zones: ZoneView[]
  synapses: Synapse[]
  activity: Record<string, ZoneActivity>
  ripples: Ripple[]
  now: number
  selected?: string | null
  onSelect?: (zone: string) => void
}) {
  const { zones, synapses, activity, ripples, now, selected, onSelect } = props
  const ids = useMemo(() => zones.map((z) => z.id), [zones])
  const cells = useMemo(() => layoutZones(ids), [ids])
  const cellBy = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells])
  const outlines = useMemo(() => HEMISPHERES.map((h) => smoothPath(hemispherePolygon(h, 140, 1))), [])
  const gyri = useMemo(() => HEMISPHERES.map((h) => gyriPaths(h)), [])
  const maxCount = Math.max(1, ...zones.map((z) => z.count))

  const intensity = (zone: string) => {
    const a = activity[zone]
    if (!a || a.until <= now) return 0
    return Math.min(1, (a.until - now) / 5000)
  }

  return (
    <svg viewBox={`80 18 ${VIEW_W - 160} ${VIEW_H - 30}`} className="block h-auto w-full select-none" role="img" aria-label="Cerveau de l'entreprise, découpé en zones de connaissance">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="brain-fill" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#0d1424" />
          <stop offset="100%" stopColor="#060912" />
        </radialGradient>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(148,163,184,0.16)" strokeWidth="2" />
        </pattern>
        <clipPath id="brain-clip">
          {outlines.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </clipPath>
      </defs>

      {/* Halo et silhouette */}
      <ellipse cx={CENTER[0]} cy={CENTER[1]} rx={430} ry={300} fill="rgba(34,211,238,0.035)" filter="url(#glow)" />
      {outlines.map((d, i) => (
        <path key={i} d={d} fill="url(#brain-fill)" stroke="rgba(148,163,184,0.32)" strokeWidth={1.5} />
      ))}

      <g clipPath="url(#brain-clip)">
        {/* Zones */}
        {zones.map((z) => {
          const cell = cellBy.get(z.id)
          if (!cell) return null
          const it = intensity(z.id)
          const base = z.locked ? 0.03 : 0.05 + 0.12 * (z.count / maxCount)
          const isSel = selected === z.id
          return (
            <g key={z.id} onClick={() => onSelect?.(z.id)} className="zone-cell">
              <path d={polygonPath(cell.polygon)} fill={z.locked ? "#64748b" : z.color} fillOpacity={base + 0.3 * it + (isSel ? 0.08 : 0)} />
              {z.locked && <path d={polygonPath(cell.polygon)} fill="url(#hatch)" />}
              <path
                d={polygonPath(cell.polygon)}
                fill="none"
                stroke={z.color}
                strokeOpacity={z.locked ? 0.18 + 0.5 * it : 0.32 + 0.6 * it + (isSel ? 0.3 : 0)}
                strokeWidth={1 + 2.2 * it + (isSel ? 1 : 0)}
                filter={it > 0.05 ? "url(#glow)" : undefined}
              />
            </g>
          )
        })}

        {/* Circonvolutions par-dessus, pour la texture */}
        {gyri.flat().map((d, i) => (
          <path key={i} d={d} className="brain-gyri" />
        ))}

        {/* Synapses : zones reliées par des entités communes (clients, outils, projets) */}
        {synapses.map((s) => {
          const a = cellBy.get(s.a)
          const b = cellBy.get(s.b)
          if (!a || !b) return null
          const active = intensity(s.a) > 0 || intensity(s.b) > 0
          const ctrl: Pt = [round2(((a.center[0] + b.center[0]) / 2) * 0.6 + CENTER[0] * 0.4), round2(((a.center[1] + b.center[1]) / 2) * 0.6 + CENTER[1] * 0.4)]
          const za = zones.find((z) => z.id === s.a)
          return (
            <path
              key={`${s.a}|${s.b}`}
              d={`M${a.center[0]},${a.center[1]} Q${ctrl[0]},${ctrl[1]} ${b.center[0]},${b.center[1]}`}
              fill="none"
              stroke={za?.color ?? "#94a3b8"}
              strokeOpacity={active ? 0.55 : 0.12}
              strokeWidth={round2(Math.min(3.2, 0.7 + Math.log2(1 + s.weight) * 0.45))}
              className={active ? "synapse-flow" : undefined}
            >
              {s.via.length > 0 && <title>{`Liées par : ${s.via.join(", ")}`}</title>}
            </path>
          )
        })}

        {/* Neurones : les entités les plus citées de chaque zone */}
        {zones.map((z) => {
          const cell = cellBy.get(z.id)
          if (!cell || z.locked) return null
          const pts = neuronPositions(cell, Math.min(8, Math.max(3, z.entities.length)))
          const it = intensity(z.id)
          return pts.map((p, i) => {
            const e = z.entities[i]
            return (
              <g key={`${z.id}-n${i}`}>
                <circle
                  cx={p[0]}
                  cy={p[1]}
                  r={e ? 2.5 + Math.min(4, e.count * 0.7) : 2}
                  fill={z.color}
                  className="neuron"
                  style={{ animationDelay: `${(i * 0.37) % 3}s`, opacity: 0.5 + it * 0.5 }}
                  filter="url(#soft-glow)"
                >
                  {e && <title>{`${e.name} (${e.count})`}</title>}
                </circle>
              </g>
            )
          })
        })}
      </g>

      {/* Noms des entités les plus citées (hors découpe, pour ne jamais être coupés au bord) */}
      {zones.map((z) => {
        const cell = cellBy.get(z.id)
        if (!cell || z.locked) return null
        const pts = neuronPositions(cell, Math.min(8, Math.max(3, z.entities.length)))
        const hemiCx = cell.side === "left" ? HEMISPHERES[0].cx : HEMISPHERES[1].cx
        return pts.map((p, i) => {
          const e = z.entities[i]
          if (!e || e.count < 3) return null
          const toLeft = p[0] > hemiCx
          return (
            <text
              key={`${z.id}-t${i}`}
              x={toLeft ? p[0] - 7 : p[0] + 7}
              y={p[1] + 3.5}
              textAnchor={toLeft ? "end" : "start"}
              fontSize={10.5}
              fill="rgba(226,232,240,0.55)"
              pointerEvents="none"
            >
              {e.name}
            </text>
          )
        })
      })}

      {/* Ondes : un agent vient de chercher / écrire dans la zone */}
      {ripples.map((r) => {
        const cell = cellBy.get(r.zone)
        const z = zones.find((x) => x.id === r.zone)
        if (!cell || !z) return null
        return <circle key={r.key} cx={cell.center[0]} cy={cell.center[1]} r={38} fill="none" stroke={z.color} strokeWidth={2.5} className="ripple" />
      })}

      {/* Libellés */}
      {zones.map((z) => {
        const cell = cellBy.get(z.id)
        if (!cell) return null
        const it = intensity(z.id)
        const act = activity[z.id]
        const [x, y] = cell.center
        return (
          <g key={`${z.id}-label`} onClick={() => onSelect?.(z.id)} style={{ cursor: "pointer" }}>
            <text
              x={x}
              y={y - 8}
              textAnchor="middle"
              fontSize={15}
              fontWeight={700}
              letterSpacing="0.08em"
              fill={z.locked ? "#64748b" : z.color}
              filter={it > 0.05 ? "url(#soft-glow)" : undefined}
              style={{ textTransform: "uppercase" }}
            >
              {z.locked ? `🔒 ${z.name}` : z.name}
            </text>
            <text x={x} y={y + 14} textAnchor="middle" fontSize={12} fill="rgba(203,213,225,0.7)" className="mono">
              {z.locked ? "accès restreint" : `${z.count} connaissance${z.count > 1 ? "s" : ""}`}
            </text>
            {act && act.until > now && act.label && (
              <g className="bubble-in" key={act.startedAt}>
                <rect
                  x={x - Math.min(105, bubble(act.label).length * 3.1 + 14)}
                  y={y + 24}
                  width={Math.min(210, bubble(act.label).length * 6.2 + 28)}
                  height={21}
                  rx={10.5}
                  fill="rgba(2,6,23,0.88)"
                  stroke={z.color}
                  strokeOpacity={0.7}
                />
                <text x={x} y={y + 38.5} textAnchor="middle" fontSize={11} fill="#e2e8f0">
                  {bubble(act.label)}
                </text>
              </g>
            )}
          </g>
        )
      })}

      {/* Scissure inter-hémisphérique */}
      <path d={`M500,40 C496,160 504,460 500,585`} stroke="rgba(148,163,184,0.18)" strokeWidth={1.5} fill="none" />
    </svg>
  )
}
