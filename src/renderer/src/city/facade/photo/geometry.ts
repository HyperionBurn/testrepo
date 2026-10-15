import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three'
import { FACADE_SETS } from './sets'

export interface FacadeBoxOptions {
  /** Footprint in metres. */
  width: number
  depth: number
  /** Height in metres. */
  height: number
  /** Index into FACADE_SETS. */
  facade: number
  /** Lit fraction 0..1. */
  lit: number
  /** Per-building seed 0..1 (drives the window grid offset and tint). */
  seed: number
  /** Optional world offset for the box base centre. */
  x?: number
  z?: number
}

/**
 * Axis-aligned box with the facade attributes the photo material reads. Walls: aFacadeUV.x runs
 * metres along the wall from its left corner, y metres up from the base (grade). Roof: one quad,
 * aFacadeUV is the roof-plane position in metres. Units are metres here;
 * the caller scales to world units (1 unit = 10 m).
 */
export function buildFacadeBox(o: FacadeBoxOptions): BufferGeometry {
  if (o.facade < 0 || o.facade >= FACADE_SETS.length) throw new Error(`facade set ${o.facade} out of range`)
  const x0 = (o.x ?? 0) - o.width / 2
  const x1 = (o.x ?? 0) + o.width / 2
  const z0 = -(o.depth / 2) + (o.z ?? 0)
  const z1 = o.depth / 2 + (o.z ?? 0)
  const h = o.height
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const fac: number[] = []
  const fuv: number[] = []
  const lit: number[] = []
  const seed: number[] = []
  const push = (p: number[], n: number[], u: number, v: number, fu: number, fv: number) => {
    pos.push(...p)
    nor.push(...n)
    uv.push(u, v)
    fac.push(o.facade)
    fuv.push(fu, fv)
    lit.push(o.lit)
    seed.push(o.seed)
  }
  // Each wall: two triangles, counter-clockwise seen from outside.
  const wall = (a: [number, number], b: [number, number], n: [number, number, number]) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const quad: Array<[number, number, number, number]> = [
      [a[0], 0, a[1], 0], [b[0], 0, b[1], len], [b[0], h, b[1], len], [a[0], h, a[1], 0],
    ]
    const ord = [0, 1, 2, 0, 2, 3]
    for (const k of ord) {
      const [px, py, pz, fu] = quad[k]
      const fv = py
      push([px, py, pz], n, fu / Math.max(len, 1e-6), py / h, fu, fv)
    }
  }
  wall([x0, z1], [x1, z1], [0, 0, 1])     // front (+z)
  wall([x1, z0], [x0, z0], [0, 0, -1])    // back (-z)
  wall([x1, z1], [x1, z0], [1, 0, 0])     // right (+x)
  wall([x0, z0], [x0, z1], [-1, 0, 0])    // left (-x)
  // Roof.
  const roofQuad: Array<[number, number]> = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
  for (const k of [0, 2, 1, 0, 3, 2]) {   // counter-clockwise seen from above
    const [rx, rz] = roofQuad[k]
    push([rx, h, rz], [0, 1, 0], (rx - x0) / o.width, (rz - z0) / o.depth, rx, rz)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setAttribute('aFacade', new BufferAttribute(new Float32Array(fac), 1))
  g.setAttribute('aFacadeUV', new BufferAttribute(new Float32Array(fuv), 2))
  g.setAttribute('aLit', new BufferAttribute(new Float32Array(lit), 1))
  g.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1))
  g.computeBoundingBox()
  return g
}
