// Bridges: two Brooklyn-style suspension bridges that cross the rivers, from the far banks to the island edge. Each has two
// towers on piers in the water. A tower is two dark warm-stone legs with two pointed Gothic arches on each face, a
// cross-bracing band and a pinnacle; warm uplights from the water and the deck light the lower stone. The main cables are
// true catenaries between the tower saddles, with side spans down to the anchorages, and vertical suspenders. A lit string
// of cable lights follows the cables. The deck has steel rails and a row of sodium lamps on each edge, and cars run along
// two lanes (headlights one way, tail lights the other). Static geometry is built once; only the car points move, on the
// shared clock. Four draw calls per bridge, eight in all. Holds still under reduced motion.
import { useEffect, useMemo } from 'react'
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, Points, PointsMaterial
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useFrame } from '@react-three/fiber'
import { useSky } from '../state/store'
import { BRIDGES, type BridgeSpec } from './metro'
import { gateNightMaterial } from './lighting'

const SUN = [0.4, 0.8, 0.3] as const
/** Dark warm stone (brownstone and granite at night), not blue. */
const STONE = new Color('#33281f')
const STEEL = new Color('#1d1d22')
const ARCH = new Color('#0a0705')
const UPLIGHT = [1.0, 0.62, 0.3] as const
const CARS_PER_LANE = 16
/** Deck units per second along the deck, scaled by delta: a car crosses a 600 unit bridge in about 50 seconds. */
const CAR_SPEED = 0.018
/** Spacing of the lit cable string, in deck units. */
const CABLE_LIGHT_STEP = 6

/** A box with per-vertex colour: the base colour, shaded by face direction (the material is unlit). */
export function colouredBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, base: Color): BufferGeometry {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  const n = g.getAttribute('normal') as BufferAttribute
  const col = new Float32Array(n.count * 3)
  for (let i = 0; i < n.count; i++) {
    const d = Math.max(0, n.getX(i) * SUN[0] + n.getY(i) * SUN[1] + n.getZ(i) * SUN[2])
    const shade = 0.5 + 0.5 * d
    col[i * 3] = base.r * shade
    col[i * 3 + 1] = base.g * shade
    col[i * 3 + 2] = base.b * shade
  }
  g.setAttribute('color', new BufferAttribute(col, 3))
  g.deleteAttribute('uv')
  return g
}

/** A pointed Gothic opening on a face at x = fx (facing +/-x): a dark rectangle with a pointed head made of a rotated box. */
function archOn(fx: number, z: number, y: number, dir: number): BufferGeometry[] {
  const t = 0.6
  const x0 = dir > 0 ? fx : fx - t
  const x1 = dir > 0 ? fx + t : fx
  const body = colouredBox(x0, x1, y, y + 22, z - 1.5, z + 1.5, ARCH)
  const head = new BoxGeometry(t, 3.2, 3.2)
  head.rotateX(Math.PI / 4)
  head.translate((x0 + x1) / 2, y + 22.5, z)
  const hn = head.getAttribute('normal') as BufferAttribute
  const hc = new Float32Array(hn.count * 3)
  for (let i = 0; i < hn.count; i++) {
    hc[i * 3] = ARCH.r
    hc[i * 3 + 1] = ARCH.g
    hc[i * 3 + 2] = ARCH.b
  }
  head.setAttribute('color', new BufferAttribute(hc, 3))
  head.deleteAttribute('uv')
  return [body, head]
}

/** Adds the warm uplights to the stone: strongest at the water (the piers) and at the deck (the tower bases). */
function addUplight(g: BufferGeometry, b: BridgeSpec): void {
  const pos = g.getAttribute('position') as BufferAttribute
  const col = g.getAttribute('color') as BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const fromWater = Math.exp(-(y + 3) / 8)
    const fromDeck = y >= b.deckY ? Math.exp(-(y - b.deckY) / 14) : 0
    const k = 0.3 * Math.max(fromWater, fromDeck)
    col.setXYZ(i, col.getX(i) + UPLIGHT[0] * k, col.getY(i) + UPLIGHT[1] * k, col.getZ(i) + UPLIGHT[2] * k)
  }
  col.needsUpdate = true
}

