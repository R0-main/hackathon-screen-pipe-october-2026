"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import type { ZoneView } from "@/lib/brain"
import { BrainViz, type Ripple, type ZoneActivity } from "./BrainViz"
import { arcBetween, backFade, brainNetwork, gradientSegments, knowledgeLinks, brainSurface, curveNetwork, shadeCurves, hashString, seeded, territories, zoneAnchors, zoneNodes, type V3 } from "./brain-geometry"
import { arcBeads, arcTube, type FlowArc } from "./arc-flow"
import { assignLooks, dotKit, type DotLook } from "./dot-model"
import { firstName } from "./format"
import { Dot, LockIcon, MinusIcon, PlusIcon, zoneColor } from "./ui"

type Synapse = { a: string; b: string; weight: number; via: string[] }

/** A person and their dot, placed outside the brain at the edge of the zone where they work. */
export type BrainPerson = {
  id: string
  name: string
  zone: string | null
  /** Their agent worked in the last few minutes: the dot breathes. */
  working?: boolean
  /** Their agent is touching the brain right now: the dot bounces, ringed with phosphor. */
  live?: boolean
  me?: boolean
}
type PlacedPerson = BrainPerson & { look: DotLook }

export type Brain3DProps = {
  zones: ZoneView[]
  synapses: Synapse[]
  activity: Record<string, ZoneActivity>
  ripples: Ripple[]
  now: number
  selected?: string | null
  onSelect?: (zone: string) => void
  people?: BrainPerson[]
}

// Ink on white. A zone touched live (an agent, a click) lights up in its own color, brightened.
const INK = 0x0a0a0a
const LINE = 0xd6d6cf
const NEUTRAL = 0xb8b8b8
const WHITE = 0xffffff
/** Network lines in ink, slightly softened toward white. */
const SOFTEN = 0.35
/** Small neurons in their zone's color, slightly softened; gray outside zones (cerebellum, brainstem, locked zone). */
const DOT_SOFTEN = 0.2
const BARE = 0xc4c4bc
/** Each inner layer is a bit paler and its neurons a bit smaller: depth reads. */
const DEPTH_SOFTEN = 0.15
/** Share of white on the hidden side: only a breath of it remains, which keeps the silhouette. */
const BACK = 0.86
const NEURON_R = 0.008
/** Radius of the arcs between zones: thin tubes, a bit thicker than the links (WebGL lines stay at 1 px). */
const SYNAPSE_R = 0.0045

const CENTER_R = 0.042
/** People dots: distance from the brain's silhouette and between two neighboring dots, in pixels (before zoom). */
const DOT_GAP = 32
const DOT_SPACING = 44
/** Radius of a dot in the scene: about twenty pixels wide at the starting zoom. */
const DOT_R = 0.052
const ZOOM = { min: 2.6, max: 9, start: 6, step: 0.6 }
const IDLE_MS = 5000
const RIPPLE_MS = 2400
/** Interval between two ripples while a zone is selected. */
const PULSE_MS = 2000
/** Back to normal when the zone is no longer selected: color, circle and ripples fade out gently. */
const SETTLE_MS = 600
/** The ink circle around a lit zone, relative to its bead. */
const RIM = 1.14
/** Shock wave: maximum push of the points (scene units), and reach beyond the zone's edge. */
const SHOCK = 0.03
const SHOCK_AROUND = 0.22

type ThreeModule = typeof import("three")
type SphereMesh = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
type RingMesh = THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>

type ZoneGfx = {
  id: string
  locked: boolean
  color: number
  /** The zone's color when it lights up: its own, more saturated and a little lighter. */
  glow: number
  /** Distance of the knowledge farthest from the center: the ripple goes as far as it. */
  reach: number
  center: SphereMesh
  outline: SphereMesh
  nodes: SphereMesh[]
  nodeMat: THREE.MeshBasicMaterial
  linkMat: THREE.LineBasicMaterial
  /** Center → knowledge lines: vertex 2k + 1 is knowledge k. */
  linkGeo: THREE.BufferGeometry
  centerPos: THREE.Vector3
  active: boolean
  selected: boolean
  /** Lit: touched live or selected with a click. */
  lit: boolean
  /** Displayed share of lighting, from 0 (normal) to 1 (lit), which follows `lit` gently. */
  mix: number
  outlineMat: THREE.MeshBasicMaterial
  /** When it stopped being selected: the activity of that click (coming back from the server) does not light it again. */
  dismissedAt: number
}

