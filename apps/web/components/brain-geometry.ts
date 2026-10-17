// Géométrie du cerveau (vue de dessus) : deux hémisphères, circonvolutions, et découpage en zones (Voronoï).
// Tout est déterministe (graine) pour que le rendu serveur et le rendu client soient identiques.

export type Pt = [number, number]

/**
 * Arrondi au centième. Math.cos/sin peuvent différer au dernier bit entre Node (rendu serveur) et le navigateur :
 * on arrondit à la source, la suite des calculs (arithmétique IEEE) donne alors le même résultat des deux côtés.
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

/** Point du contour d'un hémisphère pour l'angle t (bosses optionnelles). */
function hemiPoint(h: Hemisphere, t: number, bumps: number, scale = 1): Pt {
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const outward = h.side === "left" ? cos < 0 : cos > 0
  let rx = outward ? h.rxOuter : h.rxInner
  // Lobe frontal (haut) un peu plus étroit.
  rx *= 1 - 0.13 * Math.max(0, -sin)
  const phase = h.side === "left" ? 0.4 : 2.1
  const r = 1 + bumps * (0.03 * Math.sin(9 * t + phase) + 0.018 * Math.sin(15 * t + phase * 2) + 0.009 * Math.sin(27 * t))
  return roundPt([h.cx + rx * r * scale * cos, h.cy + h.ry * r * scale * sin])
}

export function hemispherePolygon(h: Hemisphere, n = 140, bumps = 1, scale = 1): Pt[] {
  return Array.from({ length: n }, (_, i) => hemiPoint(h, (i / n) * Math.PI * 2, bumps, scale))
}

/** Chemin lissé (Catmull-Rom → Bézier) passant par des points, fermé ou non. */
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

/** Circonvolutions : courbes ondulées à l'intérieur de chaque hémisphère. */
export function gyriPaths(h: Hemisphere, count = 22, seed = 7): string[] {
  const rand = seeded(seed + (h.side === "left" ? 0 : 1000))
  const inner = hemispherePolygon(h, 60, 0, 0.92)
  const out: string[] = []
  // Contours concentriques qui épousent la forme.
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

/** Découpe un polygone par le demi-plan a·x + b·y ≤ c (Sutherland–Hodgman). */
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

/** Découpe un polygone par un polygone convexe (sens quelconque). */
function clipConvex(poly: Pt[], clip: Pt[]): Pt[] {
  // Orientation du polygone de découpe.
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
    // Intérieur : produit vectoriel du même signe que l'orientation.
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

/** Répartit les zones sur les deux hémisphères et calcule leurs cellules (Voronoï restreint à chaque hémisphère). */
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

/** Positions des « neurones » (entités) d'une zone, à l'écart du libellé. */
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
    // Pas trop près du bord ni des autres neurones.
    const shrunk: Pt = [cell.center[0] + (p[0] - cell.center[0]) * 1.12, cell.center[1] + (p[1] - cell.center[1]) * 1.12]
    if (!pointInPolygon(shrunk, cell.polygon)) continue
    if (pts.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < 26 ** 2)) continue
    pts.push(p)
  }
  return pts.map(roundPt)
}

// --- Cerveau 3D : forme, réseau de liaisons et places des zones (partagés par le dashboard et la page d'accueil) ---
// Repère : x d'arrière en avant (front en +x), y de bas en haut, z de gauche à droite. Vu le long de z, on a le profil.

export type V3 = [number, number, number]
type Ellipsoid = { c: V3; r: V3 }
type Part = "cortex" | "cerebellum" | "stem"
export type SurfacePoint = { p: V3; n: V3; part: Part }

/** Demi-longueur du cerveau une fois mis à l'échelle (même encombrement que l'ancienne coque). */
const HALF_LENGTH = 1.6
const FISSURE = 0.035
const SAMPLES = 2600

/** Un hémisphère : masse, lobe frontal, lobe occipital, lobe temporal qui descend sur le côté. */
const hemisphere = (s: number): Ellipsoid[] => [
  { c: [0.0, 0.22, s * 0.46], r: [1.15, 0.72, 0.5] },
  { c: [0.6, 0.14, s * 0.43], r: [0.66, 0.6, 0.45] },
  { c: [-0.86, 0.12, s * 0.41], r: [0.5, 0.55, 0.41] },
  { c: [0.12, -0.36, s * 0.55], r: [0.7, 0.32, 0.36] },
]
const HEMI_PARTS = [hemisphere(-1), hemisphere(1)]
const CEREBELLUM: Ellipsoid = { c: [-0.74, -0.5, 0], r: [0.44, 0.27, 0.7] }
const STEM: Ellipsoid = { c: [-0.24, -0.82, 0], r: [0.17, 0.46, 0.17] }