/** Towers, deck, rails and piers of one bridge, as one vertex-coloured mesh. */
function structure(b: BridgeSpec): BufferGeometry {
  const parts: BufferGeometry[] = []
  const legZ = b.halfW + 2.5
  for (const tx of b.towers) {
    // Pier in the water: a block from below the surface to the deck.
    parts.push(colouredBox(tx - 9, tx + 9, -3, b.deckY + 1, b.deckZ - legZ - 3, b.deckZ + legZ + 3, STONE))
    for (const sz of [-1, 1]) {
      const z = b.deckZ + sz * legZ
      // Each tower leg: a stone shaft from the deck to the top, with two pointed arches on each face (Brooklyn style).
      parts.push(colouredBox(tx - 3.5, tx + 3.5, b.deckY, b.towerH, z - 2.2, z + 2.2, STONE))
      for (const dir of [-1, 1]) {
        const fx = tx + dir * 3.5
        parts.push(...archOn(fx, z, b.deckY + 14, dir), ...archOn(fx, z, b.deckY + 52, dir))
      }
      // Pinnacle on each leg.
      parts.push(colouredBox(tx - 2.2, tx + 2.2, b.towerH, b.towerH + 7, z - 1.6, z + 1.6, STONE))
    }
    // Cross bracing between the legs, and a top saddle that carries the cables.
    parts.push(colouredBox(tx - 4, tx + 4, b.towerH - 7, b.towerH - 3, b.deckZ - legZ - 0.5, b.deckZ + legZ + 0.5, STONE))
    parts.push(colouredBox(tx - 3, tx + 3, b.deckY + 40, b.deckY + 44, b.deckZ - legZ, b.deckZ + legZ, STONE))
  }
  // Deck slab and rails along the whole span.
  parts.push(colouredBox(b.x0, b.x1, b.deckY - 2.2, b.deckY, b.deckZ - b.halfW, b.deckZ + b.halfW, STEEL))
  for (const sz of [-1, 1]) {
    const z = b.deckZ + sz * (b.halfW - 0.4)
    parts.push(colouredBox(b.x0, b.x1, b.deckY, b.deckY + 1.6, z - 0.4, z + 0.4, STEEL))
  }
  // Abutments at each end, so the deck does not end in mid-air.
  for (const ax of [b.x0, b.x1]) {
    parts.push(colouredBox(ax - 6, ax + 6, b.deckY - 30, b.deckY - 2.2, b.deckZ - b.halfW, b.deckZ + b.halfW, STONE))
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()))
  if (!merged) return new BufferGeometry()
  addUplight(merged, b)
  return merged
}

/** Main span: the tower saddles and the low point between them. */
function mainSpan(b: BridgeSpec): { lo: number; hi: number; low: number; top: number; a: number } {
  const lo = Math.min(...b.towers)
  const hi = Math.max(...b.towers)
  const half = (hi - lo) / 2
  const top = b.towerH - 3
  const low = b.deckY + 12
  const H = top - low
  // Catenary y = low + a (cosh((x - xm) / a) - 1): solve for a so the cable meets the saddle at x = lo and hi.
  let L = Math.log(half / 50)
  let R = Math.log(1e6)
  for (let it = 0; it < 90; it++) {
    const m = (L + R) / 2
    const a = Math.exp(m)
    const f = a * (Math.cosh(half / a) - 1) - H
    if (f > 0) L = m
    else R = m
  }
  return { lo, hi, low, top, a: Math.exp((L + R) / 2) }
}

/** Cable height at x: a catenary across the main span, and a curve from each saddle down to its anchorage. */
function cableY(b: BridgeSpec, span: ReturnType<typeof mainSpan>, x: number): number {
  const { lo, hi, low, top, a } = span
  if (x >= lo && x <= hi) {
    const xm = (lo + hi) / 2
    return low + a * (Math.cosh((x - xm) / a) - 1)
  }
  const anchor = b.deckY + 6
  const end = x < lo ? b.x0 : b.x1
  const tower = x < lo ? lo : hi
  const t = Math.min(1, Math.abs(x - end) / Math.abs(tower - end))
  return anchor + (top - anchor) * t * t
}

/** Main and side cables (both sides), suspenders, and the cable-light string (as points). */
function cableLines(b: BridgeSpec): { geo: BufferGeometry; points: Float32Array } {
  const pos: number[] = []
  const col: number[] = []
  const cableCol: [number, number, number] = [0.42, 0.42, 0.45]
  const hanger: [number, number, number] = [0.2, 0.2, 0.22]
  const N = 200
  const lights: number[] = []
  const span = mainSpan(b)
  for (const sz of [-1, 1]) {
    const z = b.deckZ + sz * (b.halfW + 1.5)
    for (let i = 0; i < N; i++) {
      const x0 = b.x0 + ((b.x1 - b.x0) * i) / N
      const x1 = b.x0 + ((b.x1 - b.x0) * (i + 1)) / N
      pos.push(x0, cableY(b, span, x0), z, x1, cableY(b, span, x1), z)
      col.push(...cableCol, ...cableCol)
    }
    // Suspenders: vertical lines from the main cable down to the deck every 9 units across the main span.
    for (let x = span.lo; x <= span.hi; x += 9) {
      pos.push(x, cableY(b, span, x), z, x, b.deckY, z)
      col.push(...hanger, ...hanger)
    }
    // The lit cable string: a light every few units along the main span and the side spans.
    for (let x = b.x0; x <= b.x1; x += CABLE_LIGHT_STEP) lights.push(x, cableY(b, span, x) + 0.6, z)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new Float32BufferAttribute(col, 3))
  return { geo, points: new Float32Array(lights) }
}

/** Points as one geometry: positions and colours. */
function pointGeo(pos: number[], col: number[]): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  return g
}

/**
 * The deck's sodium lamps (both edges) and the cable-light string, as two Points objects. The lamps keep a dim daytime
 * floor; the cable lights are night only (see BridgeMesh).
 */
