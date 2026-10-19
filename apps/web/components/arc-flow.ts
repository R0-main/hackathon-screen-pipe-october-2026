// The flow between zones, shared by the dashboard brain and the home page brain: tube arcs, in which glossy beads of
// light flow, each with a soft halo and a comet tail, the arc swelling and lighting up in its color as they pass.

import type * as THREE from "three"
import { hashString } from "./brain-geometry"

type ThreeModule = typeof import("three")

/** Enough rings for the arc to swell gently around a bead no longer than two or three of them. */
const TUBULAR = 384
const RADIAL = 6
/**
 * The beads: per direction and per arc, their number; their speed (in arc turns per second); their radius, relative to
 * the arc's (well over 1: a pearl threaded on the line).
 */
const BEADS_PER_WAY = 4
const BEAD_SPEED = 0.1
const BEAD_R = 3.4
/** Stretch of the beads along the arc: their length is BEAD_STRETCH times their width (barely: they stay round). */
const BEAD_STRETCH = 1.35
/** Swelling of the arc around each bead: radius added at the bead's core, as a share of the arc's radius. */
const BEAD_BULGE = 0.55
/** Speed-up of the beads on the arc of an active zone. */
const FAST = 1.8
/** The halo around each bead (radius, relative to the bead's) and its strength. */
const HALO = 2.6
const HALO_ALPHA = 0.75
/** The comet tail: glows trailing behind the bead along the arc, each a bit smaller and fainter, `TAIL_STEP` bead lengths apart. */
const TAIL = 6
const TAIL_STEP = 0.9
const TAIL_ALPHA = 0.55
/** The wake: how far behind the bead the arc stays lit (in bead lengths), and how much it takes the bead's color. */
const WAKE = 9
const WAKE_LIGHT = 0.85

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
  /** The tube's colors: at rest and lit (the beads' color), per ring; the attribute the wake paints. */
  paint: THREE.BufferAttribute
  rest: Float32Array
  lit: Float32Array
  length: number
  /** To set by the caller on each frame: faster beads (active zone), strength of the swelling (0 to 1). */
  fast: boolean
  gain: number
}

/** A color made vivid, the way light shows it: more saturated, at mid lightness. Grays stay gray. */
const vivid = (c: THREE.Color, out: THREE.Color) => {
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  return out.setHSL(hsl.h, hsl.s < 0.05 ? hsl.s : Math.min(1, hsl.s * 1.25 + 0.15), hsl.s < 0.05 ? 0.6 : Math.min(0.56, Math.max(0.44, hsl.l)))
}

/** An arc's tube, as a gradient from one zone's color to the other's, ready to swell around its beads. */
export function arcTube(T: ThreeModule, pts: THREE.Vector3[], from: THREE.Color, to: THREE.Color, radius: number, key: string) {
  const curve = new T.CatmullRomCurve3(pts)
  const geo = new T.TubeGeometry(curve, TUBULAR, radius, RADIAL, false)
  const tube = geo.attributes.position as THREE.BufferAttribute
  const tone = new T.Color()
  const rest = new Float32Array((TUBULAR + 1) * 3)
  const lit = new Float32Array((TUBULAR + 1) * 3)
  const vFrom = vivid(from, new T.Color())
  const vTo = vivid(to, new T.Color())
  for (let ring = 0; ring <= TUBULAR; ring++) {
    tone.copy(from).lerp(to, ring / TUBULAR).toArray(rest, ring * 3)
    tone.copy(vFrom).lerp(vTo, ring / TUBULAR).toArray(lit, ring * 3)
  }
  // The tube's vertices go ring by ring: the ring gives the position along the arc.
  const cols = new Float32Array(tube.count * 3)
  for (let v = 0; v < tube.count; v++) for (let c = 0; c < 3; c++) cols[v * 3 + c] = rest[Math.floor(v / (RADIAL + 1)) * 3 + c]
  const paint = new T.BufferAttribute(cols, 3)
  geo.setAttribute("color", paint)
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
  const arc: FlowArc = { curve, from, to, radius, phase: (hashString(key) % 1000) / 1000, tube, rings, spokes, paint, rest, lit, length: curve.getLength(), fast: false, gain: 1 }
  return { geo, arc }
}

// The scene's fog, at a third of its strength: the far beads recede a little, without the white washing out their shine.
const FAINT_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * 0.35);
#endif`

