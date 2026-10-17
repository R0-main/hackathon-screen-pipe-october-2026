// Brain geometry (top view): two hemispheres, gyri, and split into zones (Voronoi).
// Everything is deterministic (seed) so that the server render and the client render are identical.

export type Pt = [number, number]

/**
 * Rounded to the hundredth. Math.cos/sin may differ in the last bit between Node (server render) and the browser:
 * rounding at the source, the rest of the computation (IEEE arithmetic) then gives the same result on both sides.
 */
export const round2 = (v: number) => Math.round(v * 100) / 100
const roundPt = (p: Pt): Pt => [round2(p[0]), round2(p[1])]

export const VIEW_W = 1000
export const VIEW_H = 620
export const CENTER: Pt = [500, 310]

type Hemisphere = { side: "left" | "right"; cx: number; cy: number; rxOuter: number; rxInner: number; ry: number }

export const HEMISPHERES: Hemisphere[] = [
  { side: "left", cx: 362, cy: 312, rxOuter: 252, rxInner: 128, ry: 276 },
  { side: "right", cx: 638, cy: 312, rxOuter: 252, rxInner: 128, ry: 276 },
]

export function seeded(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100000) / 100000
  }
}

export function hashString(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Point of a hemisphere's outline for angle t (optional bumps). */
function hemiPoint(h: Hemisphere, t: number, bumps: number, scale = 1): Pt {
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const outward = h.side === "left" ? cos < 0 : cos > 0
  let rx = outward ? h.rxOuter : h.rxInner
  // Frontal lobe (top) a bit narrower.
  rx *= 1 - 0.13 * Math.max(0, -sin)
  const phase = h.side === "left" ? 0.4 : 2.1
  const r = 1 + bumps * (0.03 * Math.sin(9 * t + phase) + 0.018 * Math.sin(15 * t + phase * 2) + 0.009 * Math.sin(27 * t))
  return roundPt([h.cx + rx * r * scale * cos, h.cy + h.ry * r * scale * sin])
}

export function hemispherePolygon(h: Hemisphere, n = 140, bumps = 1, scale = 1): Pt[] {
  return Array.from({ length: n }, (_, i) => hemiPoint(h, (i / n) * Math.PI * 2, bumps, scale))
}

/** Smoothed path (Catmull-Rom → Bézier) through points, closed or not. */
export function smoothPath(pts: Pt[], closed = true): string {
  if (pts.length < 2) return ""
  const p = (i: number) => (closed ? pts[(i + pts.length) % pts.length] : pts[Math.max(0, Math.min(pts.length - 1, i))])
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  const last = closed ? pts.length : pts.length - 1
  for (let i = 0; i < last; i++) {
    const p0 = p(i - 1)
    const p1 = p(i)
    const p2 = p(i + 1)
    const p3 = p(i + 2)
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return closed ? `${d} Z` : d
}

export function polygonPath(pts: Pt[]): string {
  return pts.length ? `M${pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" L")} Z` : ""
}

export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Gyri: wavy curves inside each hemisphere. */
export function gyriPaths(h: Hemisphere, count = 22, seed = 7): string[] {
  const rand = seeded(seed + (h.side === "left" ? 0 : 1000))
  const inner = hemispherePolygon(h, 60, 0, 0.92)
  const out: string[] = []
  // Concentric outlines that follow the shape.
  for (const s of [0.82, 0.62]) {
    const ring = hemispherePolygon(h, 90, 1.6, s).map(([x, y], i): Pt => roundPt([x + Math.sin(i * 1.7) * 4, y + Math.cos(i * 2.3) * 4]))
    out.push(smoothPath(ring, true))
  }
  let guard = 0
  while (out.length < count + 2 && guard++ < 500) {
    const start: Pt = [h.cx + (rand() - 0.5) * h.rxOuter * 1.6, h.cy + (rand() - 0.5) * h.ry * 1.8]
    if (!pointInPolygon(start, inner)) continue
    const angle = rand() * Math.PI * 2
    const len = 50 + rand() * 110
    const steps = 7
    const amp = 6 + rand() * 9
    const pts: Pt[] = []
    for (let k = 0; k <= steps; k++) {
      const d = (k / steps) * len
      const off = Math.sin(k * 1.9 + rand() * 0.6) * amp
      pts.push(roundPt([start[0] + Math.cos(angle) * d - Math.sin(angle) * off, start[1] + Math.sin(angle) * d + Math.cos(angle) * off]))
    }
    out.push(smoothPath(pts, false))
  }
  return out
}

/** Clips a polygon by the half-plane a·x + b·y ≤ c (Sutherland–Hodgman). */
function clipHalfPlane(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]
    const prev = poly[(i + poly.length - 1) % poly.length]
    const curIn = a * cur[0] + b * cur[1] <= c
    const prevIn = a * prev[0] + b * prev[1] <= c
    if (curIn !== prevIn) {
      const t = (c - a * prev[0] - b * prev[1]) / (a * (cur[0] - prev[0]) + b * (cur[1] - prev[1]))
      out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])])
    }
    if (curIn) out.push(cur)
  }
  return out
}