function lampPoints(b: BridgeSpec, cable: Float32Array): { deck: BufferGeometry; cable: BufferGeometry } {
  const pos: number[] = []
  const col: number[] = []
  const sodium: [number, number, number] = [1.0, 0.62, 0.26]
  for (const sz of [-1, 1]) {
    for (let x = b.x0; x <= b.x1; x += 7) {
      pos.push(x, b.deckY + 3.4, b.deckZ + sz * (b.halfW - 0.2))
      col.push(...sodium)
    }
  }
  const cpos: number[] = []
  const ccol: number[] = []
  for (let i = 0; i < cable.length; i += 3) {
    cpos.push(cable[i]!, cable[i + 1]!, cable[i + 2]!)
    ccol.push(1.0, 0.86, 0.6)
  }
  return { deck: pointGeo(pos, col), cable: pointGeo(cpos, ccol) }
}

interface Cars {
  geo: BufferGeometry
  /** Per car: lane (+1 headlights, -1 tail lights), phase in [0, 1). */
  lane: Float32Array
  phase: Float32Array
}

function makeCars(b: BridgeSpec, seed: number): Cars {
  const n = CARS_PER_LANE * 2
  const lane = new Float32Array(n)
  const phase = new Float32Array(n)
  const pos = new Float32Array(n * 3)
  const col = new Float32Array(n * 3)
  let s = seed
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let i = 0; i < n; i++) {
    lane[i] = i < CARS_PER_LANE ? 1 : -1
    phase[i] = rnd()
    if (lane[i] > 0) col.set([1.0, 0.97, 0.9], i * 3)
    else col.set([1.0, 0.12, 0.08], i * 3)
    pos[i * 3 + 1] = b.deckY + 1.8
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('color', new BufferAttribute(col, 3))
  return { geo, lane, phase }
}

function BridgeMesh({ b, index }: { b: BridgeSpec; index: number }) {
  const reduced = useSky((s) => s.reducedMotion)
  const built = useMemo(() => {
    const structureGeo = structure(b)
    const structureMesh = new Mesh(structureGeo, new MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false }))
    structureMesh.frustumCulled = false
    const cables = cableLines(b)
    const cableMesh = new LineSegments(cables.geo, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, toneMapped: false, fog: false }))
    cableMesh.frustumCulled = false
    const lamps = lampPoints(b, cables.points)
    const lampMat = gateNightMaterial(new PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, toneMapped: false, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false }), 0.25)
    const lampObj = new Points(lamps.deck, lampMat)
    lampObj.frustumCulled = false
    // The cable-light string is night only.
    const cableLightMat = gateNightMaterial(new PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, toneMapped: false, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false }), 0)
    const cableLightObj = new Points(lamps.cable, cableLightMat)
    cableLightObj.frustumCulled = false
    const cars = makeCars(b, 1234 + index * 97)
    const carMat = new PointsMaterial({ size: 3.6, sizeAttenuation: false, vertexColors: true, toneMapped: false, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false })
    const carObj = new Points(cars.geo, carMat)
    carObj.frustumCulled = false
    return { structureMesh, cableMesh, lampObj, cableLightObj, carObj, cars, carMat, lampMat, cableLightMat, cableGeo: cables.geo, lampGeo: lamps.deck, cableLightGeo: lamps.cable, structureGeo }
  }, [b, index])

  useEffect(() => () => {
    built.structureGeo.dispose()
    ;(built.structureMesh.material as MeshBasicMaterial).dispose()
    built.cableGeo.dispose()
    ;(built.cableMesh.material as LineBasicMaterial).dispose()
    built.lampGeo.dispose()
    built.lampMat.dispose()
    built.cableLightGeo.dispose()
    built.cableLightMat.dispose()
    built.cars.geo.dispose()
    built.carMat.dispose()
  }, [built])

  useFrame((_, delta) => {
    if (reduced) return
    const span = b.x1 - b.x0
    const dt = Math.min(delta, 0.05)
    const { lane, phase, geo } = built.cars
    const attr = geo.getAttribute('position') as BufferAttribute
    const arr = attr.array as Float32Array
    for (let i = 0; i < lane.length; i++) {
      phase[i] = (phase[i]! + CAR_SPEED * dt * (0.8 + 0.4 * ((i * 0.37) % 1))) % 1
      // Headlights run toward the island (+x), tail lights away (-x).
      const s = lane[i]! > 0 ? phase[i]! : 1 - phase[i]!
      arr[i * 3] = b.x0 + s * span
      arr[i * 3 + 2] = b.deckZ + lane[i]! * (-(b.halfW * 0.45))
    }
    attr.needsUpdate = true
  })

  return (
    <>
      <primitive object={built.structureMesh} />
      <primitive object={built.cableMesh} />
      <primitive object={built.lampObj} />
      <primitive object={built.cableLightObj} />
      <primitive object={built.carObj} />
    </>
  )
}

export function Bridges() {
  return (
    <>
      {BRIDGES.map((b, i) => <BridgeMesh key={b.id} b={b} index={i} />)}
    </>
  )
}
