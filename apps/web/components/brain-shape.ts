// Forme 3D du cerveau : un nuage de neurones posés sur deux hémisphères à circonvolutions, un cervelet
// et un tronc cérébral, reliés à leurs plus proches voisins. Tout est déterministe (graine) : même forme
// à chaque rendu. Repère : x = gauche/droite, y = haut, z = avant (front) / arrière (occiput).

import { seeded } from "./brain-geometry"

export type V3 = [number, number, number]
export type BrainPart = "cortex-l" | "cortex-r" | "cereb-l" | "cereb-r" | "stem"

export type BrainShape = {
  /** Positions des neurones (x, y, z à la suite). */
  positions: Float32Array
  /** Normale approchée (vers l'extérieur) de chaque neurone. */
  normals: Float32Array
  part: BrainPart[]
  /** Liaisons : paires d'indices de neurones (a, b à la suite). */
  edges: Uint32Array
  /** Voisins de chaque neurone dans le graphe des liaisons. */
  adjacency: number[][]
}

const TAU = Math.PI * 2

/** Direction uniforme sur la sphère. */
function unitDir(rand: () => number): V3 {
  const z = rand() * 2 - 1
  const t = rand() * TAU
  const r = Math.sqrt(1 - z * z)
  return [r * Math.cos(t), z, r * Math.sin(t)]
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Un point du cortex de l'hémisphère s (−1 gauche, +1 droite). */
function cortexPoint(s: number, u: V3): { p: V3; n: V3 } {
  const lateral = Math.max(0, u[0] * s)
  // Ellipsoïde allongé d'avant en arrière, face interne aplatie (la scissure entre les hémisphères).
  let x = u[0] * (u[0] * s < 0 ? 0.2 : 0.72)
  let y = u[1] * 0.8
  let z = u[2] * 1.28
  // Dessous plus plat, sauf le lobe temporal qui descend sur le côté, en avant du milieu.
  if (u[1] < 0) {
    const temporal = lateral * Math.exp(-(((u[2] - 0.15) / 0.55) ** 2))
    y *= 0.5 + 0.55 * temporal
  }
  // Front un peu plus bas, occiput un peu plus étroit.
  if (u[2] > 0) y *= 1 - 0.14 * u[2]
  else x *= 1 - 0.12 * -u[2]
  // Circonvolutions : une ondulation radiale qui dessine des plis.
  const fold = 1 + 0.05 * Math.sin(10 * z + 3.2 * Math.sin(6 * y + 2 * x)) * Math.cos(8 * y - 2.5 * z)
  x *= fold
  y *= fold
  z *= fold
  return { p: [s * 0.26 + x, 0.12 + y, z], n: norm([x, y * 1.4, z * 0.8]) }
}

/** Un point du cervelet (sous l'arrière du cerveau), côté s. */
function cerebPoint(s: number, u: V3): { p: V3; n: V3 } {
  let x = u[0] * (u[0] * s < 0 ? 0.12 : 0.4)
  let y = u[1] * 0.27
  const z = u[2] * 0.34
  // Plis horizontaux serrés, typiques du cervelet.
  const fold = 1 + 0.06 * Math.sin(30 * y)
  x *= fold
  y *= fold
  return { p: [s * 0.16 + x, -0.6 + y, -0.82 + z * fold], n: norm([x, y, z]) }
}

/** Un point du tronc cérébral : un cylindre incliné vers l'arrière qui descend sous le cerveau. */
function stemPoint(rand: () => number): { p: V3; n: V3 } {
  const t = rand()
  const a = rand() * TAU
  const r = 0.15 - 0.03 * t
  const cx = 0
  const cy = -0.3 - 0.95 * t
  const cz = -0.3 - 0.22 * t
  const n: V3 = [Math.cos(a), 0, Math.sin(a)]
  return { p: [cx + n[0] * r, cy, cz + n[2] * r], n }
}

const COUNTS = { cortex: 1350, cereb: 330, stem: 170 }
const K = 3
const MAX_EDGE = 0.2

export function buildBrainShape(seed = 42): BrainShape {
  const rand = seeded(seed)
  const pts: V3[] = []
  const nrm: V3[] = []
  const part: BrainPart[] = []
  const push = (q: { p: V3; n: V3 }, pp: BrainPart) => {
    pts.push(q.p)
    nrm.push(q.n)
    part.push(pp)
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < COUNTS.cortex; i++) push(cortexPoint(s, unitDir(rand)), s < 0 ? "cortex-l" : "cortex-r")
    for (let i = 0; i < COUNTS.cereb; i++) {
      const u = unitDir(rand)
      // Le cervelet est caché en haut par le cortex : on n'y met pas de neurones.
      if (u[1] > 0.55) continue
      push(cerebPoint(s, u), s < 0 ? "cereb-l" : "cereb-r")
    }
  }
  for (let i = 0; i < COUNTS.stem; i++) push(stemPoint(rand), "stem")

  // Liaisons : chaque neurone vers ses K plus proches voisins de la même structure.
  const n = pts.length
  const seen = new Set<number>()
  const edges: number[] = []
  const adjacency: number[][] = Array.from({ length: n }, () => [])
  const link = (a: number, b: number) => {
    const key = a < b ? a * n + b : b * n + a
    if (seen.has(key)) return
    seen.add(key)
    edges.push(a, b)
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  const best: { j: number; d: number }[] = []
  for (let i = 0; i < n; i++) {
    best.length = 0
    const [ax, ay, az] = pts[i]
    for (let j = 0; j < n; j++) {
      if (j === i || part[j] !== part[i]) continue
      const dx = pts[j][0] - ax
      const dy = pts[j][1] - ay
      const dz = pts[j][2] - az
      const d = dx * dx + dy * dy + dz * dz
      if (d > MAX_EDGE * MAX_EDGE) continue
      if (best.length < K) best.push({ j, d })
      else if (d < best[K - 1].d) best[K - 1] = { j, d }
      else continue
      best.sort((p, q) => p.d - q.d)
    }
    for (const b of best) link(i, b.j)
  }

  // Corps calleux : quelques faisceaux qui traversent la scissure entre les deux hémisphères.
  const medial = (pp: BrainPart) => pts.map((p, i) => i).filter((i) => part[i] === pp && Math.abs(pts[i][0]) < 0.12 && pts[i][1] > -0.05)
  const left = medial("cortex-l")
  const right = medial("cortex-r")
  for (const i of left) {
    if (rand() > 0.35) continue
    let bj = -1
    let bd = Infinity
    for (const j of right) {
      const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1], pts[j][2] - pts[i][2])
      if (d < bd) [bd, bj] = [d, j]
    }
    if (bj >= 0 && bd < 0.35) link(i, bj)
  }
  // Le tronc rejoint le dessous du cerveau et le cervelet.
  const stem = pts.map((p, i) => i).filter((i) => part[i] === "stem")
  const top = stem.filter((i) => pts[i][1] > -0.4)
  const brainBase = pts.map((p, i) => i).filter((i) => part[i] !== "stem" && pts[i][1] < -0.25 && Math.abs(pts[i][0]) < 0.45 && Math.abs(pts[i][2] + 0.35) < 0.5)
  for (const i of top) {
    let bj = -1
    let bd = Infinity
    for (const j of brainBase) {
      const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1], pts[j][2] - pts[i][2])
      if (d < bd) [bd, bj] = [d, j]
    }
    if (bj >= 0 && bd < 0.3) link(i, bj)
  }

  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions.set(pts[i], i * 3)
    normals.set(nrm[i], i * 3)
  }
  return { positions, normals, part, edges: Uint32Array.from(edges), adjacency }
}

