// Le flux entre zones, partagé par le cerveau du dashboard et celui de la page d'accueil : des arcs en tubes,
// dans lesquels circulent de petites billes de lumière, l'arc gonflant légèrement autour de chacune.

import type * as THREE from "three"
import { hashString } from "./brain-geometry"

type ThreeModule = typeof import("three")

/** Assez d'anneaux pour que l'arc gonfle en douceur autour d'une bille, pas plus longue que deux ou trois d'entre eux. */
const TUBULAR = 384
const RADIAL = 6
/**
 * Les billes : par sens et par arc, leur nombre ; leur vitesse (en tours d'arc par seconde) ; leur rayon, relatif à
 * celui de l'arc (sous 1 : elles restent dans le trait) ; leur part de blanc, qui les fait ressortir sur sa couleur.
 */
const BEADS_PER_WAY = 4
const BEAD_SPEED = 0.1
const BEAD_R = 0.6
const BEAD_LIGHT = 0.88
/** Allongement des billes le long de l'arc : leur longueur vaut BEAD_STRETCH fois leur largeur. */
const BEAD_STRETCH = 3
/** Gonflement de l'arc autour de chaque bille : rayon ajouté au cœur de la bille, en part du rayon de l'arc. */
const BEAD_BULGE = 0.55
/** Accélération des billes sur l'arc d'une zone active. */
const FAST = 1.8

/** Un arc entre deux zones, avec ce qu'il faut pour y faire circuler les billes et le faire gonfler. */
export type FlowArc = {
  curve: THREE.CatmullRomCurve3
  from: THREE.Color
  to: THREE.Color
  radius: number
  /** Décalage de départ des billes, propre à chaque arc : elles ne partent pas toutes ensemble. */
  phase: number
  /** Le tube : centre de chaque anneau, et direction de chaque sommet depuis ce centre. */
  tube: THREE.BufferAttribute
  rings: Float32Array
  spokes: Float32Array
  length: number
  /** À régler par l'appelant à chaque image : billes plus rapides (zone active), force du gonflement (0 à 1). */
  fast: boolean
  gain: number
}

/** Le tube d'un arc, en dégradé de la couleur d'une zone à celle de l'autre, prêt à gonfler autour de ses billes. */
export function arcTube(T: ThreeModule, pts: THREE.Vector3[], from: THREE.Color, to: THREE.Color, radius: number, key: string) {
  const curve = new T.CatmullRomCurve3(pts)
  const geo = new T.TubeGeometry(curve, TUBULAR, radius, RADIAL, false)
  const tube = geo.attributes.position as THREE.BufferAttribute
  const cols = new Float32Array(tube.count * 3)
  const tone = new T.Color()
  // Les sommets du tube vont anneau par anneau : l'anneau donne la position le long de l'arc.
  for (let v = 0; v < tube.count; v++) tone.copy(from).lerp(to, Math.floor(v / (RADIAL + 1)) / TUBULAR).toArray(cols, v * 3)
  geo.setAttribute("color", new T.BufferAttribute(cols, 3))
  // Chaque anneau est centré sur l'arc (au même point que TubeGeometry) ; chaque sommet en part dans une direction
  // fixe : le gonflement l'y pousse plus loin.
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
 * Les billes de lumière de tous les arcs, dans un seul maillage : dans chaque arc, de petites billes vont de A vers
 * B et d'autres de B vers A, en continu et régulièrement espacées. Chacune prend la couleur de l'arc là où elle
 * passe, très éclaircie ; elles rapetissent jusqu'à disparaître en arrivant sur une zone. Dessinées après les arcs
 * (transparents), elles se voient dans le trait au lieu d'être teintées par lui.
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

  /** L'arc gonfle légèrement autour de chaque bille, sur sa longueur à elle : une bosse douce qui la suit. */
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

  /** Une image du flux, `time` en secondes. */
  const frame = (time: number) => {
    let n = 0
    for (const a of arcs) {
      const run = time * BEAD_SPEED * (a.fast ? FAST : 1) + a.phase
      on.length = 0
      for (let j = 0; j < BEADS_PER_WAY * 2; j++) {
        // Les billes paires vont de A vers B, les impaires de B vers A ; chaque sens est décalé d'une demi-bille.
        const along = (run + Math.floor(j / 2) / BEADS_PER_WAY + (j % 2) * (0.5 / BEADS_PER_WAY)) % 1
        const u = j % 2 === 0 ? along : 1 - along
        a.curve.getPointAt(u, at)
        // Allongée dans le sens de l'arc : son grand axe suit la tangente au point où elle passe.
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
