import type * as THREE from "three"
import { hashString } from "./brain-geometry"

type ThreeModule = typeof import("three")

/** The dots' outfits: chosen from the person's id, they never change from one visit to the next. */
export const LOOKS = ["plain", "beret", "frog", "glasses", "shades"] as const
export type DotLook = (typeof LOOKS)[number]

export const dotLook = (id: string): DotLook => LOOKS[hashString(id) % LOOKS.length]

const INK = 0x141414

/** Resources shared by all the dots of a scene: geometries and black materials, freed together. */
export type DotKit = { make: (color: number, look: DotLook) => THREE.Group; dispose: () => void }

/**
 * A person's dot in 3D: a felt ball (velvet sheen), slightly squashed, in their zone's
 * color, with their outfit. Model of one unit of radius, facing +z; the base rests on y = 0.
 */
export function dotKit(T: ThreeModule): DotKit {
  // The body: a flat-based dome (turned profile), like a drop of felt set down.
  const body = new T.LatheGeometry(
    [[0, 0], [0.84, 0], [0.97, 0.07], [1.02, 0.24], [1, 0.5], [0.94, 0.8], [0.82, 1.1], [0.62, 1.36], [0.36, 1.52], [0, 1.58]].map(([x, y]) => new T.Vector2(x, y)),
    40,
  )
  body.computeVertexNormals()
  const sphere = new T.SphereGeometry(1, 24, 18)
  const torus = new T.TorusGeometry(1, 0.16, 10, 28)
  const disc = new T.CylinderGeometry(1, 1, 0.25, 24)
  const ink = new T.MeshStandardMaterial({ color: INK, roughness: 0.55, fog: false })
  const white = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, fog: false })
  const owned: THREE.Material[] = []

  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], scale: [number, number, number]) => {
    const m = new T.Mesh(geo, mat)
    m.position.set(...pos)
    m.scale.set(...scale)
    return m
  }

  const make = (color: number, look: DotLook) => {
    const felt = new T.MeshPhysicalMaterial({ color, roughness: 0.95, sheen: 1, sheenRoughness: 0.45, sheenColor: new T.Color(0xffffff), fog: false })
    owned.push(felt)
    const dot = new T.Group()
    dot.add(part(body, felt, [0, 0, 0], [1, 1, 0.92]))
    const eyeY = 0.86
    const eyeZ = 0.82
    if (look === "frog") {
      for (const x of [-0.42, 0.42]) {
        dot.add(part(sphere, felt, [x, 1.36, 0.2], [0.36, 0.36, 0.34]))
        dot.add(part(sphere, white, [x, 1.4, 0.44], [0.23, 0.23, 0.14]))
        dot.add(part(sphere, ink, [x * 1.05, 1.4, 0.56], [0.12, 0.12, 0.06]))
      }
    } else if (look === "glasses") {
      for (const x of [-0.36, 0.36]) {
        dot.add(part(torus, ink, [x, eyeY, eyeZ + 0.06], [0.26, 0.26, 0.26]))
        dot.add(part(sphere, ink, [x, eyeY - 0.04, eyeZ + 0.02], [0.11, 0.035, 0.04]))
      }
      dot.add(part(disc, ink, [0, eyeY + 0.02, eyeZ + 0.1], [0.05, 0.9, 0.05]).rotateZ(Math.PI / 2))
    } else if (look === "shades") {
      for (const x of [-0.36, 0.36]) dot.add(part(disc, ink, [x, eyeY, eyeZ + 0.06], [0.26, 0.26, 0.26]).rotateX(Math.PI / 2))
      dot.add(part(disc, ink, [0, eyeY + 0.03, eyeZ + 0.1], [0.05, 0.9, 0.05]).rotateZ(Math.PI / 2))
    } else {
      for (const x of [-0.28, 0.28]) dot.add(part(sphere, ink, [x, eyeY, eyeZ + 0.04], [0.1, 0.16, 0.06]))
    }
    if (look === "beret") {
      const beret = new T.Group()
      beret.add(part(sphere, ink, [0, 0, 0], [0.95, 0.28, 0.9]))
      beret.add(part(sphere, ink, [0, 0.3, 0], [0.12, 0.12, 0.12]))
      beret.position.set(-0.1, 1.5, -0.04)
      beret.rotation.z = 0.22
      dot.add(beret)
    }
    return dot
  }

  return {
    make,
    dispose: () => {
      for (const g of [body, sphere, torus, disc]) g.dispose()
      for (const m of [ink, white, ...owned]) m.dispose()
    },
  }
}