// The bead: a glass pearl lit from within. Its color deepens at the rim and whitens at the heart, a glint catches the
// light (top left, toward the viewer) and a thin rim of light outlines it. Normals follow the bead's stretch.
const PEARL_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vTone;
varying vec3 vNormalV;
varying vec3 vViewV;
void main() {
  vTone = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTone = instanceColor;
  #endif
  vec3 s = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  mat4 mv = modelViewMatrix * instanceMatrix;
  vNormalV = normalize(mat3(mv) * (normal / max(s * s, vec3(1e-12))));
  vec4 mvPosition = mv * vec4(position, 1.0);
  vViewV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const PEARL_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float opacity;
varying vec3 vTone;
varying vec3 vNormalV;
varying vec3 vViewV;
void main() {
  vec3 n = normalize(vNormalV);
  vec3 v = normalize(vViewV);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  vec3 color = mix(vTone * 0.6, mix(vTone, vec3(1.0), 0.25), pow(facing, 1.2));
  vec3 h = normalize(normalize(vec3(-0.45, 0.65, 0.6)) + v);
  color += pow(max(dot(n, h), 0.0), 60.0) * 1.2;
  color += mix(vTone, vec3(1.0), 0.6) * pow(1.0 - facing, 3.0) * 0.6;
  gl_FragColor = vec4(min(color, vec3(1.0)), opacity);
  #include <colorspace_fragment>
  ${FAINT_FOG}
}`

// The halo and the tail: soft discs always facing the screen, in the bead's color with a pale heart.
const GLOW_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float glow;
varying vec3 vTone;
varying float vGlow;
varying vec2 vAt;
void main() {
  vTone = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTone = instanceColor;
  #endif
  vGlow = glow;
  vAt = position.xy * 2.0;
  mat4 mv = modelViewMatrix * instanceMatrix;
  vec4 mvPosition = mv * vec4(0.0, 0.0, 0.0, 1.0);
  mvPosition.xy += position.xy * 2.0 * length(mv[0].xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const GLOW_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float opacity;
varying vec3 vTone;
varying float vGlow;
varying vec2 vAt;
void main() {
  float d2 = dot(vAt, vAt);
  if (d2 >= 1.0) discard;
  float a = exp(-d2 * 4.5) * (1.0 - d2);
  vec3 color = mix(vTone, vec3(1.0), exp(-d2 * 40.0) * 0.35);
  gl_FragColor = vec4(color, a * vGlow * opacity);
  #include <colorspace_fragment>
  ${FAINT_FOG}
}`

/**
 * The beads of light of all arcs: in each arc, beads go from A to B and others from B to A, continuously and evenly
 * spaced. Each takes the arc's color where it passes, made vivid; they shrink until they disappear when reaching a
 * zone. Three layers, drawn after the arcs (transparent) so they show over the line instead of being tinted by it: the
 * arc's own wake (its color lit up behind each bead), the glows (halo and comet tail), then the pearls themselves.
 */
export function arcBeads(T: ThreeModule, arcs: FlowArc[]) {
  const total = arcs.length * BEADS_PER_WAY * 2
  const glows = total * (1 + TAIL)
  const shared = { opacity: { value: 1 }, ...T.UniformsLib.fog }

  const pearlGeo = new T.SphereGeometry(1, 20, 14)
  const pearlMat = new T.ShaderMaterial({ uniforms: shared, vertexShader: PEARL_VERTEX, fragmentShader: PEARL_FRAGMENT, transparent: true, depthWrite: false, fog: true })
  const pearls = new T.InstancedMesh(pearlGeo, pearlMat, Math.max(1, total))
  pearls.count = total
  pearls.instanceColor = new T.InstancedBufferAttribute(new Float32Array(Math.max(1, total) * 3), 3)

  const glowGeo = new T.PlaneGeometry(1, 1)
  const glowAlpha = new T.InstancedBufferAttribute(new Float32Array(Math.max(1, glows)), 1)
  glowGeo.setAttribute("glow", glowAlpha)
  const glowMat = new T.ShaderMaterial({ uniforms: shared, vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT, transparent: true, depthWrite: false, fog: true })
  const halos = new T.InstancedMesh(glowGeo, glowMat, Math.max(1, glows))
  halos.count = glows
  halos.instanceColor = new T.InstancedBufferAttribute(new Float32Array(Math.max(1, glows) * 3), 3)

  const mesh = new T.Group()
  mesh.add(halos, pearls)
  for (const m of [halos, pearls]) m.frustumCulled = false
  /** Draw order of the flow: the glows at `n`, the pearls just after them. */
  const order = (n: number) => {
    halos.renderOrder = n
    pearls.renderOrder = n + 0.01
  }
  order(2)

  const tone = new T.Color()
  const mtx = new T.Matrix4()
  const at = new T.Vector3()
  const dir = new T.Vector3()
  const turn = new T.Quaternion()
  const still = new T.Quaternion()
  const size = new T.Vector3()
  const axis = new T.Vector3(0, 0, 1)
  /** The beads of the arc being drawn: place along it, direction of travel, half-length (in arc turns), size. */
  const on: { u: number; way: number; half: number; size: number }[] = []

  /** The arc's color at `u`, lit (the beads') or at rest. */
  const colorAt = (a: FlowArc, u: number, out: THREE.Color) => {
    const ring = Math.min(TUBULAR, Math.max(0, Math.round(u * TUBULAR))) * 3
    return out.fromArray(a.lit, ring)
  }

  /**
   * The arc swells slightly around each bead, over the bead's own length, and lights up in its color: brightest at the
   * bead, a long wake behind it, almost nothing ahead.
   */
  const bulge = (a: FlowArc) => {
    const arr = a.tube.array as Float32Array
    const cols = a.paint.array as Float32Array
    for (let ring = 0; ring <= TUBULAR; ring++) {
      const u = ring / TUBULAR
      let swell = 0
      let light = 0
      for (const b of on) {
        if (b.half <= 0) continue
        const x = ((u - b.u) * b.way) / (b.half * 1.3)
        if (x > -3 && x < 3) swell = Math.max(swell, Math.exp(-x * x) * b.size)
        const behind = x < 0 ? Math.exp(x / WAKE) : Math.exp(-x * x * 2)
        if (x > -WAKE * 4 && x < 2) light = Math.max(light, behind * b.size)
      }
      const radius = a.radius * (1 + BEAD_BULGE * swell * a.gain)
      const lit = light * WAKE_LIGHT * a.gain
      for (let k = 0; k <= RADIAL; k++) {
        const v = (ring * (RADIAL + 1) + k) * 3
        for (let c = 0; c < 3; c++) {
          arr[v + c] = a.rings[ring * 3 + c] + a.spokes[v + c] * radius
          cols[v + c] = a.rest[ring * 3 + c] + (a.lit[ring * 3 + c] - a.rest[ring * 3 + c]) * lit
        }
      }
    }
    a.tube.needsUpdate = true
    a.paint.needsUpdate = true
  }

  /** One frame of the flow, `time` in seconds. */
  const frame = (time: number) => {
    let n = 0
    let g = 0
    for (const a of arcs) {
      const run = time * BEAD_SPEED * (a.fast ? FAST : 1) + a.phase
      on.length = 0
      for (let j = 0; j < BEADS_PER_WAY * 2; j++) {
        // Even beads go from A to B, odd ones from B to A; each direction is offset by half a bead.
        const along = (run + Math.floor(j / 2) / BEADS_PER_WAY + (j % 2) * (0.5 / BEADS_PER_WAY)) % 1
        const way = j % 2 === 0 ? 1 : -1
        const u = way > 0 ? along : 1 - along
        a.curve.getPointAt(u, at)
        // Stretched along the arc: its long axis follows the tangent at the point where it passes.
        a.curve.getTangentAt(u, dir)
        turn.setFromUnitVectors(axis, dir)
        const fade = Math.min(1, u / 0.1, (1 - u) / 0.1)
        const r = a.radius * BEAD_R * fade
        colorAt(a, u, tone)
        pearls.setMatrixAt(n, mtx.compose(at, turn, size.set(r, r, r * BEAD_STRETCH)))
        pearls.setColorAt(n, tone)
        // The halo, then the tail: each glow a step further back along the arc, smaller and fainter.
        for (let k = 0; k <= TAIL; k++) {
          const back = u - (way * k * TAIL_STEP * a.radius * BEAD_R * 2 * BEAD_STRETCH) / a.length
          const inArc = back > 0 && back < 1
          if (inArc && k > 0) a.curve.getPointAt(back, at)
          const ease = inArc ? Math.min(1, back / 0.1, (1 - back) / 0.1) : 0
          const radius = k === 0 ? a.radius * BEAD_R * HALO * fade : a.radius * BEAD_R * 0.95 * (1 - k / (TAIL + 2)) * ease
          halos.setMatrixAt(g, mtx.compose(at, still, size.setScalar(radius)))
          halos.setColorAt(g, k === 0 ? tone : colorAt(a, back, tone))
          glowAlpha.setX(g, k === 0 ? HALO_ALPHA : TAIL_ALPHA * Math.pow(1 - k / (TAIL + 1), 1.5))
          g++
        }
        on.push({ u, way, half: (r * BEAD_STRETCH) / a.length, size: fade })
        n++
      }
      bulge(a)
    }
    pearls.instanceMatrix.needsUpdate = true
    halos.instanceMatrix.needsUpdate = true
    for (const m of [pearls, halos]) if (m.instanceColor) m.instanceColor.needsUpdate = true
    glowAlpha.needsUpdate = true
  }

  /** Overall opacity of the flow (0 to 1): it fades in with the arcs. */
  const opacity = (o: number) => {
    shared.opacity.value = o
  }

  const dispose = () => {
    for (const m of [pearls, halos]) m.dispose()
    for (const x of [pearlGeo, glowGeo, pearlMat, glowMat]) x.dispose()
  }
  return { mesh, order, opacity, frame, dispose }
}