/** Clips a polygon by a convex polygon (any orientation). */
function clipConvex(poly: Pt[], clip: Pt[]): Pt[] {
  // Orientation of the clipping polygon.
  let area = 0
  for (let i = 0; i < clip.length; i++) {
    const [x1, y1] = clip[i]
    const [x2, y2] = clip[(i + 1) % clip.length]
    area += x1 * y2 - x2 * y1
  }
  const sign = area > 0 ? 1 : -1
  let out = poly
  for (let i = 0; i < clip.length && out.length; i++) {
    const [x1, y1] = clip[i]
    const [x2, y2] = clip[(i + 1) % clip.length]
    // Inside: cross product with the same sign as the orientation.
    const a = sign * (y2 - y1)
    const b = -sign * (x2 - x1)
    const c = a * x1 + b * y1
    out = clipHalfPlane(out, a, b, c)
  }
  return out
}

export function centroid(poly: Pt[]): Pt {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    const f = x1 * y2 - x2 * y1
    a += f
    cx += (x1 + x2) * f
    cy += (y1 + y2) * f
  }
  if (Math.abs(a) < 1e-6) return poly[0] ?? CENTER
  return [cx / (3 * a), cy / (3 * a)]
}

export type ZoneCell = { id: string; side: "left" | "right"; polygon: Pt[]; center: Pt; site: Pt; area: number }

function polygonArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}

/** Spreads the zones over the two hemispheres and computes their cells (Voronoi restricted to each hemisphere). */
export function layoutZones(zoneIds: string[]): ZoneCell[] {
  if (zoneIds.length === 0) return []
  const left = zoneIds.filter((_, i) => i % 2 === 0)
  const right = zoneIds.filter((_, i) => i % 2 === 1)
  const cells: ZoneCell[] = []
  for (const [h, ids] of [
    [HEMISPHERES[0], left],
    [HEMISPHERES[1], right],
  ] as const) {
    if (ids.length === 0) continue
    const m = ids.length
    const sites: Pt[] = ids.map((_, i) => {
      const y = h.cy + (i - (m - 1) / 2) * ((h.ry * 1.55) / m)
      const zig = m === 1 ? 0 : i % 2 === 0 ? -42 : 38
      const x = h.side === "left" ? h.cx - 20 + zig : h.cx + 20 - zig
      return [x, y]
    })
    const hull = hemispherePolygon(h, 64, 0, 1.0)
    ids.forEach((id, i) => {
      let poly: Pt[] = [
        [0, 0],
        [VIEW_W, 0],
        [VIEW_W, VIEW_H],
        [0, VIEW_H],
      ]
      const si = sites[i]
      sites.forEach((sj, j) => {
        if (j === i) return
        const a = sj[0] - si[0]
        const b = sj[1] - si[1]
        const c = (sj[0] ** 2 + sj[1] ** 2 - si[0] ** 2 - si[1] ** 2) / 2
        poly = clipHalfPlane(poly, a, b, c)
      })
      poly = clipConvex(poly, hull)
      poly = poly.map(roundPt)
      cells.push({ id, side: h.side, polygon: poly, center: roundPt(centroid(poly)), site: si, area: polygonArea(poly) })
    })
  }
  return cells
}

/** Positions of a zone's "neurons" (entities), away from the label. */
export function neuronPositions(cell: ZoneCell, count: number): Pt[] {
  const rand = seeded(hashString(cell.id))
  const xs = cell.polygon.map((p) => p[0])
  const ys = cell.polygon.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const pts: Pt[] = []
  let guard = 0
  while (pts.length < count && guard++ < 800) {
    const p: Pt = [minX + rand() * (maxX - minX), minY + rand() * (maxY - minY)]
    if (!pointInPolygon(p, cell.polygon)) continue
    if (Math.abs(p[0] - cell.center[0]) < 78 && Math.abs(p[1] - cell.center[1]) < 40) continue
    // Not too close to the edge or to the other neurons.
    const shrunk: Pt = [cell.center[0] + (p[0] - cell.center[0]) * 1.12, cell.center[1] + (p[1] - cell.center[1]) * 1.12]
    if (!pointInPolygon(shrunk, cell.polygon)) continue
    if (pts.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < 26 ** 2)) continue
    pts.push(p)
  }
  return pts.map(roundPt)
}

