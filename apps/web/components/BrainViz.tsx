"use client"

import { useMemo } from "react"
import { isCoreZone } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { CENTER, HEMISPHERES, VIEW_H, VIEW_W, gyriPaths, hemispherePolygon, layoutZones, neuronPositions, polygonPath, round2, smoothPath, type Pt } from "./brain-geometry"
import { BRAIN_PALETTE, brainZoneColor, useTheme } from "./theme"
import { zoneColor } from "./ui"

export type ZoneActivity = { until: number; startedAt: number; who?: string; label?: string }
export type Ripple = { key: string; zone: string }

type Synapse = { a: string; b: string; weight: number; via: string[] }

/** The interface's tokens (globals.css), per theme: ink, secondary text, line, panel and page. */
const TONES = {
  light: { INK: "#0a0a0a", TRACE: "#78786f", LINE: "#e2e2dc", PAPER: "#ffffff", BONE: "#f6f6f3" },
  dark: { INK: "#f2f2ee", TRACE: "#9a9a91", LINE: "#2a2a27", PAPER: "#161615", BONE: "#0e0e0d" },
}
const PHOSPHOR = "#c7ff3e"
/** The core: a disc on the fissure, between the two hemispheres, with a thread to each zone. */
const CORE_R = 34

const bubble = (label: string) => (label.length > 36 ? `${label.slice(0, 35)}…` : label)

