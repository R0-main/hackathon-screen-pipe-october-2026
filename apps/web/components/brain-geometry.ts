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

// --- Cerveau 3D : positions sur la coque (partagées par le dashboard et la page d'accueil) ---

/** Direction de la i-ème zone sur la coque (spirale de Fibonacci, aplatie en hauteur comme un cerveau). */
export function zoneDirection(i: number, n: number): [number, number, number] {
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n)
  const theta = Math.PI * (1 + Math.sqrt(5)) * i + Math.PI / 2
  const v: [number, number, number] = [Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.75, Math.sin(phi) * Math.sin(theta)]
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

/** Direction voisine, pour disperser les billes d'une zone autour de son centre. */
export function scatter(dir: [number, number, number], rand: () => number, spread: number): [number, number, number] {
  const v: [number, number, number] = [dir[0] + (rand() - 0.5) * spread, dir[1] + (rand() - 0.5) * spread, dir[2] + (rand() - 0.5) * spread]
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}