// --- 3D brain: shape, network of links and zone places (shared by the dashboard and the home page) ---
// Frame: x from back to front (forehead toward +x), y from bottom to top, z from left to right. Seen along z, it's the profile.

export type V3 = [number, number, number]
type Ellipsoid = { c: V3; r: V3 }
type Part = "cortex" | "cerebellum" | "stem"
export type SurfacePoint = { p: V3; n: V3; part: Part }

/** Half-length of the brain once scaled (same footprint as the old shell). */
const HALF_LENGTH = 1.6
const FISSURE = 0.035
const SAMPLES = 2600

/** A hemisphere: mass, frontal lobe, occipital lobe, temporal lobe going down the side. */
const hemisphere = (s: number): Ellipsoid[] => [
  { c: [0.0, 0.22, s * 0.46], r: [1.15, 0.72, 0.5] },
  { c: [0.6, 0.14, s * 0.43], r: [0.66, 0.6, 0.45] },
  { c: [-0.86, 0.12, s * 0.41], r: [0.5, 0.55, 0.41] },
  { c: [0.12, -0.36, s * 0.55], r: [0.7, 0.32, 0.36] },
]
const HEMI_PARTS = [hemisphere(-1), hemisphere(1)]
const CEREBELLUM: Ellipsoid = { c: [-0.74, -0.5, 0], r: [0.44, 0.27, 0.7] }
const STEM: Ellipsoid = { c: [-0.24, -0.82, 0], r: [0.17, 0.46, 0.17] }

/** Approximate signed distance to an ellipsoid. */
function ellipsoidDist(p: V3, e: Ellipsoid): number {
  const x = p[0] - e.c[0]
  const y = p[1] - e.c[1]
  const z = p[2] - e.c[2]
  const k0 = Math.hypot(x / e.r[0], y / e.r[1], z / e.r[2])
  const k1 = Math.hypot(x / e.r[0] ** 2, y / e.r[1] ** 2, z / e.r[2] ** 2)
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(...e.r)
}

/** Smooth union: the lobes melt into each other. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** Brain field: negative inside, zero on the surface. The hemispheres stay separated by the fissure. */
function brainField(p: V3): { d: number; part: Part } {
  let cortex = Infinity
  HEMI_PARTS.forEach((parts, i) => {
    const s = i === 0 ? -1 : 1
    let h = Infinity
    for (const e of parts) h = smin(h, ellipsoidDist(p, e), 0.2)
    cortex = Math.min(cortex, Math.max(h, FISSURE - s * p[2]))
  })
  const cb = ellipsoidDist(p, CEREBELLUM)
  const st = ellipsoidDist(p, STEM)
  const part: Part = cortex <= cb && cortex <= st ? "cortex" : cb <= st ? "cerebellum" : "stem"
  return { d: smin(smin(cortex, cb, 0.1), st, 0.12), part }
}

function gradient(p: V3): V3 {
  const e = 1e-3
  const f = (q: V3) => brainField(q).d
  return [
    (f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]])) / (2 * e),
    (f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]])) / (2 * e),
    (f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e])) / (2 * e),
  ]
}

const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

let surfaceCache: SurfacePoint[] | null = null

