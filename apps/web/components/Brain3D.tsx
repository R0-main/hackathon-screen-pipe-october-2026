"use client"

import { useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import type { ZoneView } from "@/lib/brain"
import { BrainViz, type Ripple, type ZoneActivity } from "./BrainViz"
import { hashString, scatter, seeded, zoneDirection } from "./brain-geometry"
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
const WHITE = 0xffffff
const PHOSPHOR = 0xc7ff3e

const RADIUS = 1.25
const AXES = { x: 1.3, y: 1, z: 0.95 }
const CENTER_R = 0.06
const ZOOM = { min: 2.6, max: 8, start: 5, step: 0.6 }
const IDLE_MS = 5000
const RIPPLE_MS = 2400

type ThreeModule = typeof import("three")
type SphereMesh = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
type RingMesh = THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>

type ZoneGfx = {
  id: string
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

/**
 * Le cerveau en trois dimensions : des billes (les connaissances) groupées par zone sur une coque
 * ellipsoïdale, reliées à leur centre et entre zones par des traits fins. On le fait tourner à la
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
  const viewRef = useRef<View>({ rx: 0.28, ry: -0.35, zoom: ZOOM.start })
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
  camera.position.set(0, 0.2, view.zoom)
  camera.lookAt(0, 0, 0)

  const group = new T.Group()
  group.rotation.x = view.rx
  group.rotation.y = view.ry
  scene.add(group)

  const geoSphere = new T.SphereGeometry(1, 20, 14)
  const geoRing = new T.RingGeometry(0.93, 1, 48)
  const outlineMat = new T.MeshBasicMaterial({ color: INK, side: T.BackSide })
  const geometries: THREE.BufferGeometry[] = [geoSphere, geoRing]
  const materials: THREE.Material[] = [outlineMat]

  /** Point de la coque dans la direction d, à la fraction k du rayon. */
  const onShell = (d: [number, number, number], k: number) => new T.Vector3(d[0] * RADIUS * AXES.x * k, d[1] * RADIUS * AXES.y * k, d[2] * RADIUS * AXES.z * k)

  const n = zones.length
  const spread = Math.min(1.1, 2.2 / Math.sqrt(Math.max(1, n)))
  const gfx = new Map<string, ZoneGfx>()
  const pickables: THREE.Object3D[] = []

  zones.forEach((z, i) => {
    const rand = seeded(hashString(z.id))
    const dir = zoneDirection(i, n)
    const centerPos = onShell(dir, 0.86)
    const color = new T.Color(zoneColor(z.color, z.position)).getHex()

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

    const count = z.locked ? 5 : 4 + Math.min(16, Math.round(Math.sqrt(z.count) * 2.2))
    const nodeMat = new T.MeshBasicMaterial({ color: z.locked ? NEUTRAL : INK })
    const nodes: SphereMesh[] = []
    const linkPts: THREE.Vector3[] = []
    for (let k = 0; k < count; k++) {
      const p = onShell(scatter(dir, rand, spread), 0.95 + rand() * 0.1)
      const r = 0.02 + rand() * 0.018
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
    gfx.set(z.id, { id: z.id, locked: z.locked, color, center, outline, nodes, nodeMat, linkMat, active: false, selected: false })
  })

  // Synapses : cordes entre deux zones qui partagent des entités, plus marquées quand elles sont actives.
  const syn: SynapseGfx[] = []
  for (const s of synapses) {
    const A = gfx.get(s.a)
    const B = gfx.get(s.b)
    if (!A || !B) continue
    const pts = [A.center.position.clone(), B.center.position.clone()]
    const baseOpacity = 0.18 + Math.min(0.27, Math.log2(1 + s.weight) * 0.06)
    const mat = new T.LineBasicMaterial({ color: TRACE, transparent: true, opacity: baseOpacity })
    const geo = new T.BufferGeometry().setFromPoints(pts)
    group.add(new T.Line(geo, mat))
    geometries.push(geo)
    materials.push(mat)
    syn.push({ a: s.a, b: s.b, mat, baseOpacity, active: false })
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
    for (const g of gfx.values()) {
      const a = act[g.id]
      const on = Boolean(a && a.until > nowMs)
      if (on !== g.active) {
        g.active = on
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
    renderer.dispose()
  }
}