/**
 * Points d'ancrage des zones, dans l'ordre où on les distribue : on alterne les lobes et les côtés
 * pour que quelques zones suffisent à colorer tout le cerveau.
 */
export const ZONE_ANCHORS: V3[] = [
  [-0.55, 0.45, 0.95], // frontal gauche
  [0.6, 0.7, -0.3], // pariétal droit
  [-0.95, -0.2, 0.2], // temporal gauche
  [0.45, 0.25, -1.15], // occipital droit
  [0.55, 0.45, 0.95], // frontal droit
  [-0.6, 0.7, -0.3], // pariétal gauche
  [0.95, -0.2, 0.2], // temporal droit
  [-0.45, 0.25, -1.15], // occipital gauche
  [0, -0.65, -1.05], // cervelet
  [-0.3, 0.9, 0.35], // sommet gauche
  [0.3, 0.9, 0.35], // sommet droit
  [0, -0.95, -0.45], // tronc
]

/** Ancrage de la i-ème zone : la liste ci-dessus, puis une spirale sur l'enveloppe au-delà. */
export function zoneAnchor(i: number, n: number): V3 {
  if (i < ZONE_ANCHORS.length) return ZONE_ANCHORS[i]
  const phi = Math.acos(1 - (2 * (i + 0.5)) / Math.max(n, i + 1))
  const theta = Math.PI * (1 + Math.sqrt(5)) * i
  return [Math.sin(phi) * Math.cos(theta) * 0.95, Math.cos(phi) * 0.8, Math.sin(phi) * Math.sin(theta) * 1.3]
}