/**
 * 2D brain (top view), monochrome: ink on white. The fallback when WebGL is not
 * available. An active zone lights up in phosphor; a zone's identity color only appears
 * in its label's dot.
 */
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
  const theme = useTheme()
  const { INK, TRACE, LINE, PAPER, BONE } = TONES[theme]
  const ids = useMemo(() => zones.map((z) => z.id).filter((id) => !isCoreZone(id)), [zones])
  const core = zones.find((z) => isCoreZone(z.id))
  const coreColor = core ? brainZoneColor(core, BRAIN_PALETTE[theme]) : ""
  const cells = useMemo(() => layoutZones(ids), [ids])
  const cellBy = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells])
  const outlines = useMemo(() => HEMISPHERES.map((h) => smoothPath(hemispherePolygon(h, 140, 1))), [])
  const gyri = useMemo(() => HEMISPHERES.map((h) => gyriPaths(h)), [])

  const intensity = (zone: string) => {
    const a = activity[zone]
    if (!a || a.until <= now) return 0
    return Math.min(1, (a.until - now) / 5000)
  }

  return (
    <svg viewBox={`80 18 ${VIEW_W - 160} ${VIEW_H - 30}`} className="block h-auto w-full select-none" role="img" aria-label="The company brain, split into knowledge zones">
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={LINE} strokeWidth="2" />
        </pattern>
        <clipPath id="brain-clip">
          {outlines.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </clipPath>
      </defs>

      {outlines.map((d, i) => (
        <path key={i} d={d} fill={PAPER} stroke={INK} strokeWidth={1.2} />
      ))}

      <g clipPath="url(#brain-clip)">
        {zones.map((z) => {
          const cell = cellBy.get(z.id)
          if (!cell) return null
          const it = intensity(z.id)
          const isSel = selected === z.id
          return (
            <g key={z.id} onClick={() => onSelect?.(z.id)} style={{ cursor: "pointer" }}>
              <path d={polygonPath(cell.polygon)} fill={it > 0 ? PHOSPHOR : isSel ? BONE : PAPER} fillOpacity={it > 0 ? 0.35 + 0.5 * it : 1} />
              {z.locked && <path d={polygonPath(cell.polygon)} fill="url(#hatch)" />}
              <path d={polygonPath(cell.polygon)} fill="none" stroke={INK} strokeOpacity={isSel ? 1 : 0.25} strokeWidth={isSel ? 1.5 : 1} />
            </g>
          )
        })}

        {gyri.flat().map((d, i) => (
          <path key={i} d={d} fill="none" stroke={LINE} strokeWidth={1} />
        ))}

        {core &&
          cells.map((c) => {
            const active = intensity(core.id) > 0 || intensity(c.id) > 0
            return (
              <line
                key={`core-${c.id}`}
                x1={CENTER[0]}
                y1={CENTER[1]}
                x2={c.center[0]}
                y2={c.center[1]}
                stroke={active ? INK : TRACE}
                strokeOpacity={active ? 0.8 : 0.25}
                strokeDasharray="2 4"
                className={active ? "synapse-flow" : undefined}
              />
            )
          })}

        {synapses.map((s) => {
          const a = cellBy.get(s.a)
          const b = cellBy.get(s.b)
          if (!a || !b) return null
          const active = intensity(s.a) > 0 || intensity(s.b) > 0
          const ctrl: Pt = [round2(((a.center[0] + b.center[0]) / 2) * 0.6 + CENTER[0] * 0.4), round2(((a.center[1] + b.center[1]) / 2) * 0.6 + CENTER[1] * 0.4)]
          return (
            <path
              key={`${s.a}|${s.b}`}
              d={`M${a.center[0]},${a.center[1]} Q${ctrl[0]},${ctrl[1]} ${b.center[0]},${b.center[1]}`}
              fill="none"
              stroke={active ? INK : TRACE}
              strokeOpacity={active ? 0.9 : 0.35}
              strokeWidth={round2(Math.min(2.5, 0.7 + Math.log2(1 + s.weight) * 0.4))}
              className={active ? "synapse-flow" : undefined}
            >
              {s.via.length > 0 && <title>{`Linked by: ${s.via.join(", ")}`}</title>}
            </path>
          )
        })}

        {zones.map((z) => {
          const cell = cellBy.get(z.id)
          if (!cell || z.locked) return null
          const pts = neuronPositions(cell, Math.min(8, Math.max(3, z.entities.length)))
          return pts.map((p, i) => {
            const e = z.entities[i]
            return (
              <circle key={`${z.id}-n${i}`} cx={p[0]} cy={p[1]} r={e ? 2 + Math.min(3, e.count * 0.5) : 1.8} fill={INK}>
                {e && <title>{`${e.name} (${e.count})`}</title>}
              </circle>
            )
          })
        })}
      </g>

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
            <text key={`${z.id}-t${i}`} x={toLeft ? p[0] - 7 : p[0] + 7} y={p[1] + 3.5} textAnchor={toLeft ? "end" : "start"} fontSize={10.5} fill={TRACE} pointerEvents="none">
              {e.name}
            </text>
          )
        })
      })}

      {ripples.map((r) => {
        if (core && r.zone === core.id) return <circle key={r.key} cx={CENTER[0]} cy={CENTER[1]} r={CORE_R + 8} fill="none" stroke={PHOSPHOR} strokeWidth={3} className="ripple" />
        const cell = cellBy.get(r.zone)
        if (!cell) return null
        return <circle key={r.key} cx={cell.center[0]} cy={cell.center[1]} r={38} fill="none" stroke={PHOSPHOR} strokeWidth={3} className="ripple" />
      })}

      {zones.map((z) => {
        const cell = cellBy.get(z.id)
        if (!cell) return null
        const act = activity[z.id]
        const [x, y] = cell.center
        return (
          <g key={`${z.id}-label`} onClick={() => onSelect?.(z.id)} style={{ cursor: "pointer" }}>
            <circle cx={x} cy={y - 26} r={4} fill={zoneColor(z.color, z.position)} />
            <text x={x} y={y - 4} textAnchor="middle" fontSize={15} fontWeight={500} fill={INK}>
              {z.name}
            </text>
            <text x={x} y={y + 14} textAnchor="middle" fontSize={12} fill={TRACE}>
              {z.locked ? "restricted access" : `${z.count} item${z.count === 1 ? "" : "s"}`}
            </text>
            {act && act.until > now && act.label && (
              <g className="bubble-in" key={act.startedAt}>
                <rect
                  x={x - Math.min(118, bubble(act.label).length * 3.3 + 14)}
                  y={y + 24}
                  width={Math.min(236, bubble(act.label).length * 6.6 + 28)}
                  height={22}
                  rx={4}
                  fill={PAPER}
                  stroke={INK}
                />
                <text x={x} y={y + 39} textAnchor="middle" fontSize={11} fill={INK}>
                  {bubble(act.label)}
                </text>
              </g>
            )}
          </g>
        )
      })}

      <path d="M500,40 C496,160 504,460 500,585" stroke={INK} strokeOpacity={0.25} strokeWidth={1} fill="none" />

      {core && (
        <g onClick={() => onSelect?.(core.id)} style={{ cursor: "pointer" }}>
          <circle
            cx={CENTER[0]}
            cy={CENTER[1]}
            r={CORE_R}
            fill={intensity(core.id) > 0 ? PHOSPHOR : selected === core.id ? BONE : PAPER}
            stroke={coreColor}
            strokeWidth={selected === core.id ? 2.5 : 1.5}
          />
          <circle cx={CENTER[0]} cy={CENTER[1] - 14} r={4} fill={coreColor} />
          <text x={CENTER[0]} y={CENTER[1] + 4} textAnchor="middle" fontSize={14} fontWeight={500} fill={INK}>
            {core.name}
          </text>
          <text x={CENTER[0]} y={CENTER[1] + 19} textAnchor="middle" fontSize={11} fill={TRACE}>
            {`${core.count} item${core.count === 1 ? "" : "s"}`}
          </text>
        </g>
      )}
    </svg>
  )
}
