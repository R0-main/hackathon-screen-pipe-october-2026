"use client"

import { useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import type { ZoneView } from "@/lib/brain"
import { BrainViz, type Ripple, type ZoneActivity } from "./BrainViz"
import { hashString, seeded } from "./brain-geometry"
import { buildBrainShape, zoneAnchor, type BrainShape, type V3 } from "./brain-shape"
import { Dot, LockIcon, MinusIcon, PlusIcon, zoneColor } from "./ui"

type Synapse = { a: string; b: string; weight: number; via: string[] }

export type Brain3DProps = {
  zones: ZoneView[]
  synapses: Synapse[]
  activity: Record<string, ZoneActivity>
  ripples: Ripple[]
  now: number
  selected?: string | null
  onSelect?: (zone: string) => void
}

// Encre sur blanc. La seule couleur vive est le phosphore, réservé à une zone qu'un agent touche en direct.
const INK = 0x0a0a0a
const TRACE = 0x78786f
const LINE = 0xd6d6cf
const NEUTRAL = 0xb8b8b8
const PALE = 0xe4e4dd
const GREY = 0xcfcfc8
const WHITE = 0xffffff
const PHOSPHOR = 0xc7ff3e

const CENTER_R = 0.06
const ZOOM = { min: 2.8, max: 9, start: 5, step: 0.6 }
const IDLE_MS = 5000
const RIPPLE_MS = 2400
const PULSE_SPEED = 0.55

type ThreeModule = typeof import("three")
type SphereMesh = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
type RingMesh = THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>

type ZoneGfx = {
  id: string
  index: number
  locked: boolean
  color: number
  center: SphereMesh
  outline: SphereMesh
  nodes: SphereMesh[]
  nodeMat: THREE.MeshBasicMaterial
  linkMat: THREE.LineBasicMaterial
  active: boolean
  selected: boolean
}

type SynapseGfx = { a: string; b: string; mat: THREE.LineBasicMaterial; baseOpacity: number; active: boolean }
type RippleGfx = { key: string; mesh: RingMesh; start: number }
type View = { rx: number; ry: number; zoom: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const smooth = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/** La forme ne dépend de rien : on la calcule une fois pour toute la session. */
const shapeCache = new Map<string, BrainShape>()
const getBrainShape = (density: number, k: number) => {
  const key = `${density}:${k}`
  if (!shapeCache.has(key)) shapeCache.set(key, buildBrainShape(42, density, k))
  return shapeCache.get(key)!
}

/**
 * Variantes de rendu, choisies par ?cerveau=… dans l'URL (comparaison en cours, à trancher).
 * - reseau : le réseau complet, coloré par zone.
 * - silhouette : réseau clairsemé et gris, la couleur seulement en halo autour de chaque zone.
 * - points : pas de liaisons, un pointillé coloré, les régions séparées par un liseré vide.
 * - regions : réseau clairsemé coloré, régions séparées par un liseré vide, sans billes.
 */
type Style = { density: number; k: number; lines: boolean; halo: number; gap: number; billes: boolean; pulses: number; pointSize: number; lineOpacity: number }
const STYLES: Record<string, Style> = {
  reseau: { density: 1, k: 3, lines: true, halo: 0, gap: 0, billes: true, pulses: 90, pointSize: 0.03, lineOpacity: 0.8 },
  silhouette: { density: 0.5, k: 2, lines: true, halo: 0.55, gap: 0, billes: false, pulses: 30, pointSize: 0.028, lineOpacity: 0.9 },
  points: { density: 1.3, k: 0, lines: false, halo: 0, gap: 0.09, billes: false, pulses: 0, pointSize: 0.034, lineOpacity: 0 },
  regions: { density: 0.55, k: 2, lines: true, halo: 0, gap: 0.12, billes: false, pulses: 40, pointSize: 0.03, lineOpacity: 0.9 },
}
function currentStyle(): Style {
  if (typeof window === "undefined") return STYLES.reseau
  return STYLES[new URLSearchParams(window.location.search).get("cerveau") ?? ""] ?? STYLES.reseau
}

/** Pastille ronde pour dessiner les neurones (les points WebGL sont carrés sinon). */
function dotTexture(T: ThreeModule): THREE.CanvasTexture {
  const cv = document.createElement("canvas")
  cv.width = cv.height = 64
  const ctx = cv.getContext("2d")!
  ctx.fillStyle = "#fff"
  ctx.beginPath()
  ctx.arc(32, 32, 30, 0, Math.PI * 2)
  ctx.fill()
  return new T.CanvasTexture(cv)
}

/**
 * Le cerveau en trois dimensions : un réseau de neurones qui dessine hémisphères, cervelet et tronc,
 * coloré par zone. Les billes (les connaissances) sont des neurones de leur zone, reliées à son centre ;
 * des faisceaux courbes relient les zones et des influx courent le long des liaisons. On le fait tourner à la
 * souris, on zoome à la molette, en pinçant ou avec les boutons. Il remplit son conteneur : la page ne défile
 * pas, la molette ne sert qu'au zoom. Sans WebGL, on retombe sur la vue 2D.
 */
export function Brain3D(props: Brain3DProps) {
  const { zones, synapses, activity, ripples, now, selected, onSelect } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef(new Map<string, HTMLButtonElement>())
  const activityRef = useRef(activity)
  const ripplesRef = useRef(ripples)
  const selectedRef = useRef(selected)
  const onSelectRef = useRef(onSelect)
  const viewRef = useRef<View>({ rx: 0.18, ry: -0.85, zoom: ZOOM.start })
  const zoomRef = useRef<(delta: number) => void>(() => {})
  const [fallback, setFallback] = useState(false)
  activityRef.current = activity
  ripplesRef.current = ripples
  selectedRef.current = selected
  onSelectRef.current = onSelect

  // La scène est reconstruite seulement quand la structure change (zones, verrous, volumes, liens).
  const sceneKey = `${zones.map((z) => `${z.id}:${z.locked ? 1 : 0}:${z.count}:${zoneColor(z.color, z.position)}`).join("|")}#${synapses
    .map((s) => `${s.a}-${s.b}:${s.weight}`)
    .join("|")}`

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
          dispose = build(T, container, canvas, zones, synapses, { labelsRef, activityRef, ripplesRef, selectedRef, onSelectRef, viewRef, zoomRef })
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

      {/* Libellés : de vrais boutons, positionnés chaque image sur la projection de leur zone. */}
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
              <span className="flex items-start gap-1.5 rounded-[4px] bg-surface/90 px-1.5 py-0.5">
                <Dot color={zoneColor(z.color, z.position)} className="mt-[4px] sm:mt-[5px]" />
                <span>
                  <span className={`block whitespace-nowrap text-[12px] font-medium leading-tight sm:text-[13px] ${isSel ? "underline underline-offset-4" : ""}`}>{z.name}</span>
                  <span className="hidden whitespace-nowrap text-[12px] tabular-nums leading-tight text-trace sm:block">
                    {z.locked ? (
                      <span className="inline-flex items-center gap-1">
                        <LockIcon size={11} /> accès restreint
                      </span>
                    ) : (
                      `${z.count} connaissance${z.count > 1 ? "s" : ""}`
                    )}
                  </span>
                </span>
              </span>
              {live && (
                <span key={act!.startedAt} className="bubble-in mt-1 hidden max-w-[260px] items-start gap-1.5 rounded-[4px] border border-ink bg-surface px-2 py-1 text-[11.5px] leading-snug sm:flex">
                  <span className="mt-[3px] size-2 shrink-0 rounded-full border border-ink bg-phosphor" aria-hidden />
                  <span className="whitespace-normal">{act!.label}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="absolute bottom-4 right-4 flex flex-col gap-1.5">
        <button type="button" className="btn btn-icon" aria-label="Zoomer" onClick={() => zoomRef.current(-ZOOM.step)}>
          <PlusIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Dézoomer" onClick={() => zoomRef.current(ZOOM.step)}>
          <MinusIcon />
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-4 left-4 hidden text-[12px] text-trace sm:block">Glisser pour tourner, molette ou pincer pour zoomer.</p>
    </div>
  )
}

type Refs = {
  labelsRef: React.RefObject<Map<string, HTMLButtonElement>>
  activityRef: React.RefObject<Record<string, ZoneActivity>>
  ripplesRef: React.RefObject<Ripple[]>
  selectedRef: React.RefObject<string | null | undefined>
  onSelectRef: React.RefObject<((zone: string) => void) | undefined>
  viewRef: React.RefObject<View>
  zoomRef: React.RefObject<(delta: number) => void>
}

/** Construit la scène et lance la boucle de rendu. Renvoie la fonction de nettoyage. */
function build(T: ThreeModule, container: HTMLDivElement, canvas: HTMLCanvasElement, zones: ZoneView[], synapses: Synapse[], refs: Refs): () => void {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)

  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(36, 1, 0.1, 50)
  const view = refs.viewRef.current
  const state = { zoomTarget: view.zoom, lastInteraction: -Infinity, visible: true, running: false }
  camera.position.set(0, 0.15, view.zoom)
  camera.lookAt(0, 0, 0)

  const group = new T.Group()
  group.rotation.x = view.rx
  group.rotation.y = view.ry
  scene.add(group)

  const geoSphere = new T.SphereGeometry(1, 20, 14)
  const geoRing = new T.RingGeometry(0.93, 1, 48)
  const outlineMat = new T.MeshBasicMaterial({ color: INK, side: T.BackSide })
  const dotTex = dotTexture(T)
  const geometries: THREE.BufferGeometry[] = [geoSphere, geoRing]
  const materials: THREE.Material[] = [outlineMat]

  // Le réseau de neurones qui dessine le cerveau (hémisphères, cervelet, tronc).
  const style = currentStyle()
  const shape = getBrainShape(style.density, Math.max(1, style.k))
  const P = shape.positions
  const NRM = shape.normals
  const nPts = P.length / 3
  const pointAt = (i: number) => new T.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])
  const normalAt = (i: number) => new T.Vector3(NRM[i * 3], NRM[i * 3 + 1], NRM[i * 3 + 2])
  const dist2 = (i: number, v: V3) => (P[i * 3] - v[0]) ** 2 + (P[i * 3 + 1] - v[1]) ** 2 + (P[i * 3 + 2] - v[2]) ** 2

  // Chaque zone s'ancre sur un neurone ; chaque neurone appartient à la zone la plus proche (Voronoï).
  const n = zones.length
  const anchors = zones.map((_, i) => {
    const target = zoneAnchor(i, n)
    let best = 0
    let bd = Infinity
    for (let k = 0; k < nPts; k++) {
      const d = dist2(k, target)
      if (d < bd) [bd, best] = [d, k]
    }
    return best
  })
  const anchorPos: V3[] = anchors.map((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]])
  const owner = new Int32Array(nPts)
  const ownerDist = new Float32Array(nPts)
  const hidden = new Uint8Array(nPts)
  for (let k = 0; k < nPts; k++) {
    let bz = 0
    let bd = Infinity
    let second = Infinity
    anchorPos.forEach((a, zi) => {
      const d = dist2(k, a)
      if (d < bd) {
        second = bd
        ;[bd, bz] = [d, zi]
      } else if (d < second) second = d
    })
    owner[k] = bz
    ownerDist[k] = Math.sqrt(bd)
    // Liseré vide entre deux régions : on retire les neurones presque à égale distance de deux zones.
    if (style.gap && Math.sqrt(second) - Math.sqrt(bd) < style.gap) hidden[k] = 1
  }

  const zoneHex = zones.map((z) => (z.locked ? NEUTRAL : new T.Color(zoneColor(z.color, z.position)).getHex()))
  const pale = new T.Color(PALE)
  const grey = new T.Color(GREY)
  const baseColors = new Float32Array(nPts * 3)
  const c = new T.Color()
  for (let k = 0; k < nPts; k++) {
    // Couleur pleine près du centre de la zone, qui pâlit vers ses frontières.
    const f = style.halo ? smooth(style.halo * 0.5, style.halo, ownerDist[k]) : 0.04 + 0.3 * smooth(0.3, 1.3, ownerDist[k])
    c.setHex(zoneHex[owner[k]]).lerp(style.halo ? grey : pale, f)
    baseColors.set([c.r, c.g, c.b], k * 3)
  }
  const liveColors = baseColors.slice()

  const neuronGeo = new T.BufferGeometry()
  neuronGeo.setAttribute("position", new T.BufferAttribute(P, 3))
  const neuronColor = new T.BufferAttribute(liveColors, 3)
  neuronGeo.setAttribute("color", neuronColor)
  if (style.gap) {
    const keep: number[] = []
    for (let k = 0; k < nPts; k++) if (!hidden[k]) keep.push(k)
    neuronGeo.setIndex(keep)
  }
  const neuronMat = new T.PointsMaterial({ size: style.pointSize, vertexColors: true, map: dotTex, alphaTest: 0.4, transparent: true, sizeAttenuation: true })
  group.add(new T.Points(neuronGeo, neuronMat))

  const E = style.lines ? shape.edges.filter((_, i, arr) => !hidden[arr[i - (i % 2)]] && !hidden[arr[i - (i % 2) + 1]]) : new Uint32Array(0)
  const nEdges = E.length / 2
  const edgePos = new Float32Array(nEdges * 6)
  const edgeCol = new Float32Array(nEdges * 6)
  for (let e = 0; e < nEdges; e++) {
    edgePos.set(P.subarray(E[e * 2] * 3, E[e * 2] * 3 + 3), e * 6)
    edgePos.set(P.subarray(E[e * 2 + 1] * 3, E[e * 2 + 1] * 3 + 3), e * 6 + 3)
  }
  const edgeGeo = new T.BufferGeometry()
  edgeGeo.setAttribute("position", new T.BufferAttribute(edgePos, 3))
  const edgeColor = new T.BufferAttribute(edgeCol, 3)
  edgeGeo.setAttribute("color", edgeColor)
  const edgeMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: style.lineOpacity, depthWrite: false })
  if (nEdges) group.add(new T.LineSegments(edgeGeo, edgeMat))
  geometries.push(neuronGeo, edgeGeo)
  materials.push(neuronMat, edgeMat)

  /** Recopie les couleurs des neurones sur les liaisons et pousse le tout au GPU. */
  const refreshColors = () => {
    for (let e = 0; e < nEdges; e++) {
      edgeCol.set(liveColors.subarray(E[e * 2] * 3, E[e * 2] * 3 + 3), e * 6)
      edgeCol.set(liveColors.subarray(E[e * 2 + 1] * 3, E[e * 2 + 1] * 3 + 3), e * 6 + 3)
    }
    neuronColor.needsUpdate = true
    edgeColor.needsUpdate = true
  }
  refreshColors()

  const regions = zones.map((_, zi) => {
    const idx: number[] = []
    for (let k = 0; k < nPts; k++) if (owner[k] === zi) idx.push(k)
    return idx
  })
  const phosphor = new T.Color(PHOSPHOR)
  const paintRegion = (zi: number, on: boolean) => {
    for (const k of regions[zi]) {
      if (on) {
        c.setRGB(baseColors[k * 3], baseColors[k * 3 + 1], baseColors[k * 3 + 2]).lerp(phosphor, 0.85)
        liveColors.set([c.r, c.g, c.b], k * 3)
      } else liveColors.set(baseColors.subarray(k * 3, k * 3 + 3), k * 3)
    }
  }

  const gfx = new Map<string, ZoneGfx>()
  const pickables: THREE.Object3D[] = []

  zones.forEach((z, zi) => {
    const rand = seeded(hashString(z.id))
    const a = anchors[zi]
    const centerPos = pointAt(a).add(normalAt(a).multiplyScalar(0.16))
    const color = zoneHex[zi]

    const centerMat = new T.MeshBasicMaterial({ color: z.locked ? WHITE : color })
    const center: SphereMesh = new T.Mesh(geoSphere, centerMat)
    center.position.copy(centerPos)
    center.scale.setScalar(CENTER_R)
    center.userData.zone = z.id
    const outline: SphereMesh = new T.Mesh(geoSphere, outlineMat)
    outline.position.copy(centerPos)
    outline.scale.setScalar(CENTER_R * 1.22)
    group.add(outline, center)
    pickables.push(center)

    // Les connaissances sont des neurones de la zone, pris autour de son ancrage.
    const count = !style.billes ? 0 : z.locked ? 5 : 4 + Math.min(16, Math.round(Math.sqrt(z.count) * 2.2))
    const pool = regions[zi].filter((k) => !hidden[k]).sort((p, q) => dist2(p, anchorPos[zi]) - dist2(q, anchorPos[zi]))
    const picked = pool.slice(0, count * 4).filter(() => rand() < 0.35).slice(0, count)
    const nodeMat = new T.MeshBasicMaterial({ color: z.locked ? NEUTRAL : INK })
    const nodes: SphereMesh[] = []
    const linkPts: THREE.Vector3[] = []
    for (const k of picked) {
      const p = pointAt(k).add(normalAt(k).multiplyScalar(0.015))
      const r = 0.012 + rand() * 0.01
      const node: SphereMesh = new T.Mesh(geoSphere, nodeMat)
      node.position.copy(p)
      node.scale.setScalar(r)
      node.userData.zone = z.id
      node.userData.r = r
      group.add(node)
      nodes.push(node)
      pickables.push(node)
      linkPts.push(centerPos.clone(), p)
    }
    const linkMat = new T.LineBasicMaterial({ color: LINE, transparent: true, opacity: 1 })
    const linkGeo = new T.BufferGeometry().setFromPoints(linkPts)
    group.add(new T.LineSegments(linkGeo, linkMat))
    geometries.push(linkGeo)
    materials.push(centerMat, nodeMat, linkMat)
    gfx.set(z.id, { id: z.id, index: zi, locked: z.locked, color, center, outline, nodes, nodeMat, linkMat, active: false, selected: false })
  })

  // Synapses : faisceaux courbes qui passent par l'intérieur du cerveau entre deux zones qui partagent des entités.
  const syn: SynapseGfx[] = []
  for (const s of synapses) {
    const A = gfx.get(s.a)
    const B = gfx.get(s.b)
    if (!A || !B) continue
    const a = A.center.position
    const b = B.center.position
    const mid = a.clone().add(b).multiplyScalar(0.2)
    const pts = new T.QuadraticBezierCurve3(a.clone(), mid, b.clone()).getPoints(32)
    const baseOpacity = 0.2 + Math.min(0.3, Math.log2(1 + s.weight) * 0.07)
    const mat = new T.LineBasicMaterial({ color: TRACE, transparent: true, opacity: baseOpacity, depthWrite: false })
    const geo = new T.BufferGeometry().setFromPoints(pts)
    group.add(new T.Line(geo, mat))
    geometries.push(geo)
    materials.push(mat)
    syn.push({ a: s.a, b: s.b, mat, baseOpacity, active: false })
  }

  // Influx : de petites impulsions qui courent de neurone en neurone le long des liaisons.
  const adj = shape.adjacency
  const PULSES = style.pulses
  const pulses = Array.from({ length: PULSES }, () => ({ from: 0, to: 0, t: 0, len: 1 }))
  const pulsePos = new Float32Array(PULSES * 3)
  const pulseGeo = new T.BufferGeometry()
  const pulseAttr = new T.BufferAttribute(pulsePos, 3)
  pulseGeo.setAttribute("position", pulseAttr)
  const pulseMat = new T.PointsMaterial({ color: INK, size: 0.05, map: dotTex, alphaTest: 0.4, transparent: true, depthWrite: false, sizeAttenuation: true })
  const pulsePoints = new T.Points(pulseGeo, pulseMat)
  group.add(pulsePoints)
  geometries.push(pulseGeo)
  materials.push(pulseMat)
  const edgeLen = (a: number, b: number) => Math.sqrt(dist2(b, [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]])) || 0.05
  const activeRegions: number[] = []
  const spawn = (p: (typeof pulses)[number]) => {
    // Un influx sur deux naît dans une zone active, s'il y en a une.
    const region = activeRegions.length && Math.random() < 0.5 ? regions[activeRegions[(Math.random() * activeRegions.length) | 0]] : null
    let from = region && region.length ? region[(Math.random() * region.length) | 0] : (Math.random() * nPts) | 0
    if (!adj[from].length) from = E[((Math.random() * nEdges) | 0) * 2]
    p.from = from
    p.to = adj[from][(Math.random() * adj[from].length) | 0]
    p.t = Math.random()
    p.len = edgeLen(p.from, p.to)
  }
  for (const p of pulses) spawn(p)
  const stepPulses = (dt: number) => {
    for (let i = 0; i < PULSES; i++) {
      const p = pulses[i]
      p.t += (dt * PULSE_SPEED) / p.len
      if (p.t >= 1) {
        if (Math.random() < 0.06) spawn(p)
        else {
          const next = adj[p.to].filter((k) => k !== p.from)
          p.from = p.to
          p.to = next.length ? next[(Math.random() * next.length) | 0] : adj[p.to][0]
          p.t = 0
          p.len = edgeLen(p.from, p.to)
        }
      }
      const a = p.from * 3
      const b = p.to * 3
      pulsePos[i * 3] = P[a] + (P[b] - P[a]) * p.t
      pulsePos[i * 3 + 1] = P[a + 1] + (P[b + 1] - P[a + 1]) * p.t
      pulsePos[i * 3 + 2] = P[a + 2] + (P[b + 2] - P[a + 2]) * p.t
    }
    pulseAttr.needsUpdate = true
  }

  // Taille : le canvas suit son conteneur.
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

  // Interaction : glisser pour tourner, clic pour ouvrir une zone, molette (ou pincer au pavé tactile) pour zoomer.
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
  // Doigts posés : à deux, l'écart entre eux zoome (pincer sur écran tactile).
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
    // Pincer au pavé tactile arrive en molette + Ctrl, avec de petits deltas : on l'amplifie.
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

  // Boucle : ondes, états actifs, rotation d'attente, libellés projetés.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  pulsePoints.visible = !reduced
  const live: RippleGfx[] = []
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

    const act = refs.activityRef.current
    const sel = refs.selectedRef.current
    let colorsDirty = false
    for (const g of gfx.values()) {
      const a = act[g.id]
      const on = Boolean(a && a.until > nowMs)
      if (on !== g.active) {
        g.active = on
        paintRegion(g.index, on)
        colorsDirty = true
        g.center.material.color.setHex(on ? PHOSPHOR : g.locked ? WHITE : g.color)
        g.nodeMat.color.setHex(on ? PHOSPHOR : g.locked ? NEUTRAL : INK)
        g.linkMat.color.setHex(on ? INK : LINE)
        for (const node of g.nodes) node.scale.setScalar((node.userData.r as number) * (on ? 1.5 : 1))
      }
      const isSel = sel === g.id
      if (isSel !== g.selected) {
        g.selected = isSel
        g.outline.scale.setScalar(CENTER_R * (isSel ? 1.5 : 1.22))
      }
      const target = CENTER_R * (on ? 1.3 : 1)
      g.center.scale.setScalar(g.center.scale.x + (target - g.center.scale.x) * Math.min(1, dt * 10))
    }
    if (colorsDirty) {
      refreshColors()
      activeRegions.length = 0
      for (const g of gfx.values()) if (g.active) activeRegions.push(g.index)
    }
    if (!reduced) stepPulses(dt)
    for (const s of syn) {
      const on = Boolean(gfx.get(s.a)?.active || gfx.get(s.b)?.active)
      if (on !== s.active) {
        s.active = on
        s.mat.color.setHex(on ? INK : TRACE)
        s.mat.opacity = on ? 0.9 : s.baseOpacity
      }
    }

    const wanted = refs.ripplesRef.current
    for (const r of wanted) {
      if (seen.has(r.key)) continue
      seen.add(r.key)
      const g = gfx.get(r.zone)
      if (!g) continue
      const mesh: RingMesh = new T.Mesh(geoRing, new T.MeshBasicMaterial({ color: PHOSPHOR, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false }))
      mesh.position.copy(g.center.position)
      group.add(mesh)
      live.push({ key: r.key, mesh, start: t })
    }
    for (const k of seen) if (!wanted.some((r) => r.key === k)) seen.delete(k)
    for (let i = live.length - 1; i >= 0; i--) {
      const r = live[i]
      const k = (t - r.start) / RIPPLE_MS
      if (k >= 1) {
        group.remove(r.mesh)
        r.mesh.material.dispose()
        live.splice(i, 1)
        continue
      }
      r.mesh.scale.setScalar(0.05 + 0.42 * k)
      r.mesh.material.opacity = 0.9 * (1 - k)
      r.mesh.lookAt(camera.position)
    }

    renderer.render(scene, camera)

    const centerDepth = tmp.set(0, 0, 0).project(camera).z
    for (const g of gfx.values()) {
      const el = refs.labelsRef.current.get(g.id)
      if (!el) continue
      tmp.setFromMatrixPosition(g.center.matrixWorld).project(camera)
      const x = (tmp.x * 0.5 + 0.5) * size.w
      const y = (-tmp.y * 0.5 + 0.5) * size.h
      const behind = tmp.z > centerDepth
      const flip = x > size.w * 0.62
      el.style.transform = flip ? `translate(${(x - 10).toFixed(1)}px, ${(y - 14).toFixed(1)}px) translateX(-100%)` : `translate(${(x + 10).toFixed(1)}px, ${(y - 14).toFixed(1)}px)`
      el.classList.toggle("is-flip", flip)
      el.style.opacity = behind ? "0.45" : "1"
      el.style.zIndex = behind ? "1" : el.dataset.live ? "3" : "2"
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
    dotTex.dispose()
    renderer.dispose()
  }
}