/** Distance signée approchée à un ellipsoïde. */
function ellipsoidDist(p: V3, e: Ellipsoid): number {
  const x = p[0] - e.c[0]
  const y = p[1] - e.c[1]
  const z = p[2] - e.c[2]
  const k0 = Math.hypot(x / e.r[0], y / e.r[1], z / e.r[2])
  const k1 = Math.hypot(x / e.r[0] ** 2, y / e.r[1] ** 2, z / e.r[2] ** 2)
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(...e.r)
}

/** Union adoucie : les lobes se fondent l'un dans l'autre. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** Champ du cerveau : négatif dedans, nul sur la surface. Les hémisphères restent séparés par la scissure. */
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

/** Points répartis sur la surface du cerveau, centrés et mis à l'échelle. Calculés une fois, déterministes. */
export function brainSurface(): SurfacePoint[] {
  if (surfaceCache) return surfaceCache
  const rand = seeded(29)
  const raw: SurfacePoint[] = []
  let guard = 0
  while (raw.length < SAMPLES && guard++ < SAMPLES * 4) {
    // Un point au hasard, ramené sur la surface par quelques pas de Newton le long du gradient.
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
    // La face interne d'un hémisphère (contre la scissure) ne se voit pas : on n'y met rien.
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

/** Place de chaque zone sur le cortex (indices dans la surface), aussi éloignées que possible les unes des autres. */
export function zoneAnchors(n: number): number[] {
  const surface = brainSurface()
  // Le dessus et les flancs du cortex, pas le dessous : c'est ce qu'on voit.
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

/** Zone la plus proche de chaque point de surface (-1 hors du cortex) : découpe le cortex en territoires. */
export function territories(anchors: number[]): number[] {
  const surface = brainSurface()
  return surface.map((s) => {
    if (s.part !== "cortex" || anchors.length === 0) return -1
    let best = 0
    for (let z = 1; z < anchors.length; z++) if (dist2(s.p, surface[anchors[z]].p) < dist2(s.p, surface[anchors[best]].p)) best = z
    return best
  })
}

/** Billes d'une zone : des points de son territoire autour de sa place, espacés, à l'écart du centre de zone. */
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

export type BrainNetwork = { points: V3[]; normals: V3[]; zone: number[]; edges: [number, number][] }

/**
 * Le réseau qui dessine la silhouette : des neurones espacés sur toute la surface, chacun relié à ses
 * plus proches voisins. Aucune liaison ne traverse la scissure, pour que les deux hémisphères se lisent.
 */
export function brainNetwork(owner: number[], spacing = 0.15): BrainNetwork {
  const surface = brainSurface()
  const picked: number[] = []
  for (let i = 0; i < surface.length; i++) {
    if (picked.some((j) => dist2(surface[i].p, surface[j].p) < spacing ** 2)) continue
    picked.push(i)
  }
  const points = picked.map((i) => surface[i].p)
  const normals = picked.map((i) => surface[i].n)
  const zone = picked.map((i) => owner[i] ?? -1)
  const part = picked.map((i) => surface[i].part)
  const seen = new Set<string>()
  const edges: [number, number][] = []
  const reach = (spacing * 2.1) ** 2
  for (let i = 0; i < points.length; i++) {
    const near = points
      .map((q, j) => [j, dist2(points[i], q)] as const)
      .filter(([j, d]) => j !== i && d < reach && !(part[i] === "cortex" && part[j] === "cortex" && points[i][2] * points[j][2] < 0))
      .sort((x, y) => x[1] - y[1])
      .slice(0, 3)
    for (const [j] of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(i < j ? [i, j] : [j, i])
    }
  }
  return { points, normals, zone, edges }
}

/**
 * Estompe de la face cachée : 0 pour un neurone tourné vers la caméra, 1 pour un neurone de dos.
 * `cam` est la position de la caméra dans le repère du cerveau.
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

/** Direction voisine, pour disperser des points autour d'une direction. */
export function scatter(dir: [number, number, number], rand: () => number, spread: number): [number, number, number] {
  const v: [number, number, number] = [dir[0] + (rand() - 0.5) * spread, dir[1] + (rand() - 0.5) * spread, dir[2] + (rand() - 0.5) * spread]
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}