type SynapseGfx = {
  a: string
  b: string
  mat: THREE.MeshBasicMaterial
  baseOpacity: number
  active: boolean
  /** The arc, where the light beads flow (see arc-flow). */
  arc: FlowArc
}
/** `fade`: moment the ripple starts fading before its end (zone deselected). */
type RippleGfx = { key: string; zone: ZoneGfx; mesh: RingMesh; start: number; fade?: number }
type View = { rx: number; ry: number; zoom: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The brain in three dimensions: a network of neurons on the surface of a brain (lobes, cerebellum,
 * brainstem) draws the silhouette: ink lines, neurons in their zone's color. The beads (the knowledge)
 * are grouped by zone on the cortex, linked to their center and across zones by thin lines. You rotate it with the
 * mouse, zoom with the wheel, by pinching or with the buttons. It fills its container: the page does not scroll,
 * the wheel only zooms. Without WebGL, it falls back to the 2D view.
 */
export function Brain3D(props: Brain3DProps) {
  const { zones, synapses, activity, ripples, now, selected, onSelect, people = [] } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef(new Map<string, HTMLButtonElement>())
  const dotsRef = useRef(new Map<string, HTMLAnchorElement>())
  const peopleRef = useRef(new Map<string, BrainPerson>())
  const activityRef = useRef(activity)
  const ripplesRef = useRef(ripples)
  const selectedRef = useRef(selected)
  const onSelectRef = useRef(onSelect)
  // In profile, forehead to the left, slightly three-quarter: the brain's silhouette reads at once.
  const viewRef = useRef<View>({ rx: 0.12, ry: Math.PI - 0.38, zoom: ZOOM.start })
  const zoomRef = useRef<(delta: number) => void>(() => {})
  const [fallback, setFallback] = useState(false)
  activityRef.current = activity
  ripplesRef.current = ripples
  selectedRef.current = selected
  onSelectRef.current = onSelect

  // The scene is only rebuilt when the structure changes (zones, locks, volumes, links).
  const sceneKey = `${zones.map((z) => `${z.id}:${z.locked ? 1 : 0}:${z.count}:${zoneColor(z.color, z.position)}`).join("|")}#${synapses
    .map((s) => `${s.a}-${s.b}:${s.weight}`)
    .join("|")}#${people.map((p) => `${p.id}:${p.zone ?? ""}`).join("|")}`
  const placed = people.filter((p) => p.zone && zones.some((z) => z.id === p.zone))
  const looks = assignLooks(placed)
  peopleRef.current = new Map(placed.map((p) => [p.id, p]))

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
          dispose = build(T, container, canvas, zones, synapses, placed.map((p) => ({ ...p, look: looks.get(p.id)! })), { labelsRef, dotsRef, peopleRef, activityRef, ripplesRef, selectedRef, onSelectRef, viewRef, zoomRef })
        } catch {
          setFallback(true)
        }
      })
      .catch(() => setFallback(true))
    return () => {
      disposed = true
      dispose?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, fallback])

  if (fallback) {
    return (
      <div className="grid h-full w-full place-items-center overflow-hidden bg-surface p-6">
        <div className="w-full max-w-[1100px]">
          <BrainViz zones={zones} synapses={synapses} activity={activity} ripples={ripples} now={now} selected={selected} onSelect={onSelect} />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-surface">
      <canvas ref={canvasRef} className="block h-full w-full cursor-grab touch-none active:cursor-grabbing" aria-hidden />

      {/* Dots: 3D models in the scene. Here, their clickable area and their first name, placed every frame at the same spot. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {placed.map((p) => {
          const zone = zones.find((z) => z.id === p.zone)!
          return (
            <Link
              key={p.id}
              href={`/people/${p.id}`}
              ref={(el) => {
                if (el) dotsRef.current.set(p.id, el)
                else dotsRef.current.delete(p.id)
              }}
              className="brain-dot pointer-events-auto absolute left-0 top-0"
              data-live={p.live ? "1" : undefined}
              data-me={p.me ? "1" : undefined}
              aria-label={`${p.name}${p.me ? " (you)" : ""}, ${zone.name}`}
              title={`${p.name} · ${zone.name}`}
            >
              <span className="brain-dot-hit" aria-hidden />
              <span className="brain-dot-name">{p.me ? "You" : firstName(p.name)}</span>
            </Link>
          )
        })}
      </div>

      {/* Labels: real buttons, positioned every frame on their zone's projection. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {zones.map((z) => {
          const act = activity[z.id]
          const live = Boolean(act && act.until > now && act.label)
          const isSel = selected === z.id
          return (
            <button
              key={z.id}
              type="button"
              ref={(el) => {
                if (el) labelsRef.current.set(z.id, el)
                else labelsRef.current.delete(z.id)
              }}
              className="brain-label pointer-events-auto absolute left-0 top-0 rounded-[4px] text-left"
              aria-pressed={isSel}
              data-live={live ? "1" : undefined}
              onClick={() => onSelect?.(z.id)}
            >
              <span className="flex items-start gap-1.5 rounded-[4px] bg-surface/70 px-1.5 py-0.5">
                <Dot color={zoneColor(z.color, z.position)} size={7} className="mt-[4px]" />
                <span>
                  <span className={`block whitespace-nowrap text-[11px] font-medium leading-tight sm:text-[12px] ${isSel ? "underline underline-offset-4" : ""}`}>{z.name}</span>
                  <span className="hidden whitespace-nowrap text-[10.5px] tabular-nums leading-tight text-trace sm:block">
                    {z.locked ? (
                      <span className="inline-flex items-center gap-1">
                        <LockIcon size={11} /> restricted access
                      </span>
                    ) : (
                      `${z.count} item${z.count === 1 ? "" : "s"}`
                    )}
                  </span>
                </span>
              </span>
              {live && (
                <span key={act!.startedAt} className="bubble-in mt-1 hidden max-w-[260px] items-start gap-1.5 rounded-[4px] border border-ink bg-surface px-2 py-1 text-[11.5px] leading-snug sm:flex">
                  <span className="mt-[3px] size-2 shrink-0 rounded-full border border-ink" style={{ background: z.locked ? "#b8b8b8" : zoneColor(z.color, z.position) }} aria-hidden />
                  <span className="whitespace-normal">{act!.label}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="absolute bottom-4 right-4 flex flex-col gap-1.5">
        <button type="button" className="btn btn-icon" aria-label="Zoom in" onClick={() => zoomRef.current(-ZOOM.step)}>
          <PlusIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Zoom out" onClick={() => zoomRef.current(ZOOM.step)}>
          <MinusIcon />
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-4 left-4 hidden text-[12px] text-trace sm:block">Drag to rotate, scroll or pinch to zoom.</p>
    </div>
  )
}

type Refs = {
  labelsRef: React.RefObject<Map<string, HTMLButtonElement>>
  dotsRef: React.RefObject<Map<string, HTMLAnchorElement>>
  peopleRef: React.RefObject<Map<string, BrainPerson>>
  activityRef: React.RefObject<Record<string, ZoneActivity>>
  ripplesRef: React.RefObject<Ripple[]>
  selectedRef: React.RefObject<string | null | undefined>
  onSelectRef: React.RefObject<((zone: string) => void) | undefined>
  viewRef: React.RefObject<View>
  zoomRef: React.RefObject<(delta: number) => void>
}

/** Builds the scene and starts the render loop. Returns the cleanup function. */
function build(T: ThreeModule, container: HTMLDivElement, canvas: HTMLCanvasElement, zones: ZoneView[], synapses: Synapse[], people: PlacedPerson[], refs: Refs): () => void {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)

  const scene = new T.Scene()
  // White fog: the back side fades, the front links stay readable.
  const fog = new T.Fog(WHITE, 1, 10)
  scene.fog = fog
  const camera = new T.PerspectiveCamera(36, 1, 0.1, 50)
  const view = refs.viewRef.current
  const state = { zoomTarget: view.zoom, lastInteraction: -Infinity, visible: true, running: false }
  camera.position.set(0, 0.2, view.zoom)
  camera.lookAt(0, 0, 0)

  const group = new T.Group()
  group.rotation.x = view.rx
  group.rotation.y = view.ry
  scene.add(group)

  const geoSphere = new T.SphereGeometry(1, 20, 14)
  const geoRing = new T.RingGeometry(0.975, 1, 64)
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

  const gfx = new Map<string, ZoneGfx>()
  const pickables: THREE.Object3D[] = []

  zones.forEach((z, i) => {
    const rand = seeded(hashString(z.id))
    const centerPos = onSurface(anchors[i], -0.08)
    const color = new T.Color(zoneColor(z.color, z.position)).getHex()

    // A colored dot, without outline: the ink circle only marks the chosen or active zone.
    const centerMat = new T.MeshBasicMaterial({ color: z.locked ? NEUTRAL : color })
    const center: SphereMesh = new T.Mesh(geoSphere, centerMat)
    center.position.copy(centerPos)
    center.scale.setScalar(CENTER_R)
    center.userData.zone = z.id
    const outlineMat = new T.MeshBasicMaterial({ color: INK, side: T.BackSide, transparent: true, opacity: 0 })
    materials.push(outlineMat)
    const outline: SphereMesh = new T.Mesh(geoSphere, outlineMat)
    outline.position.copy(centerPos)
    outline.scale.setScalar(CENTER_R * RIM)
    outline.visible = false
    group.add(outline, center)
    pickables.push(center)

    const count = z.locked ? 5 : 4 + Math.min(16, Math.round(Math.sqrt(z.count) * 2.2))
    const nodeMat = new T.MeshBasicMaterial({ color: z.locked ? NEUTRAL : color })
    const nodes: SphereMesh[] = []
    const linkPts: THREE.Vector3[] = []
    for (const idx of zoneNodes(anchors, owner, i, count)) {
      // Under the surface, at varied depths: the knowledge is in the brain, not laid on top of it.
      const p = onSurface(idx, -(0.04 + rand() * 0.14))
      const r = 0.007 + rand() * 0.006
      const node: SphereMesh = new T.Mesh(geoSphere, nodeMat)
      node.position.copy(p)
      node.scale.setScalar(r)
      node.userData.zone = z.id
      node.userData.r = r
      node.userData.d = p.distanceTo(centerPos)
      node.userData.base = p.clone()
      group.add(node)
      nodes.push(node)
      pickables.push(node)
      linkPts.push(centerPos.clone(), p)
    }
    const linkMat = new T.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.7 })
    const linkGeo = new T.BufferGeometry().setFromPoints(linkPts)
    group.add(new T.LineSegments(linkGeo, linkMat))
    geometries.push(linkGeo)
    materials.push(centerMat, nodeMat, linkMat)
    const glow = new T.Color(z.locked ? NEUTRAL : color).offsetHSL(0, 0.18, 0.06).getHex()
    const reach = Math.max(0.3, ...nodes.map((n) => n.userData.d as number))
    gfx.set(z.id, { id: z.id, locked: z.locked, color, glow, reach, center, outline, nodes, nodeMat, linkMat, linkGeo, centerPos, active: false, selected: false, lit: false, mix: 0, outlineMat, dismissedAt: -Infinity })
  })

  // The network that draws the brain: links as arcs, in ink; only the zones carry color.
  const net = brainNetwork(owner)
  const curves = curveNetwork(net)
  const netCol = new Float32Array(curves.positions.length)
  const netGeo = new T.BufferGeometry()
  netGeo.setAttribute("position", new T.BufferAttribute(curves.positions, 3))
  netGeo.setAttribute("color", new T.BufferAttribute(netCol, 3))
  const netMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 })
  const neuronMat = new T.MeshBasicMaterial({ color: WHITE })
  const neurons = new T.InstancedMesh(geoSphere, neuronMat, net.points.length)
  const mtx = new T.Matrix4()
  net.points.forEach((p, i) => {
    const r = NEURON_R * (1 - 0.25 * net.depth[i])
    neurons.setMatrixAt(i, mtx.makeScale(r, r, r).setPosition(p[0], p[1], p[2]))
  })
  group.add(new T.LineSegments(netGeo, netMat), neurons)
  geometries.push(netGeo)
  materials.push(netMat, neuronMat)

  const inkC = new T.Color(INK)
  const whiteC = new T.Color(WHITE)
  const bareC = new T.Color(BARE)
  const zoneList = [...gfx.values()]
  const tone = new T.Color()
  // Base colors per neuron (link and point), then faded every frame depending on the visible side.
  const linkBase = new Float32Array(net.points.length * 3)
  const dotBase = net.points.map(() => new T.Color())
  const fade = new Float32Array(net.points.length)
  net.points.forEach((_, i) => {
    const deeper = net.depth[i] * DEPTH_SOFTEN
    tone.copy(inkC).lerp(whiteC, SOFTEN + deeper).toArray(linkBase, i * 3)
    const g = net.zone[i] >= 0 ? zoneList[net.zone[i]] : undefined
    if (!g || g.locked) dotBase[i].copy(bareC)
    else dotBase[i].setHex(g.color).lerp(whiteC, DOT_SOFTEN + deeper)
  })
  const camLocal = new T.Vector3()
  const shadeNetwork = () => {
    camLocal.copy(camera.position)
    group.worldToLocal(camLocal)
    backFade(net, camLocal.toArray(), fade)
    shadeCurves(curves, linkBase, fade, BACK, [1, 1, 1], netCol)
    net.points.forEach((_, i) => neurons.setColorAt(i, tone.copy(dotBase[i]).lerp(whiteC, fade[i] * BACK)))
    netGeo.attributes.color.needsUpdate = true
    if (neurons.instanceColor) neurons.instanceColor.needsUpdate = true
  }

  // Knowledge items linked to each other by straight lines, each to its nearest neighbors, whatever their zone.
  const known = [...gfx.values()].flatMap((g) => g.nodes.map((node) => ({ p: node.position.toArray(), color: new T.Color(g.locked ? NEUTRAL : g.color).toArray() })))
  const knownPairs = knowledgeLinks(known.map((k) => k.p))
  const knownSeg = gradientSegments(knownPairs.map(([a, b]) => ({ pts: [known[a].p, known[b].p], from: known[a].color, to: known[b].color })))
  const knownGeo = new T.BufferGeometry()
  knownGeo.setAttribute("position", new T.BufferAttribute(knownSeg.positions, 3))
  knownGeo.setAttribute("color", new T.BufferAttribute(knownSeg.colors, 3))
  const knownMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 })
  group.add(new T.LineSegments(knownGeo, knownMat))
  geometries.push(knownGeo)
  materials.push(knownMat)

  // Shock wave: as the front passes, the zone's knowledge and the network neurons around it (up to
  // SHOCK_AROUND beyond the zone) are pushed outward then come back; their links follow.
  const knownNodes = [...gfx.values()].flatMap((g) => g.nodes.map((node, k) => ({ node, g, k })))
  const netBase = curves.positions.slice()
  const neuronR = net.points.map((_, i) => NEURON_R * (1 - 0.25 * net.depth[i]))
  type Field = { neurons: number[]; netVerts: number[]; known: number[]; knownVerts: number[] }
  const fields = new Map<ZoneGfx, Field>()
  /** What a zone's ripple can reach, computed once per zone. */
  const fieldOf = (g: ZoneGfx): Field => {
    let f = fields.get(g)
    if (f) return f
    const c = g.centerPos
    const far = (g.reach + SHOCK_AROUND) ** 2
    const near = (p: V3) => (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 + (p[2] - c.z) ** 2 < far
    const neurons = net.points.map((p, i) => (near(p) ? i : -1)).filter((i) => i >= 0)
    const inNet = new Set(neurons)
    const netVerts: number[] = []
    for (let v = 0; v < curves.a.length; v++) if (inNet.has(curves.a[v]) || inNet.has(curves.b[v])) netVerts.push(v)
    const known = knownNodes.map((k, i) => (near((k.node.userData.base as THREE.Vector3).toArray()) ? i : -1)).filter((i) => i >= 0)
    const inKnown = new Set(known)
    const knownVerts = knownPairs.flatMap(([a, b], l) => (inKnown.has(a) || inKnown.has(b) ? [l] : []))
    f = { neurons, netVerts, known, knownVerts }
    fields.set(g, f)
    return f
  }
  const netShift = new Float32Array(net.points.length * 3)
  const knownShift = new Float32Array(knownNodes.length * 3)
  let shaken = new Set<ZoneGfx>()
  /** Offset of a point p by the current ripples of zone g, added into out (at index o). */
  const addWave = (g: ZoneGfx, p: ArrayLike<number>, out: Float32Array, o: number, t: number) => {
    const c = g.centerPos
    const vx = p[0] - c.x
    const vy = p[1] - c.y
    const vz = p[2] - c.z
    const d = Math.hypot(vx, vy, vz) || 1
    // Beyond the zone, the ripple dampens until it dies out at SHOCK_AROUND.
    const edge = d > g.reach ? Math.max(0, 1 - (d - g.reach) / SHOCK_AROUND) : 1
    if (edge === 0) return
    for (const r of live) {
      if (r.zone !== g) continue
      const k = (t - r.start) / RIPPLE_MS
      const off = (d - rippleRadius(r, k)) / 0.08
      const push = (SHOCK * edge * Math.exp(-off * off) * (1 - k) * rippleGain(r, t)) / d
      out[o] += vx * push
      out[o + 1] += vy * push
      out[o + 2] += vz * push
    }
  }
  const netPos = netGeo.attributes.position as THREE.BufferAttribute
  const knownPos = knownGeo.attributes.position as THREE.BufferAttribute
  const shake = (t: number) => {
    const now = new Set(reduced ? [] : live.map((r) => r.zone))
    const touched = new Set([...now, ...shaken])
    shaken = now
    if (touched.size === 0) return
    // Reset everything that moved, then add up the current ripples.
    for (const g of touched) {
      const f = fieldOf(g)
      for (const i of f.neurons) netShift.fill(0, i * 3, i * 3 + 3)
      for (const i of f.known) knownShift.fill(0, i * 3, i * 3 + 3)
    }
    for (const g of now) {
      const f = fieldOf(g)
      for (const i of f.neurons) addWave(g, net.points[i], netShift, i * 3, t)
      for (const i of f.known) addWave(g, (knownNodes[i].node.userData.base as THREE.Vector3).toArray(), knownShift, i * 3, t)
    }
    for (const g of touched) {
      const f = fieldOf(g)
      for (const i of f.neurons) {
        const p = net.points[i]
        const r = neuronR[i]
        neurons.setMatrixAt(i, mtx.makeScale(r, r, r).setPosition(p[0] + netShift[i * 3], p[1] + netShift[i * 3 + 1], p[2] + netShift[i * 3 + 2]))
      }
      // Each vertex of a curved link follows its two neurons, in proportion to its place along the arc.
      for (const v of f.netVerts) {
        const a = curves.a[v] * 3
        const b = curves.b[v] * 3
        const u = curves.t[v]
        for (let c = 0; c < 3; c++) netPos.array[v * 3 + c] = netBase[v * 3 + c] + netShift[a + c] * (1 - u) + netShift[b + c] * u
      }
      for (const i of f.known) {
        const { node, g: owner, k } = knownNodes[i]
        const base = node.userData.base as THREE.Vector3
        node.position.set(base.x + knownShift[i * 3], base.y + knownShift[i * 3 + 1], base.z + knownShift[i * 3 + 2])
        ;(owner.linkGeo.attributes.position as THREE.BufferAttribute).setXYZ(k * 2 + 1, node.position.x, node.position.y, node.position.z)
        owner.linkGeo.attributes.position.needsUpdate = true
      }
      for (const l of f.knownVerts) {
        const [a, b] = knownPairs[l]
        knownPos.setXYZ(l * 2, knownNodes[a].node.position.x, knownNodes[a].node.position.y, knownNodes[a].node.position.z)
        knownPos.setXYZ(l * 2 + 1, knownNodes[b].node.position.x, knownNodes[b].node.position.y, knownNodes[b].node.position.z)
      }
    }
    neurons.instanceMatrix.needsUpdate = true
    netPos.needsUpdate = true
    knownPos.needsUpdate = true
  }

  const reducedFlow = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  // Synapses: arcs between two zones that share entities, as a gradient from one's color to the
  // other's, stronger when they are active.
  const syn: SynapseGfx[] = []
  for (const s of synapses) {
    const A = gfx.get(s.a)
    const B = gfx.get(s.b)
    if (!A || !B) continue
    const pts = arcBetween(A.center.position.toArray(), B.center.position.toArray()).map((p) => new T.Vector3(...p))
    const baseOpacity = 0.45 + Math.min(0.3, Math.log2(1 + s.weight) * 0.08)
    const mat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: baseOpacity, depthWrite: false })
    const from = new T.Color(A.locked ? NEUTRAL : A.color)
    const to = new T.Color(B.locked ? NEUTRAL : B.color)
    const { geo, arc } = arcTube(T, pts, from, to, SYNAPSE_R, `${s.a}|${s.b}`)
    group.add(new T.Mesh(geo, mat))
    geometries.push(geo)
    materials.push(mat)
    syn.push({ a: s.a, b: s.b, mat, baseOpacity, active: false, arc })
  }
  // The flow: small light beads in each arc, which speed up when one of the two zones is active.
  const flow = arcBeads(T, syn.map((s) => s.arc))
  flow.mesh.visible = !reducedFlow
  group.add(flow.mesh)
  const flowFrame = (time: number) => {
    if (reducedFlow) return
    for (const s of syn) s.arc.fast = s.active
    flow.frame(time)
  }

  // People dots: placed on screen, just outside the brain's silhouette, in the direction of their zone.
  // The silhouette is read from a sample of the surface, projected every frame.
  const outline = surface.filter((_, i) => i % 3 === 0).map((sp) => new T.Vector3(...sp.p))
  const outlineXY = new Float32Array(outline.length * 2)
  const dotGroups = zones
    .map((z) => ({ zone: gfx.get(z.id)!, members: people.filter((p) => p.zone === z.id).sort((a, b) => a.id.localeCompare(b.id)) }))
    .filter((g) => g.members.length > 0)
  /** Displayed position of each dot, smoothed from one frame to the next (a zone passing in front of the camera doesn't make it jump). */
  const dotPos = new Map<string, { x: number; y: number }>()
  // The dots live outside the brain (in the scene, not in the rotating group): they always face
  // the screen. Only they are lit, as felt.
  const kit = dotKit(T)
  const dots = new Map<string, { model: THREE.Group; zone: ZoneGfx; phase: number }>()
  for (const { zone, members } of dotGroups)
    for (const p of members) {
      const model = kit.make(zone.locked ? NEUTRAL : zone.color, p.look)
      model.scale.setScalar(DOT_R)
      model.visible = false
      scene.add(model)
      dots.set(p.id, { model, zone, phase: (hashString(p.id) % 1000) / 160 })
    }
  if (dots.size) {
    const key = new T.DirectionalLight(0xffffff, 1.6)
    key.position.set(-2, 3, 5)
    scene.add(new T.HemisphereLight(0xffffff, 0xd8d4ca, 2.4), key)
  }
  const dotWorld = new T.Vector3()
  const zoneWorld = new T.Vector3()

  // Size: the canvas follows its container.
  const size = { w: 1, h: 1 }
  const resize = () => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return
    size.w = w
    size.h = h
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.zoom = Math.min(1, camera.aspect / 1.1)
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  // Interaction: drag to rotate, click to open a zone, wheel (or pinch on the touchpad) to zoom.
  const raycaster = new T.Raycaster()
  const ndc = new T.Vector2()
  const pick = (e: PointerEvent): string | null => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hit = raycaster.intersectObjects(pickables, false)[0]
    return hit ? ((hit.object.userData.zone as string) ?? null) : null
  }
  let dragging = false
  let moved = 0
  let lastX = 0
  let lastY = 0
  let downAt = 0
  // Fingers down: with two, the distance between them zooms (pinch on a touch screen).
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch = 0
  const spreadOf = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    canvas.setPointerCapture(e.pointerId)
    state.lastInteraction = performance.now()
    if (pointers.size === 2) {
      dragging = false
      moved = Infinity
      pinch = spreadOf()
      return
    }
    dragging = true
    moved = 0
    lastX = e.clientX
    lastY = e.clientY
    downAt = performance.now()
    canvas.style.cursor = "grabbing"
  }
  const onMove = (e: PointerEvent) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size >= 2) {
      const d = spreadOf()
      state.zoomTarget = clamp(state.zoomTarget - (d - pinch) * 0.01, ZOOM.min, ZOOM.max)
      pinch = d
      state.lastInteraction = performance.now()
    } else if (dragging) {
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      moved += Math.abs(dx) + Math.abs(dy)
      group.rotation.y += dx * 0.006
      group.rotation.x = clamp(group.rotation.x + dy * 0.006, -1.2, 1.2)
      state.lastInteraction = performance.now()
    } else if (e.pointerType === "mouse") {
      canvas.style.cursor = pick(e) ? "pointer" : "grab"
    }
  }
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    if (!dragging) return
    dragging = false
    canvas.style.cursor = "grab"
    if (moved < 6 && performance.now() - downAt < 600) {
      const zone = pick(e)
      if (zone) refs.onSelectRef.current?.(zone)
    }
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    // A touchpad pinch arrives as wheel + Ctrl, with small deltas: it is amplified.
    const k = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.12 : 0.004
    state.zoomTarget = clamp(state.zoomTarget + e.deltaY * k, ZOOM.min, ZOOM.max)
    state.lastInteraction = performance.now()
  }
  canvas.addEventListener("pointerdown", onDown)
  canvas.addEventListener("pointermove", onMove)
  canvas.addEventListener("pointerup", onUp)
  canvas.addEventListener("pointercancel", onUp)
  canvas.addEventListener("wheel", onWheel, { passive: false })
  refs.zoomRef.current = (delta: number) => {
    state.zoomTarget = clamp(state.zoomTarget + delta, ZOOM.min, ZOOM.max)
    state.lastInteraction = performance.now()
  }

  // Loop: ripples, active states, idle rotation, projected labels.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const live: RippleGfx[] = []
  /** Radius of the ripple at instant k (0 → 1): it starts from the center and dies out a little after the farthest knowledge. */
  const rippleRadius = (r: RippleGfx, k: number) => 0.05 + (r.zone.reach + 0.08) * k
  /** Strength of a ripple: 1, then toward 0 in SETTLE_MS once its zone is left. */
  const rippleGain = (r: RippleGfx, t: number) => (r.fade === undefined ? 1 : Math.max(0, 1 - (t - r.fade) / SETTLE_MS))
  /** Activity (in ms, browser clock) dating from the click just left, or coming back from it late. */
  const dismissed = (g: ZoneGfx, at: number) => at < g.dismissedAt + 3000
  const spawnRipple = (g: ZoneGfx, key: string, t: number) => {
    const mesh: RingMesh = new T.Mesh(geoRing, new T.MeshBasicMaterial({ color: g.glow, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false }))
    mesh.position.copy(g.center.position)
    group.add(mesh)
    live.push({ key, zone: g, mesh, start: t })
  }
  const pulse = { zone: null as string | null, next: 0, seq: 0 }
  const seen = new Set<string>()
  const tmp = new T.Vector3()
  let raf = 0
  let last = performance.now()

  const frame = (t: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (t - last) / 1000)
    last = t
    const nowMs = Date.now()

    if (!dragging && !reduced && t - state.lastInteraction > IDLE_MS) group.rotation.y += dt * 0.1
    camera.position.z += (state.zoomTarget - camera.position.z) * Math.min(1, dt * 8)
    fog.near = camera.position.z - 0.3
    fog.far = camera.position.z + 3.6

    const act = refs.activityRef.current
    const sel = refs.selectedRef.current
    // Zone selected with a click: a ripple starts right away (without waiting for the server round trip), then one every two seconds
    // while it stays selected.
    if (sel !== pulse.zone) {
      // The zone left goes dark: its current ripples fade, its click's activity does not light it again.
      const left = pulse.zone ? gfx.get(pulse.zone) : undefined
      if (left) {
        left.dismissedAt = nowMs
        for (const r of live) if (r.zone === left && r.fade === undefined) r.fade = t
      }
      pulse.zone = sel ?? null
      pulse.next = t
    }
    const selG = sel ? gfx.get(sel) : undefined
    if (selG && t >= pulse.next) {
      spawnRipple(selG, `sel-${++pulse.seq}`, t)
      pulse.next = reduced ? Infinity : t + PULSE_MS
    }
    for (const g of gfx.values()) {
      const a = act[g.id]
      g.active = Boolean(a && a.until > nowMs && !dismissed(g, a.startedAt))
      const isSel = sel === g.id
      g.selected = isSel
      const on = g.active || isSel
      g.lit = on
      // Light up and go dark gently: color, lines and ink circle follow the same share of lighting.
      const mix = g.mix + ((on ? 1 : 0) - g.mix) * Math.min(1, (dt * 1000) / (SETTLE_MS / 4))
      if (Math.abs(mix - g.mix) > 1e-4 || (on ? mix < 1 : mix > 0)) {
        g.mix = Math.abs(mix - (on ? 1 : 0)) < 0.003 ? (on ? 1 : 0) : mix
        g.center.material.color.setHex(g.locked ? NEUTRAL : g.color).lerp(tone.setHex(g.glow), g.mix)
        g.linkMat.color.setHex(LINE).lerp(tone.setHex(INK), g.mix)
        g.outlineMat.opacity = g.mix
      }
      // The ripple goes through the zone's knowledge: each one swells when the ripple's front reaches it.
      for (const node of g.nodes) {
        let pulse = 0
        if (!reduced)
          for (const r of live) {
            if (r.zone !== g) continue
            const k = (t - r.start) / RIPPLE_MS
            const front = rippleRadius(r, k)
            const off = ((node.userData.d as number) - front) / 0.07
            pulse = Math.max(pulse, Math.exp(-off * off) * (1 - k * 0.6) * rippleGain(r, t))
          }
        node.scale.setScalar((node.userData.r as number) * (1 + 0.6 * g.mix) * (1 + 1.4 * pulse))
      }
      g.outline.visible = g.mix > 0.01
      g.center.scale.setScalar(CENTER_R * (1 + 0.3 * g.mix))
      g.outline.scale.setScalar(g.center.scale.x * RIM)
    }
    shadeNetwork()
    for (const s of syn) {
      const on = Boolean(gfx.get(s.a)?.active || gfx.get(s.b)?.active)
      if (on !== s.active) {
        s.active = on
        s.mat.opacity = on ? 1 : s.baseOpacity
      }
    }

    const wanted = refs.ripplesRef.current
    for (const r of wanted) {
      if (seen.has(r.key)) continue
      seen.add(r.key)
      const g = gfx.get(r.zone)
      // The selected zone already has its ripples right away: the server's one (the click coming back) would be a duplicate.
      // So would one from a zone just left: it is the same click, back late.
      if (g && r.zone !== sel && !dismissed(g, nowMs)) spawnRipple(g, r.key, t)
    }
    for (const k of seen) if (!wanted.some((r) => r.key === k)) seen.delete(k)
    for (let i = live.length - 1; i >= 0; i--) {
      const r = live[i]
      const k = (t - r.start) / RIPPLE_MS
      const gain = rippleGain(r, t)
      if (k >= 1 || gain <= 0) {
        group.remove(r.mesh)
        r.mesh.material.dispose()
        live.splice(i, 1)
        continue
      }
      r.mesh.scale.setScalar(rippleRadius(r, k))
      r.mesh.material.opacity = 0.9 * (1 - k) * gain
      r.mesh.lookAt(camera.position)
    }

    shake(t)
    flowFrame(t / 1000)
    renderer.render(scene, camera)

    const centerDepth = tmp.set(0, 0, 0).project(camera).z
    // Pixels per scene unit at distance 1: used to measure each zone's bead on screen.
    const focal = (size.h / 2 / Math.tan((camera.fov * Math.PI) / 360)) * camera.zoom
    for (const g of gfx.values()) {
      const el = refs.labelsRef.current.get(g.id)
      if (!el) continue
      tmp.setFromMatrixPosition(g.center.matrixWorld)
      // The label always sits next to the bead (and its circle), never on top of it, whatever the zoom.
      const gap = (g.outline.scale.x * focal) / tmp.distanceTo(camera.position) + 6
      tmp.project(camera)
      const x = (tmp.x * 0.5 + 0.5) * size.w
      const y = (-tmp.y * 0.5 + 0.5) * size.h
      const behind = tmp.z > centerDepth
      const flip = x > size.w * 0.62
      el.style.transform = flip ? `translate(${(x - gap).toFixed(1)}px, ${(y - 12).toFixed(1)}px) translateX(-100%)` : `translate(${(x + gap).toFixed(1)}px, ${(y - 12).toFixed(1)}px)`
      el.classList.toggle("is-flip", flip)
      el.style.opacity = behind ? "0.45" : "1"
      el.style.zIndex = behind ? "1" : el.dataset.live ? "3" : "2"
      el.style.visibility = "visible"
    }

    placeDots(dt, t / 1000)
  }

  /**
   * Each zone pushes its members out of the brain: from the brain's projected center toward the zone's, stopping
   * just past the edge of the silhouette in that direction. Members of the same zone line up
   * side by side along the edge; two overlapping groups move apart.
   */
  const placeDots = (dt: number, time: number) => {
    if (dotGroups.length === 0) return
    const scale = clamp(ZOOM.start / camera.position.z, 0.7, 1.7)
    outline.forEach((p, i) => {
      tmp.copy(p).applyMatrix4(group.matrixWorld).project(camera)
      outlineXY[i * 2] = (tmp.x * 0.5 + 0.5) * size.w
      outlineXY[i * 2 + 1] = (-tmp.y * 0.5 + 0.5) * size.h
    })
    tmp.setFromMatrixPosition(group.matrixWorld).project(camera)
    const cx = (tmp.x * 0.5 + 0.5) * size.w
    const cy = (-tmp.y * 0.5 + 0.5) * size.h
    const targets: { id: string; x: number; y: number }[] = []
    for (const { zone, members } of dotGroups) {
      tmp.setFromMatrixPosition(zone.center.matrixWorld).project(camera)
      let dx = (tmp.x * 0.5 + 0.5) * size.w - cx
      let dy = (-tmp.y * 0.5 + 0.5) * size.h - cy
      const len = Math.hypot(dx, dy)
      if (len < 1) [dx, dy] = [0, -1]
      else [dx, dy] = [dx / len, dy / len]
      // Edge of the silhouette in that direction: the furthest projected point, among those close to the ray.
      let reach = 0
      for (let i = 0; i < outline.length; i++) {
        const px = outlineXY[i * 2] - cx
        const py = outlineXY[i * 2 + 1] - cy
        const along = px * dx + py * dy
        if (along > reach && Math.abs(px * dy - py * dx) < 40 * scale) reach = along
      }
      const r = reach + DOT_GAP * scale
      members.forEach((p, j) => {
        const side = (j - (members.length - 1) / 2) * DOT_SPACING * scale
        targets.push({ id: p.id, x: cx + dx * r - dy * side, y: cy + dy * r + dx * side })
      })
    }
    // A few spreading passes: two dots never overlap.
    const min = DOT_SPACING * scale * 0.9
    for (let pass = 0; pass < 4; pass++)
      for (let a = 0; a < targets.length; a++)
        for (let b = a + 1; b < targets.length; b++) {
          const A = targets[a]
          const B = targets[b]
          const ex = B.x - A.x
          const ey = B.y - A.y
          const d = Math.hypot(ex, ey) || 0.01
          if (d >= min) continue
          const push = (min - d) / 2
          A.x -= (ex / d) * push
          A.y -= (ey / d) * push
          B.x += (ex / d) * push
          B.y += (ey / d) * push
        }
    const ease = Math.min(1, dt * 6)
    const margin = 24
    // Depth of the brain's center: the dots are placed at that distance from the camera.
    const depth = tmp.set(0, 0, 0).project(camera).z
    for (const t of targets) {
      const d = dots.get(t.id)
      if (!d) continue
      const x = clamp(t.x, margin, size.w - margin)
      const y = clamp(t.y, margin + 20 * scale, size.h - margin)
      const cur = dotPos.get(t.id)
      const pos = cur ? { x: cur.x + (x - cur.x) * ease, y: cur.y + (y - cur.y) * ease } : { x, y }
      dotPos.set(t.id, pos)

      // The model: body center at the target point, facing the screen, turned slightly toward its zone.
      dotWorld.set((pos.x / size.w) * 2 - 1, -(pos.y / size.h) * 2 + 1, depth).unproject(camera)
      zoneWorld.setFromMatrixPosition(d.zone.center.matrixWorld)
      const who = refs.peopleRef.current.get(t.id)
      const hop = who?.live && !reduced ? Math.abs(Math.sin(time * 7 + d.phase)) * DOT_R * 0.9 : 0
      const breathe = who?.working && !reduced ? Math.sin(time * 2.4 + d.phase) * 0.05 : 0
      d.model.position.set(dotWorld.x, dotWorld.y - DOT_R * 0.79 + hop, dotWorld.z)
      d.model.quaternion.copy(camera.quaternion)
      d.model.rotateY(clamp((zoneWorld.x - dotWorld.x) * 1.2, -0.6, 0.6))
      d.model.scale.set(DOT_R * (1 - breathe * 0.5), DOT_R * (1 + breathe), DOT_R * (1 - breathe * 0.5))
      d.model.visible = true

      const el = refs.dotsRef.current.get(t.id)
      if (!el) continue
      el.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px) scale(${scale.toFixed(3)}) translate(-50%, -50%)`
      el.style.visibility = "visible"
    }
  }

  const start = () => {
    if (state.running || !state.visible || document.hidden) return
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
    { threshold: 0.05 },
  )
  io.observe(container)
  const onVisibility = () => (document.hidden ? stop() : start())
  document.addEventListener("visibilitychange", onVisibility)
  start()

  return () => {
    stop()
    io.disconnect()
    ro.disconnect()
    document.removeEventListener("visibilitychange", onVisibility)
    canvas.removeEventListener("pointerdown", onDown)
    canvas.removeEventListener("pointermove", onMove)
    canvas.removeEventListener("pointerup", onUp)
    canvas.removeEventListener("pointercancel", onUp)
    canvas.removeEventListener("wheel", onWheel)
    refs.zoomRef.current = () => {}
    refs.viewRef.current = { rx: group.rotation.x, ry: group.rotation.y, zoom: state.zoomTarget }
    for (const r of live) r.mesh.material.dispose()
    for (const g of geometries) g.dispose()
    for (const m of materials) m.dispose()
    neurons.dispose()
    flow.dispose()
    kit.dispose()
    renderer.dispose()
  }
}