/** Points spread over the brain's surface, centered and scaled. Computed once, deterministic. */
export function brainSurface(): SurfacePoint[] {
  if (surfaceCache) return surfaceCache
  const rand = seeded(29)
  const raw: SurfacePoint[] = []
  let guard = 0
  while (raw.length < SAMPLES && guard++ < SAMPLES * 4) {
    // A random point, brought back to the surface by a few Newton steps along the gradient.
    let p: V3 = [(rand() - 0.5) * 3, (rand() - 0.55) * 2.8, (rand() - 0.5) * 2.2]
    for (let k = 0; k < 12; k++) {
      const d = brainField(p).d
      const g = gradient(p)
      const g2 = g[0] ** 2 + g[1] ** 2 + g[2] ** 2
      if (g2 < 1e-9) break
      p = [p[0] - (d * g[0]) / g2, p[1] - (d * g[1]) / g2, p[2] - (d * g[2]) / g2]
    }
    const { d, part } = brainField(p)
    if (Math.abs(d) > 2e-3) continue
    // The inner face of a hemisphere (against the fissure) is not visible: nothing is put there.
    if (part === "cortex" && Math.abs(p[2]) < FISSURE + 0.02) continue
    const g = gradient(p)
    const len = Math.hypot(g[0], g[1], g[2]) || 1
    raw.push({ p, n: [g[0] / len, g[1] / len, g[2] / len], part })
  }
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const { p } of raw) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], p[a])
    hi[a] = Math.max(hi[a], p[a])
  }
  const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0]
  const k = (2 * HALF_LENGTH) / (hi[0] - lo[0])
  surfaceCache = raw.map((s) => ({ ...s, p: [(s.p[0] - mid[0]) * k, (s.p[1] - mid[1]) * k, s.p[2] * k] as V3 }))
  return surfaceCache
}

/** Place of each zone on the cortex (indices into the surface), as far apart from each other as possible. */
export function zoneAnchors(n: number): number[] {
  const surface = brainSurface()
  // The top and sides of the cortex, not the underside: that's what you see.
  const eligible = surface.map((s, i) => i).filter((i) => surface[i].part === "cortex" && surface[i].n[1] > -0.45 && Math.abs(surface[i].n[2]) < 0.97)
  if (n <= 0 || eligible.length === 0) return []
  const start: V3 = [HALF_LENGTH * 0.55, HALF_LENGTH * 0.45, HALF_LENGTH * 0.35]
  const first = eligible.reduce((best, i) => (dist2(surface[i].p, start) < dist2(surface[best].p, start) ? i : best), eligible[0])
  const anchors = [first]
  const near = eligible.map((i) => dist2(surface[i].p, surface[first].p))
  while (anchors.length < n) {
    let far = 0
    for (let j = 1; j < eligible.length; j++) if (near[j] > near[far]) far = j
    anchors.push(eligible[far])
    for (let j = 0; j < eligible.length; j++) near[j] = Math.min(near[j], dist2(surface[eligible[j]].p, surface[eligible[far]].p))
  }
  return anchors
}

/** Nearest zone of each surface point (-1 outside the cortex): splits the cortex into territories. */
export function territories(anchors: number[]): number[] {
  const surface = brainSurface()
  return surface.map((s) => {
    if (s.part !== "cortex" || anchors.length === 0) return -1
    let best = 0
    for (let z = 1; z < anchors.length; z++) if (dist2(s.p, surface[anchors[z]].p) < dist2(s.p, surface[anchors[best]].p)) best = z
    return best
  })
}

/** A zone's beads: points of its territory around its place, spaced out, away from the zone center. */
export function zoneNodes(anchors: number[], owner: number[], zone: number, count: number): number[] {
  const surface = brainSurface()
  const a = surface[anchors[zone]].p
  const order = surface.map((_, i) => i).filter((i) => owner[i] === zone && dist2(surface[i].p, a) > 0.06 ** 2)
  order.sort((i, j) => dist2(surface[i].p, a) - dist2(surface[j].p, a))
  const out: number[] = []
  for (const i of order) {
    if (out.length >= count) break
    if (out.some((j) => dist2(surface[i].p, surface[j].p) < 0.075 ** 2)) continue
    out.push(i)
  }
  return out
}

export type BrainNetwork = { points: V3[]; normals: V3[]; zone: number[]; depth: number[]; edges: [number, number][] }

/** Network layers: the surface, then two inner layers, more diffuse, that give volume. */
const LAYERS = [
  { k: 1, spacing: 0.135 },
  { k: 0.72, spacing: 0.17 },
  { k: 0.44, spacing: 0.18 },
]

/**
 * The network that draws the brain: neurons spaced out on the surface and on two inner layers
 * (the surface shrunk toward the core of each part), each linked to its nearest neighbors in the same
 * layer, and each inner neuron linked to the nearest one in the layer above. No link
 * crosses the fissure, so that both hemispheres read.
 */
