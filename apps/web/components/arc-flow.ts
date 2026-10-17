// The flow between zones, shared by the dashboard brain and the home page brain: tube arcs, in which small light
// beads flow, the arc swelling slightly around each one.

import type * as THREE from "three"
import { hashString } from "./brain-geometry"

type ThreeModule = typeof import("three")

/** Enough rings for the arc to swell gently around a bead no longer than two or three of them. */
const TUBULAR = 384
const RADIAL = 6
/**
 * The beads: per direction and per arc, their number; their speed (in arc turns per second); their radius, relative to
 * the arc's (under 1: they stay inside the line); their share of white, which makes them stand out on its color.
 */
const BEADS_PER_WAY = 4
const BEAD_SPEED = 0.1
const BEAD_R = 0.6
const BEAD_LIGHT = 0.88
/** Stretch of the beads along the arc: their length is BEAD_STRETCH times their width. */
const BEAD_STRETCH = 3
/** Swelling of the arc around each bead: radius added at the bead's core, as a share of the arc's radius. */
const BEAD_BULGE = 0.55
/** Speed-up of the beads on the arc of an active zone. */
const FAST = 1.8

/** An arc between two zones, with what it takes to make beads flow in it and make it swell. */
export type FlowArc = {
  curve: THREE.CatmullRomCurve3
  from: THREE.Color
  to: THREE.Color
  radius: number
  /** Starting offset of the beads, specific to each arc: they don't all start together. */
  phase: number
  /** The tube: center of each ring, and direction of each vertex from that center. */
  tube: THREE.BufferAttribute
  rings: Float32Array
  spokes: Float32Array
  length: number
  /** To set by the caller on each frame: faster beads (active zone), strength of the swelling (0 to 1). */
  fast: boolean
  gain: number
}

/** An arc's tube, as a gradient from one zone's color to the other's, ready to swell around its beads. */
export function arcTube(T: ThreeModule, pts: THREE.Vector3[], from: THREE.Color, to: THREE.Color, radius: number, key: string) {
  const curve = new T.CatmullRomCurve3(pts)
  const geo = new T.TubeGeometry(curve, TUBULAR, radius, RADIAL, false)
  const tube = geo.attributes.position as THREE.BufferAttribute
  const cols = new Float32Array(tube.count * 3)
  const tone = new T.Color()
  // The tube's vertices go ring by ring: the ring gives the position along the arc.
  for (let v = 0; v < tube.count; v++) tone.copy(from).lerp(to, Math.floor(v / (RADIAL + 1)) / TUBULAR).toArray(cols, v * 3)
  geo.setAttribute("color", new T.BufferAttribute(cols, 3))
  // Each ring is centered on the arc (at the same point as TubeGeometry); each vertex leaves it in a fixed
  // direction: the swelling pushes it further that way.
  const rings = new Float32Array((TUBULAR + 1) * 3)
  const spokes = new Float32Array(tube.count * 3)
  const at = new T.Vector3()
  for (let ring = 0; ring <= TUBULAR; ring++) {
    curve.getPointAt(ring / TUBULAR, at).toArray(rings, ring * 3)
    for (let k = 0; k <= RADIAL; k++) {
      const v = ring * (RADIAL + 1) + k
      for (let c = 0; c < 3; c++) spokes[v * 3 + c] = (tube.array[v * 3 + c] - rings[ring * 3 + c]) / radius
    }
  }
  const arc: FlowArc = { curve, from, to, radius, phase: (hashString(key) % 1000) / 1000, tube, rings, spokes, length: curve.getLength(), fast: false, gain: 1 }
  return { geo, arc }
}

/**
 * The light beads of all arcs, in a single mesh: in each arc, small beads go from A to B and others from B to A,
 * continuously and evenly spaced. Each takes the arc's color where it passes, much lightened; they shrink until they
 * disappear when reaching a zone. Drawn after the arcs (transparent), they show inside the line instead of being
 * tinted by it.
 */
export function arcBeads(T: ThreeModule, arcs: FlowArc[]) {
  const geometry = new T.SphereGeometry(1, 12, 8)
  const material = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false })
  const total = arcs.length * BEADS_PER_WAY * 2
  const mesh = new T.InstancedMesh(geometry, material, Math.max(1, total))
  mesh.count = total
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  const white = new T.Color(0xffffff)
  const tone = new T.Color()
  const mtx = new T.Matrix4()
  const at = new T.Vector3()
  const dir = new T.Vector3()
  const turn = new T.Quaternion()
  const size = new T.Vector3()
  const axis = new T.Vector3(0, 0, 1)
  const on: { u: number; half: number; size: number }[] = []

  /** The arc swells slightly around each bead, over the bead's own length: a soft bump that follows it. */
  const bulge = (a: FlowArc) => {
    const arr = a.tube.array as Float32Array
    for (let ring = 0; ring <= TUBULAR; ring++) {
      const u = ring / TUBULAR
      let swell = 0
      for (const b of on) {
        if (b.half <= 0) continue
        const x = (u - b.u) / (b.half * 1.3)
        if (x > -3 && x < 3) swell = Math.max(swell, Math.exp(-x * x) * b.size)
      }
      const radius = a.radius * (1 + BEAD_BULGE * swell * a.gain)
      for (let k = 0; k <= RADIAL; k++) {
        const v = (ring * (RADIAL + 1) + k) * 3
        for (let c = 0; c < 3; c++) arr[v + c] = a.rings[ring * 3 + c] + a.spokes[v + c] * radius
      }
    }
    a.tube.needsUpdate = true
  }

  /** One frame of the flow, `time` in seconds. */
  const frame = (time: number) => {
    let n = 0
    for (const a of arcs) {
      const run = time * BEAD_SPEED * (a.fast ? FAST : 1) + a.phase
      on.length = 0
      for (let j = 0; j < BEADS_PER_WAY * 2; j++) {
        // Even beads go from A to B, odd ones from B to A; each direction is offset by half a bead.
        const along = (run + Math.floor(j / 2) / BEADS_PER_WAY + (j % 2) * (0.5 / BEADS_PER_WAY)) % 1
        const u = j % 2 === 0 ? along : 1 - along
        a.curve.getPointAt(u, at)
        // Stretched along the arc: its long axis follows the tangent at the point where it passes.
        a.curve.getTangentAt(u, dir)
        turn.setFromUnitVectors(axis, dir)
        const fade = Math.min(1, u / 0.1, (1 - u) / 0.1)
        const r = a.radius * BEAD_R * fade
        mesh.setMatrixAt(n, mtx.compose(at, turn, size.set(r, r, r * BEAD_STRETCH)))
        mesh.setColorAt(n, tone.copy(a.from).lerp(a.to, u).lerp(white, BEAD_LIGHT))
        on.push({ u, half: (r * BEAD_STRETCH) / a.length, size: fade })
        n++
      }
      bulge(a)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  const dispose = () => {
    mesh.dispose()
    geometry.dispose()
    material.dispose()
  }
  return { mesh, material, frame, dispose }
}
