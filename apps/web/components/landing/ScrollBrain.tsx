"use client"

import { useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import type { ZoneView } from "@/lib/brain"
import { BrainViz } from "../BrainViz"
import { arcBetween, backFade, brainNetwork, gradientSegments, knowledgeLinks, brainSurface, curveNetwork, shadeCurves, hashString, scatter, seeded, territories, zoneAnchors, zoneNodes } from "../brain-geometry"
import { Dot, zoneColor } from "../ui"

type Synapse = { a: string; b: string; weight: number; via: string[] }
type Agent = { zone: string; from: number; to: number; label: string }

export type ScrollBrainProps = {
  zones: ZoneView[]
  synapses: Synapse[]
  agents: Agent[]
  /** Progress of the pinned scene, from 0 (home) to 1 (the brain steps back). Read every frame. */
  progress: React.RefObject<number>
  /** Reduced motion: brain assembled and colored, home framing, nothing moves. */
  still: boolean
}

// Same values as the dashboard brain: ink on bone, phosphor reserved to a zone an agent touches.
const INK = 0x0a0a0a
const LINE = 0xd6d6cf
const RAW = 0xc6c6bf
const WHITE = 0xffffff
const PHOSPHOR = 0xc7ff3e

const CENTER_R = 0.034
/** Height kept free at the top and bottom of the screen during the chapters (nav bar, progress bar). */
const NAV_ROOM = 72
/** Gap between the chapters column and the brain, in px. */
const CHAPTER_GAP = 32
/** Half of the brain's on-screen footprint (surface + beads), to frame the camera. */
const EXTENT = { w: 1.65, h: 1.45 }
// Long focal length: little perspective, the beads keep the same size from one edge to the other.
const FOV = 26
const DUST = 160
const BONE = 0xf6f6f3
/** Network lines in ink, slightly softened toward white. */
const SOFTEN = 0.35
/** Small neurons in their zone's color, slightly softened. */
const DOT_SOFTEN = 0.2
/** Each inner layer is a bit paler and its neurons a bit smaller: depth reads. */
const DEPTH_SOFTEN = 0.15
/** Share of bone on the network's hidden side: only a breath of it remains, which keeps the silhouette. */
const BACK = 0.86
const NEURON_R = 0.007
/** Radius of the arcs between zones: thin tubes, a bit thicker than the links (WebGL lines stay at 1 px). */
const SYNAPSE_R = 0.004
const TUBULAR = 64
const RADIAL = 6
/** Assembly progress on the home page: a quarter of the knowledge is already in place. */
const HERO_ASSEMBLY = 0.32
/** The last third of the beads arrives later: maximal delay of a bead in the assembly. */
const MAX_DELAY = 0.7
const LAND = 0.3

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const easeOut = (t: number) => 1 - (1 - t) ** 3

/** Zones named during the 2nd chapter, faded out when the brain steps back. */
const labelsAt = (s: number) => smooth(0.39, 0.46, s) * (1 - smooth(0.88, 0.95, s))

/**
 * The home page brain. Same geometry as the dashboard's, but driven by scrolling:
 * it moves forward until it fills the screen while rotating, the scattered knowledge settles on the shell,
 * the zones take their color and their name, then three agents come to it for context.
 */
export function ScrollBrain({ zones, synapses, agents, progress, still }: ScrollBrainProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef(new Map<string, HTMLDivElement>())
  const bubblesRef = useRef(new Map<string, HTMLDivElement>())
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    if (fallback) return
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    let disposed = false
    let dispose: (() => void) | null = null
    import("three")
      .then((T) => {
        if (disposed) return
        try {
          dispose = build(T, { container, canvas, zones, synapses, agents, progress, still, labels: labelsRef.current, bubbles: bubblesRef.current })
        } catch {
          setFallback(true)
        }
      })
      .catch(() => setFallback(true))
    return () => {
      disposed = true
      dispose?.()
    }
  }, [zones, synapses, agents, progress, still, fallback])

  if (fallback) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-6 sm:justify-end sm:p-12">
        <div className="w-full max-w-[720px]">
          <BrainViz zones={zones} synapses={synapses} activity={{}} ripples={[]} now={0} />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden" aria-hidden>
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute inset-0">
        {zones.map((z) => {
          const agent = agents.find((a) => a.zone === z.id)
          return (
            <div
              key={z.id}
              ref={(el) => {
                if (el) labelsRef.current.set(z.id, el)
                else labelsRef.current.delete(z.id)
              }}
              className="brain-label absolute left-0 top-0 opacity-0"
            >
              <span className="flex items-start gap-1.5 rounded-[4px] bg-bone/90 px-1.5 py-0.5">
                <Dot color={zoneColor(z.color, z.position)} className="mt-[5px] sm:mt-[6px]" />
                <span>
                  <span className="block whitespace-nowrap text-[13px] font-medium leading-tight sm:text-[15px]">{z.name}</span>
                  <span className="hidden whitespace-nowrap text-[12px] tabular-nums leading-tight text-trace sm:block sm:text-[13px]">
                    {z.count} item{z.count === 1 ? "" : "s"}
                  </span>
                </span>
              </span>
              {agent && (
                <div
                  ref={(el) => {
                    if (el) bubblesRef.current.set(z.id, el)
                    else bubblesRef.current.delete(z.id)
                  }}
                  className="mt-1.5 flex max-w-[240px] items-start gap-1.5 rounded-[4px] border border-ink bg-surface px-2 py-1 text-[12px] leading-snug opacity-0 sm:max-w-[280px] sm:text-[13px]"
                >
                  <span className="mt-[4px] size-2 shrink-0 rounded-full border border-ink bg-phosphor" />
                  <span className="whitespace-normal">{agent.label}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

type ThreeModule = typeof import("three")
type SphereMesh = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
type RingMesh = THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>

type BuildArgs = {
  container: HTMLDivElement
  canvas: HTMLCanvasElement
  zones: ZoneView[]
  synapses: Synapse[]
  agents: Agent[]
  progress: React.RefObject<number>
  still: boolean
  labels: Map<string, HTMLDivElement>
  bubbles: Map<string, HTMLDivElement>
}

type Node = { zone: number; end: THREE.Vector3; start: THREE.Vector3; r: number; delay: number; wobble: number }
type ZoneGfx = { id: string; color: THREE.Color; center: SphereMesh; outline: SphereMesh; pos: THREE.Vector3; first: number; last: number }
type SynapseGfx = { a: number; b: number; mat: THREE.MeshBasicMaterial; base: number }
type Layout = { heroZ: number; fullZ: number; endZ: number; hero: [number, number]; full: [number, number] }

/** Builds the scene and starts the render loop. Returns the cleanup function. */
function build(T: ThreeModule, args: BuildArgs): () => void {
  const { container, canvas, zones, synapses, agents, progress, still, labels, bubbles } = args
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)

  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(FOV, 1, 0.1, 60)
  const group = new T.Group()
  scene.add(group)
  // Bone-colored fog: what is behind fades, depth reads without shadow or gradient.
  const fog = new T.Fog(BONE, 1, 10)
  scene.fog = fog

  const geoSphere = new T.SphereGeometry(1, 18, 12)
  const geoRing = new T.RingGeometry(0.93, 1, 48)
  const geometries: THREE.BufferGeometry[] = [geoSphere, geoRing]
  const materials: THREE.Material[] = []
  const surface = brainSurface()
  const anchors = zoneAnchors(zones.length)
  const owner = territories(anchors)
  /** Surface point i, shifted by k along its normal (k < 0: under the surface). */
  const onSurface = (i: number, k: number) => {
    const { p, n } = surface[i]
    return new T.Vector3(p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k)
  }

  // The network that draws the brain: raw gray at first; once the zones are named, the lines turn to ink and the neurons to their zone's color.
  const net = brainNetwork(owner)
  const curves = curveNetwork(net)
  const netCol = new Float32Array(curves.positions.length)
  const netGeo = new T.BufferGeometry()
  netGeo.setAttribute("position", new T.BufferAttribute(curves.positions, 3))
  netGeo.setAttribute("color", new T.BufferAttribute(netCol, 3))
  const shellMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 })
  const neuronMat = new T.MeshBasicMaterial({ color: WHITE, transparent: true, opacity: 0 })
  const neurons = new T.InstancedMesh(new T.SphereGeometry(1, 8, 6), neuronMat, net.points.length)
  net.points.forEach((p, i) => {
    const r = NEURON_R * (1 - 0.25 * net.depth[i])
    neurons.setMatrixAt(i, new T.Matrix4().makeScale(r, r, r).setPosition(p[0], p[1], p[2]))
  })
  group.add(new T.LineSegments(netGeo, shellMat), neurons)
  geometries.push(netGeo, neurons.geometry)
  materials.push(shellMat, neuronMat)

  // Zones: a colored center ringed with ink, and its knowledge around it.
  const outlineMat = new T.MeshBasicMaterial({ color: INK, side: T.BackSide })
  materials.push(outlineMat)
  const gfx: ZoneGfx[] = []
  const nodes: Node[] = []
  zones.forEach((z, i) => {
    const rand = seeded(hashString(z.id))
    const pos = onSurface(anchors[i], -0.08)
    const dir = pos.clone().normalize().toArray()
    const centerMat = new T.MeshBasicMaterial({ color: WHITE })
    const center: SphereMesh = new T.Mesh(geoSphere, centerMat)
    const outline: SphereMesh = new T.Mesh(geoSphere, outlineMat)
    center.position.copy(pos)
    outline.position.copy(pos)
    outline.visible = false
    group.add(outline, center)
    materials.push(centerMat)

    const first = nodes.length
    const count = 4 + Math.min(16, Math.round(Math.sqrt(z.count) * 2.2))
    for (const idx of zoneNodes(anchors, owner, i, count)) {
      // Under the surface, at varied depths: the knowledge settles into the brain, not on top of it.
      const end = onSurface(idx, -(0.04 + rand() * 0.14))
      // Before settling, the item floats far from the shell, in its direction: it comes from a computer.
      const away = scatter(dir, rand, 1.2)
      // Not too far: the bead must not float over the title or the chapters.
      const start = new T.Vector3(away[0], away[1], away[2]).multiplyScalar(1.5 + rand() * 0.45)
      nodes.push({ zone: i, end, start, r: 0.0065 + rand() * 0.005, delay: rand() * MAX_DELAY, wobble: rand() * Math.PI * 2 })
    }
    gfx.push({ id: z.id, color: new T.Color(zoneColor(z.color, z.position)), center, outline, pos, first, last: nodes.length })
  })

  // The knowledge: a single instanced geometry, one color per bead (raw, settled, or touched by an agent).
  const nodeMat = new T.MeshBasicMaterial({ color: WHITE })
  const nodeMesh = new T.InstancedMesh(geoSphere, nodeMat, nodes.length)
  const ringMat = new T.MeshBasicMaterial({ color: INK, side: T.BackSide })
  const ringMesh = new T.InstancedMesh(geoSphere, ringMat, nodes.length)
  group.add(ringMesh, nodeMesh)
  materials.push(nodeMat, ringMat)

  // Lines from an item to its zone center: they grow at the moment the bead settles.
  const linkPos = new Float32Array(nodes.length * 6)
  const linkCol = new Float32Array(nodes.length * 6)
  const linkGeo = new T.BufferGeometry()
  linkGeo.setAttribute("position", new T.BufferAttribute(linkPos, 3))
  linkGeo.setAttribute("color", new T.BufferAttribute(linkCol, 3))
  const linkMat = new T.LineBasicMaterial({ vertexColors: true })
  group.add(new T.LineSegments(linkGeo, linkMat))
  geometries.push(linkGeo)
  materials.push(linkMat)

  // The raw data: a dust of captures that stays around, never joining the brain.
  const dustRand = seeded(7)
  const dust = Array.from({ length: DUST }, () => {
    const d = scatter([dustRand() - 0.5, dustRand() - 0.5, dustRand() - 0.5], dustRand, 2)
    return { p: new T.Vector3(d[0], d[1] * 0.8, d[2]).multiplyScalar(1.55 + dustRand() * 0.55), r: 0.005 + dustRand() * 0.006, w: dustRand() * Math.PI * 2 }
  })
  const dustMat = new T.MeshBasicMaterial({ color: RAW, transparent: true, opacity: 0, depthWrite: false })
  const dustMesh = new T.InstancedMesh(geoSphere, dustMat, DUST)
  group.add(dustMesh)
  materials.push(dustMat)

  // The knowledge items linked to each other once settled, by straight lines, each to its nearest neighbors.
  const ends = nodes.map((nd) => nd.end.toArray())
  const knownSeg = gradientSegments(
    knowledgeLinks(ends).map(([a, b]) => ({ pts: [ends[a], ends[b]], from: gfx[nodes[a].zone].color.toArray(), to: gfx[nodes[b].zone].color.toArray() })),
  )
  const knownGeo = new T.BufferGeometry()
  knownGeo.setAttribute("position", new T.BufferAttribute(knownSeg.positions, 3))
  knownGeo.setAttribute("color", new T.BufferAttribute(knownSeg.colors, 3))
  const knownMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 })
  group.add(new T.LineSegments(knownGeo, knownMat))
  geometries.push(knownGeo)
  materials.push(knownMat)

  // Synapses: arcs between zones that share entities, as a gradient from one's color to the other's.
  const index = new Map(gfx.map((g, i) => [g.id, i]))
  const syn: SynapseGfx[] = []
  for (const s of synapses) {
    const a = index.get(s.a)
    const b = index.get(s.b)
    if (a === undefined || b === undefined) continue
    const pts = arcBetween(gfx[a].pos.toArray(), gfx[b].pos.toArray()).map((p) => new T.Vector3(...p))
    const geo = new T.TubeGeometry(new T.CatmullRomCurve3(pts), TUBULAR, SYNAPSE_R, RADIAL, false)
    const cols = new Float32Array(geo.attributes.position.count * 3)
    const tone = new T.Color()
    // The tube's vertices go ring by ring: the ring gives the position along the arc.
    for (let v = 0; v < geo.attributes.position.count; v++) tone.copy(gfx[a].color).lerp(gfx[b].color, Math.floor(v / (RADIAL + 1)) / TUBULAR).toArray(cols, v * 3)
    geo.setAttribute("color", new T.BufferAttribute(cols, 3))
    const mat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false })
    group.add(new T.Mesh(geo, mat))
    geometries.push(geo)
    materials.push(mat)
    syn.push({ a, b, mat, base: 0.45 + Math.min(0.3, Math.log2(1 + s.weight) * 0.08) })
  }

  // Phosphor ripples under each agent: two offset rings, fully driven by scrolling (reversible).
  const ripples = agents.flatMap((a) => {
    const z = index.get(a.zone)
    if (z === undefined) return []
    return [0, 0.4].map((lag) => {
      const mat = new T.MeshBasicMaterial({ color: PHOSPHOR, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false })
      const mesh: RingMesh = new T.Mesh(geoRing, mat)
      mesh.position.copy(gfx[z].pos)
      mesh.visible = false
      group.add(mesh)
      materials.push(mat)
      return { agent: a, lag, mesh }
    })
  })

  // Framing: the camera moves back or forward so that the brain fills a given fraction of the screen.
  const size = { w: 1, h: 1 }
  const tanH = Math.tan((FOV / 2) * (Math.PI / 180))
  let layout: Layout = { heroZ: 6, fullZ: 3.5, endZ: 5, hero: [0, 0], full: [0, 0] }
  const resize = () => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return
    size.w = w
    size.h = h
    renderer.setSize(w, h, false)
    const aspect = w / h
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    const fit = (f: number) => Math.max(EXTENT.w / (f * tanH * aspect), EXTENT.h / (f * tanH))
    const halfW = (z: number) => tanH * z * aspect
    const halfH = (z: number) => tanH * z
    const wide = aspect >= 1.05
    // Small enough never to go under the title or the chapters column.
    const heroZ = fit(0.5)
    // Chapters, wide screen: the brain fits in the space left to the right of the text column (same
    // measurements as .landing-chapter: gutter, 30rem of text, 20 px of inner padding) and under the top bar.
    const gutter = Math.min(56, Math.max(16, 0.04 * w))
    const column = Math.max(gutter, (w - 1440) / 2 + gutter) + 480 + 20 + CHAPTER_GAP
    const room = { w: Math.max(w * 0.3, w - column - gutter), h: h - 2 * NAV_ROOM }
    const fullZ = wide ? Math.max(fit(0.8), EXTENT.w / ((room.w / w) * tanH * aspect), EXTENT.h / ((room.h / h) * tanH)) : fit(0.78)
    // Center of that space, in scene coordinates at the full-screen framing distance.
    const roomCenter = ((column + room.w / 2 - w / 2) / (w / 2)) * halfW(fullZ)
    // Wide screen: the brain to the right of the title, then in the space to the right of the chapters.
    // Narrow screen: the brain above the text.
    layout = {
      heroZ,
      fullZ,
      endZ: fit(0.72),
      hero: wide ? [0.56 * halfW(heroZ), 0.2 * halfH(heroZ)] : [0, 0.42 * halfH(heroZ)],
      full: wide ? [roomCenter, 0] : [0, 0.3 * halfH(fullZ)],
    }
    invalidate()
  }
  const ro = new ResizeObserver(resize)

  const mtx = new T.Matrix4()
  const quat = new T.Quaternion()
  const scl = new T.Vector3()
  const tmp = new T.Vector3()
  const col = new T.Color()
  const inkC = new T.Color(INK)
  const rawC = new T.Color(RAW)
  const lineC = new T.Color(LINE)
  const phosC = new T.Color(PHOSPHOR)
  const whiteC = new T.Color(WHITE)

  const boneC = new T.Color(BONE)
  const netC = new T.Color()
  const linkBase = new Float32Array(net.points.length * 3)
  const dotBase = net.points.map(() => new T.Color())
  const fade = new Float32Array(net.points.length)
  const camLocal = new T.Vector3()
  let painted = -1
  /** Network color: raw gray → ink lines and neurons in their zone's color, as the zones get named. */
  const paintNetwork = (named: number) => {
    if (Math.abs(named - painted) < 0.004) return
    painted = named
    net.points.forEach((_, i) => {
      const deeper = net.depth[i] * DEPTH_SOFTEN
      netC.copy(rawC).lerp(col.copy(inkC).lerp(whiteC, SOFTEN + deeper), named).toArray(linkBase, i * 3)
      const zone = net.zone[i]
      if (zone < 0) dotBase[i].copy(rawC)
      else dotBase[i].copy(rawC).lerp(col.copy(gfx[zone].color).lerp(whiteC, DOT_SOFTEN + deeper), named)
    })
  }
  /** The hidden side fades toward the background: only the visible side of the network reads. */
  const shadeNetwork = () => {
    group.updateMatrixWorld()
    camLocal.copy(camera.position)
    group.worldToLocal(camLocal)
    backFade(net, camLocal.toArray(), fade)
    shadeCurves(curves, linkBase, fade, BACK, boneC.toArray() as [number, number, number], netCol)
    net.points.forEach((_, i) => neurons.setColorAt(i, col.copy(dotBase[i]).lerp(boneC, fade[i] * BACK)))
    netGeo.attributes.color.needsUpdate = true
    if (neurons.instanceColor) neurons.instanceColor.needsUpdate = true
  }

  const born = performance.now()
  let s = still ? 0.5 : progress.current ?? 0
  let spin = 0
  let raf = 0
  let last = performance.now()
  const state = { visible: true, running: false }

  /** One frame: the whole scene state derives from `s` (smoothed progress) and the clock. */
  const draw = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000)
    last = t
    if (!still) {
      s += ((progress.current ?? 0) - s) * Math.min(1, dt * 9)
      spin += dt * 0.07
    }
    const intro = still ? 1 : easeOut(clamp01((t - born) / 1800))

    // Framing: home → full screen (chapters) → stepping back when the brain withdraws.
    // Reduced motion: the home framing, brain already assembled and named.
    const toFull = still ? 0 : smooth(0.02, 0.16, s)
    const toEnd = still ? 0 : smooth(0.86, 1, s)
    const z = lerp(lerp(layout.heroZ, layout.fullZ, toFull), layout.endZ, toEnd)
    camera.position.set(0, 0.15, z)
    camera.lookAt(0, 0, 0)
    fog.near = z - 0.4
    fog.far = z + 3.4
    shellMat.opacity = 0.65 * intro * (1 - 0.35 * smooth(0.6, 0.86, s))
    group.position.x = lerp(lerp(layout.hero[0], layout.full[0], toFull), 0, toEnd)
    group.position.y = lerp(lerp(layout.hero[1], layout.full[1], toFull), 0, toEnd)
    group.rotation.x = lerp(0.3, 0.16, toFull)
    group.rotation.y = still ? -0.5 : -0.5 + s * Math.PI * 1.15 + spin

    // Assembly: each item leaves the dust and settles on the shell, in turn.
    const assembly = still ? 1.06 : HERO_ASSEMBLY * intro + (1.06 - HERO_ASSEMBLY) * smooth(0.1, 0.4, s)
    const named = still ? 1 : smooth(0.39, 0.5, s)
    paintNetwork(named)
    shadeNetwork()
    neuronMat.opacity = shellMat.opacity / 0.65
    const lit = new Set(agents.filter((a) => s > a.from && s < a.to).map((a) => a.zone))

    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i]
      const k = clamp01((assembly - nd.delay) / LAND)
      const e = easeOut(k)
      const float = (1 - e) * 0.08
      tmp.lerpVectors(nd.start, nd.end, e)
      tmp.x += Math.sin(t * 0.0006 + nd.wobble) * float
      tmp.y += Math.cos(t * 0.0005 + nd.wobble) * float
      const on = lit.has(gfx[nd.zone].id) && k >= 1
      const r = nd.r * (0.55 + 0.45 * e) * (on ? 1.3 : 1)
      mtx.compose(tmp, quat, scl.setScalar(r))
      nodeMesh.setMatrixAt(i, mtx)
      ringMesh.setMatrixAt(i, mtx.compose(tmp, quat, scl.setScalar(on ? r * 1.2 : 0)))
      nodeMesh.setColorAt(i, on ? phosC : col.copy(rawC).lerp(gfx[nd.zone].color, e * named))

      // Line: it starts from the center at the moment the bead arrives.
      const grow = easeOut(clamp01((k - 0.55) / 0.45))
      const c = gfx[nd.zone].pos
      linkPos.set([c.x, c.y, c.z, lerp(c.x, nd.end.x, grow), lerp(c.y, nd.end.y, grow), lerp(c.z, nd.end.z, grow)], i * 6)
      const lc = on ? inkC : lineC
      linkCol.set([lc.r, lc.g, lc.b, lc.r, lc.g, lc.b], i * 6)
    }
    nodeMesh.instanceMatrix.needsUpdate = true
    ringMesh.instanceMatrix.needsUpdate = true
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true
    linkGeo.attributes.position.needsUpdate = true
    linkGeo.attributes.color.needsUpdate = true

    for (const g of gfx) {
      const on = lit.has(g.id)
      g.center.material.color.copy(on ? phosC : col.copy(rawC).lerp(g.color, named))
      const target = CENTER_R * (0.6 + 0.4 * smooth(0.05, 0.3, assembly)) * (on ? 1.3 : 1)
      g.center.scale.setScalar(target)
      g.outline.scale.setScalar(target * 1.3)
      g.outline.visible = on
    }
    knownMat.opacity = 0.55 * (still ? 1 : smooth(0.43, 0.55, s))
    for (const sy of syn) {
      const on = lit.has(gfx[sy.a].id) || lit.has(gfx[sy.b].id)
      sy.mat.opacity = on ? 1 : sy.base * (still ? 1 : smooth(0.43, 0.55, s))
    }

    // The raw dust fades as the brain fills up: it stays on the computer.
    dustMat.opacity = still ? 0 : 0.85 * intro * (1 - smooth(0.14, 0.4, s))
    dustMesh.visible = dustMat.opacity > 0.01
    if (dustMesh.visible) {
      for (let i = 0; i < DUST; i++) {
        const d = dust[i]
        tmp.copy(d.p)
        tmp.y += Math.sin(t * 0.0004 + d.w) * 0.06
        dustMesh.setMatrixAt(i, mtx.compose(tmp, quat, scl.setScalar(d.r)))
      }
      dustMesh.instanceMatrix.needsUpdate = true
    }

    for (const rp of ripples) {
      const k = clamp01((s - rp.agent.from) / (rp.agent.to - rp.agent.from)) - rp.lag
      const on = k > 0 && k < 0.6
      rp.mesh.visible = on
      if (!on) continue
      const u = k / 0.6
      rp.mesh.scale.setScalar(0.04 + 0.36 * u)
      rp.mesh.material.opacity = 0.9 * (1 - u)
      rp.mesh.lookAt(camera.position)
    }

    renderer.render(scene, camera)

    // Labels: projected onto their zone, paler when the zone goes behind.
    // Under reduced motion, the brain stays in the home framing: no labels over the title.
    const shown = still ? 0 : labelsAt(s)
    const centerDepth = tmp.set(0, 0, 0).applyMatrix4(group.matrixWorld).project(camera).z
    for (const g of gfx) {
      const el = labels.get(g.id)
      if (!el) continue
      tmp.setFromMatrixPosition(g.center.matrixWorld).project(camera)
      const x = (tmp.x * 0.5 + 0.5) * size.w
      const y = (-tmp.y * 0.5 + 0.5) * size.h
      const behind = tmp.z > centerDepth
      const flip = x > size.w * 0.7
      el.style.transform = flip ? `translate(${(x - 20).toFixed(1)}px, ${(y - 15).toFixed(1)}px) translateX(-100%)` : `translate(${(x + 20).toFixed(1)}px, ${(y - 15).toFixed(1)}px)`
      el.classList.toggle("is-flip", flip)
      el.style.opacity = (shown * (behind && !lit.has(g.id) ? 0.4 : 1)).toFixed(3)
      el.style.zIndex = lit.has(g.id) ? "3" : behind ? "1" : "2"
      el.style.visibility = shown > 0.01 ? "visible" : "hidden"
      const bubble = bubbles.get(g.id)
      if (bubble) {
        const a = agents.find((x) => x.zone === g.id)
        const v = a ? smooth(a.from, a.from + 0.015, s) * (1 - smooth(a.to - 0.015, a.to, s)) : 0
        bubble.style.opacity = v.toFixed(3)
        bubble.style.transform = `translateY(${((1 - v) * 4).toFixed(1)}px)`
      }
    }
  }

  const frame = (t: number) => {
    raf = requestAnimationFrame(frame)
    draw(t)
  }
  // Reduced motion: a single frame per size change, no loop.
  function invalidate() {
    if (still) draw(performance.now())
  }
  const start = () => {
    if (still || state.running || !state.visible || document.hidden) return
    state.running = true
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }
  const stop = () => {
    state.running = false
    cancelAnimationFrame(raf)
  }
  const io = new IntersectionObserver(
    ([entry]) => {
      state.visible = entry.isIntersecting
      if (state.visible) start()
      else stop()
    },
    { threshold: 0 },
  )
  const onVisibility = () => (document.hidden ? stop() : start())

  ro.observe(container)
  io.observe(container)
  document.addEventListener("visibilitychange", onVisibility)
  resize()
  start()

  return () => {
    stop()
    io.disconnect()
    ro.disconnect()
    document.removeEventListener("visibilitychange", onVisibility)
    nodeMesh.dispose()
    ringMesh.dispose()
    dustMesh.dispose()
    neurons.dispose()
    for (const g of geometries) g.dispose()
    for (const m of materials) m.dispose()
    renderer.dispose()
  }
}