export function brainNetwork(owner: number[]): BrainNetwork {
  const surface = brainSurface()
  // Core of each part (each hemisphere, cerebellum, brainstem): the inner layers tighten around it.
  const keyOf = (s: SurfacePoint) => (s.part === "cortex" ? (s.p[2] < 0 ? "left" : "right") : s.part)
  const sums = new Map<string, { c: V3; n: number }>()
  for (const s of surface) {
    const acc = sums.get(keyOf(s)) ?? { c: [0, 0, 0] as V3, n: 0 }
    acc.c = [acc.c[0] + s.p[0], acc.c[1] + s.p[1], acc.c[2] + s.p[2]]
    acc.n++
    sums.set(keyOf(s), acc)
  }
  const core = (s: SurfacePoint): V3 => {
    const { c, n } = sums.get(keyOf(s))!
    return [c[0] / n, c[1] / n, c[2] / n]
  }

  const points: V3[] = []
  const normals: V3[] = []
  const zone: number[] = []
  const depth: number[] = []
  const part: Part[] = []
  const layerOf: number[][] = []
  LAYERS.forEach(({ k, spacing }, d) => {
    const mine: number[] = []
    for (let i = 0; i < surface.length; i++) {
      const s = surface[i]
      const c = core(s)
      const p: V3 = [c[0] + (s.p[0] - c[0]) * k, c[1] + (s.p[1] - c[1]) * k, c[2] + (s.p[2] - c[2]) * k]
      if (mine.some((j) => dist2(p, points[j]) < spacing ** 2)) continue
      mine.push(points.length)
      points.push(p)
      normals.push(s.n)
      zone.push(owner[i] ?? -1)
      depth.push(d)
      part.push(s.part)
    }
    layerOf.push(mine)
  })

  const seen = new Set<string>()
  const edges: [number, number][] = []
  const link = (i: number, j: number) => {
    const key = i < j ? `${i}-${j}` : `${j}-${i}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push(i < j ? [i, j] : [j, i])
  }
  const crosses = (i: number, j: number) => part[i] === "cortex" && part[j] === "cortex" && points[i][2] * points[j][2] < 0
  const nearest = (i: number, among: number[], reach: number, count: number) =>
    among
      .map((j) => [j, dist2(points[i], points[j])] as const)
      .filter(([j, d]) => j !== i && d < reach && !crosses(i, j))
      .sort((x, y) => x[1] - y[1])
      .slice(0, count)
  LAYERS.forEach(({ spacing }, d) => {
    for (const i of layerOf[d]) {
      for (const [j] of nearest(i, layerOf[d], (spacing * 2.1) ** 2, 4)) link(i, j)
      if (d > 0) for (const [j] of nearest(i, layerOf[d - 1], (spacing * 3) ** 2, 2)) link(i, j)
    }
  })
  return { points, normals, zone, depth, edges }
}

export type Curves = { positions: Float32Array; a: Uint32Array; b: Uint32Array; t: Float32Array }

/**
 * Curved links: each link is a Bézier arc that bulges along the surface
 * (following it instead of cutting through) and leans slightly sideways, for a rounded, organic line.
 * Rendered as segments: for each vertex, the link's two neurons and the position t along the arc.
 */
export function curveNetwork(net: BrainNetwork, steps = 10): Curves {
  const n = net.edges.length * steps * 2
  const positions = new Float32Array(n * 3)
  const a = new Uint32Array(n)
  const b = new Uint32Array(n)
  const t = new Float32Array(n)
  let v = 0
  net.edges.forEach(([i, j], e) => {
    const A = net.points[i]
    const B = net.points[j]
    const d: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    const nm: V3 = [net.normals[i][0] + net.normals[j][0], net.normals[i][1] + net.normals[j][1], net.normals[i][2] + net.normals[j][2]]
    const nl = Math.hypot(nm[0], nm[1], nm[2]) || 1
    // Sideways: perpendicular to the link, in the plane of the surface; the direction alternates from one link to the next.
    const side: V3 = [d[1] * nm[2] - d[2] * nm[1], d[2] * nm[0] - d[0] * nm[2], d[0] * nm[1] - d[1] * nm[0]]
    const sl = Math.hypot(side[0], side[1], side[2]) || 1
    const bulge = len * 0.2
    const sway = len * (e % 2 === 0 ? 0.16 : -0.16)
    const C: V3 = [0, 1, 2].map((k) => (A[k] + B[k]) / 2 + (nm[k] / nl) * bulge + (side[k] / sl) * sway) as V3
    const at = (u: number): V3 => [0, 1, 2].map((k) => (1 - u) ** 2 * A[k] + 2 * (1 - u) * u * C[k] + u ** 2 * B[k]) as V3
    for (let s = 0; s < steps; s++) {
      for (const u of [s / steps, (s + 1) / steps]) {
        positions.set(at(u), v * 3)
        a[v] = i
        b[v] = j
        t[v] = u
        v++
      }
    }
  })
  return { positions, a, b, t }
}

/**
 * Color of each vertex of the curves: gradient between the colors of its two neurons (`base`, 3 values per
 * neuron), faded toward the background `bg` on the hidden side (`fade` × `back`).
 */
export function shadeCurves(c: Curves, base: Float32Array, fade: Float32Array, back: number, bg: V3, out: Float32Array): void {
  for (let v = 0; v < c.t.length; v++) {
    const i = c.a[v]
    const j = c.b[v]
    const u = c.t[v]
    const f = (fade[i] * (1 - u) + fade[j] * u) * back
    for (let k = 0; k < 3; k++) {
      const col = base[i * 3 + k] * (1 - u) + base[j * 3 + k] * u
      out[v * 3 + k] = col + (bg[k] - col) * f
    }
  }
}

/**
 * Arc between two zones: a Bézier curve bulging outward, stronger for zones
 * far apart, but whose apex never goes past the surface: the arc stays inside the silhouette.
 */
export function arcBetween(a: V3, b: V3, steps = 40): V3[] {
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const m = Math.hypot(mid[0], mid[1], mid[2])
  const dir: V3 = m > 1e-3 ? [mid[0] / m, mid[1] / m, mid[2] / m] : [0, 1, 0]
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const peak = Math.min(0.9 * Math.max(Math.hypot(a[0], a[1], a[2]), Math.hypot(b[0], b[1], b[2])), m + chord * 0.3)
  // The apex of a quadratic Bézier is halfway between the middle of the chord and the control point.
  const C: V3 = [dir[0] * (2 * peak - m), dir[1] * (2 * peak - m), dir[2] * (2 * peak - m)]
  return Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps
    return [0, 1, 2].map((k) => (1 - u) ** 2 * a[k] + 2 * (1 - u) * u * C[k] + u ** 2 * b[k]) as V3
  })
}

/** Links between knowledge items: each linked to its nearest neighbors, whatever their zone. */
export function knowledgeLinks(points: V3[], count = 2, reach = 0.75): [number, number][] {
  const seen = new Set<string>()
  const out: [number, number][] = []
  points.forEach((p, i) => {
    const near = points
      .map((q, j) => [j, dist2(p, q)] as const)
      .filter(([j, d]) => j !== i && d < reach ** 2)
      .sort((x, y) => x[1] - y[1])
      .slice(0, count)
    for (const [j] of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(i < j ? [i, j] : [j, i])
    }
  })
  return out
}

/** Lines (straight or curved) as segments, each as a gradient from `from` to `to`: positions and colors ready for a LineSegments. */
export function gradientSegments(lines: { pts: V3[]; from: number[]; to: number[] }[]): { positions: Float32Array; colors: Float32Array } {
  const n = lines.reduce((sum, l) => sum + (l.pts.length - 1) * 2, 0)
  const positions = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  let v = 0
  for (const { pts, from, to } of lines) {
    for (let k = 0; k < pts.length - 1; k++) {
      for (const m of [k, k + 1]) {
        const u = m / (pts.length - 1)
        positions.set(pts[m], v * 3)
        colors.set([0, 1, 2].map((c) => from[c] + (to[c] - from[c]) * u), v * 3)
        v++
      }
    }
  }
  return { positions, colors }
}

/**
 * Fading of the hidden side: 0 for a neuron facing the camera, 1 for a neuron facing away.
 * `cam` is the camera position in the brain's frame.
 */
export function backFade(net: BrainNetwork, cam: V3, out: Float32Array): void {
  for (let i = 0; i < net.points.length; i++) {
    const p = net.points[i]
    const n = net.normals[i]
    const vx = cam[0] - p[0]
    const vy = cam[1] - p[1]
    const vz = cam[2] - p[2]
    const facing = (n[0] * vx + n[1] * vy + n[2] * vz) / (Math.hypot(vx, vy, vz) || 1)
    const t = Math.min(1, Math.max(0, (0.3 - facing) / 0.45))
    out[i] = t * t * (3 - 2 * t)
  }
}

/** Neighboring direction, to scatter points around a direction. */
export function scatter(dir: [number, number, number], rand: () => number, spread: number): [number, number, number] {
  const v: [number, number, number] = [dir[0] + (rand() - 0.5) * spread, dir[1] + (rand() - 0.5) * spread, dir[2] + (rand() - 0.5) * spread]
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}
