// Boats: eight vessels on the two rivers. Ferries (white hulls with orange trim and lit cabin windows), a tug, a cruise
// barge with string lights, and sailboat silhouettes. Each steams slowly along its river on a straight run that wraps
// far beyond the frame. Their hulls are one dynamic mesh, their lights one Points object (windows, string lights and
// red/green nav lights), and their wakes one line set. Positions are written per frame into preallocated arrays.
// Three draw calls. Hidden under reduced motion.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial, LineSegments,
  Mesh, MeshBasicMaterial, Points, PointsMaterial
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useSky } from '../state/store'
import { gateNightMaterial } from './lighting'
import { RIVER_INNER, RIVER_OUTER } from './metro'
import { colouredBox } from './Bridges'

type Kind = 'ferry' | 'tug' | 'barge' | 'sail'

interface Vessel {
  kind: Kind
  river: 'west' | 'east'
  /** Lateral offset from the river centre line. */
  lane: number
  /** Start position along the river, and direction (+1 or -1) and speed in units per second. */
  z0: number
  dir: number
  speed: number
  /** Ferries and tugs leave a wake. */
  wake: boolean
}

const RIVER_CENTRE = (RIVER_INNER + RIVER_OUTER) / 2
const RUN = 3600
const WRAP = RUN / 2

const VESSELS: Vessel[] = [
  { kind: 'ferry', river: 'west', lane: -50, z0: -900, dir: 1, speed: 3.2, wake: true },
  { kind: 'tug', river: 'west', lane: 40, z0: 300, dir: -1, speed: 1.8, wake: true },
  { kind: 'sail', river: 'west', lane: 0, z0: 1200, dir: -1, speed: 0.9, wake: false },
  { kind: 'barge', river: 'west', lane: 20, z0: -1500, dir: 1, speed: 1.1, wake: false },
  { kind: 'ferry', river: 'east', lane: 45, z0: 700, dir: -1, speed: 3.4, wake: true },
  { kind: 'ferry', river: 'east', lane: -40, z0: -400, dir: 1, speed: 2.8, wake: true },
  { kind: 'sail', river: 'east', lane: -10, z0: -1100, dir: 1, speed: 0.8, wake: false },
  { kind: 'barge', river: 'east', lane: 30, z0: 1400, dir: -1, speed: 1.0, wake: false }
]

/** Each vessel's hull, in its own frame: x along the run, y up, z across the river. */
function hullParts(kind: Kind): BufferGeometry[] {
  switch (kind) {
    case 'ferry':
      return [
        colouredBox(-13, 13, 0, 2.6, -3.8, 3.8, new Color('#e8e6e0')),
        colouredBox(-13, 13, 2.6, 2.9, -3.9, 3.9, new Color('#ff8a2a')),
        colouredBox(-11, 11, 2.9, 6.6, -3.4, 3.4, new Color('#dcdad4')),
        colouredBox(-6, 6, 6.6, 8.6, -2.6, 2.6, new Color('#cfd3d8'))
      ]
    case 'tug':
      return [
        colouredBox(-5, 5, 0, 2.2, -2.6, 2.6, new Color('#b8262a')),
        colouredBox(-3, 3, 2.2, 5.2, -1.9, 1.9, new Color('#e8e6e0')),
        colouredBox(-0.8, 0.8, 5.2, 8, -0.3, 0.3, new Color('#2a2c33'))
      ]
    case 'barge':
      return [
        colouredBox(-23, 23, 0, 2.4, -4.6, 4.6, new Color('#f2f1ec')),
        colouredBox(-20, 20, 2.4, 5.2, -4.2, 4.2, new Color('#e4e3dc')),
        colouredBox(-14, 14, 5.2, 7.4, -3.4, 3.4, new Color('#d5d4cd'))
      ]
    case 'sail':
      return [
        colouredBox(-3.4, 3.4, 0, 1.1, -1.1, 1.1, new Color('#1a1d26')),
        colouredBox(-0.15, 0.15, 1.1, 13, -0.15, 0.15, new Color('#20232c')),
        colouredBox(-0.1, 0.1, 2, 10, -0.1, 3.6, new Color('#e9ece8'))
      ]
  }
}

/** Lights in a vessel's frame: [x, y, z, r, g, b]. Windows and string lights first, nav lights last. */
function lightSpots(kind: Kind): number[][] {
  const out: number[][] = []
  if (kind === 'ferry') {
    for (let x = -10; x <= 10; x += 2.6) {
      out.push([x, 4.4, -3.45, 1, 0.78, 0.45], [x, 4.4, 3.45, 1, 0.78, 0.45])
    }
    out.push([8, 7.8, 0, 1, 0.92, 0.7])
  } else if (kind === 'barge') {
    for (let x = -20; x <= 20; x += 2.2) {
      out.push([x, 6.2, -3.6, 1, 0.8, 0.5], [x, 6.2, 3.6, 1, 0.8, 0.5])
    }
    for (let x = -12; x <= 12; x += 2.4) out.push([x, 3.1, -4.4, 1, 0.7, 0.4])
  } else if (kind === 'tug') {
    out.push([1.5, 4.2, -1.6, 1, 0.8, 0.5], [1.5, 4.2, 1.6, 1, 0.8, 0.5], [0, 7.8, 0, 1, 0.8, 0.5])
  }
  // Navigation lights at the bow: green to starboard, red to port, and a white masthead on the sail.
  if (kind === 'sail') out.push([0, 13.2, 0, 1, 1, 1])
  else out.push([kind === 'tug' ? 5 : 12, 1.5, -3.5, 1, 0.1, 0.08], [kind === 'tug' ? 5 : 12, 1.5, 3.5, 0.2, 1, 0.4])
  return out
}

/** Water-level wake: two lines spreading from the stern, bright at the stern and fading away. */
const WAKE_SEG = 8
const WAKE_LEN = 70

interface Built {
  hull: Mesh
  hullGeo: BufferGeometry
  hullLocal: Float32Array
  hullBoat: Uint16Array
  lights: Points
  lightGeo: BufferGeometry
  lightLocal: Float32Array
  lightBoat: Uint16Array
  wake: LineSegments
  wakeGeo: BufferGeometry
  wakeBoat: Uint16Array
  wakeTemplate: Float32Array
  hullMat: MeshBasicMaterial
  lightMat: PointsMaterial
  wakeMat: LineBasicMaterial
  dispose: () => void
}

function buildBoats(): Built {
  // Hulls: merge every vessel's boxes, remembering which vessel each vertex belongs to.
  const hullParts_: BufferGeometry[] = []
  const hullBoat: number[] = []
  VESSELS.forEach((v, bi) => {
    for (const part of hullParts(v.kind)) {
      const p = part.toNonIndexed()
      hullParts_.push(p)
      for (let k = 0; k < p.getAttribute('position').count; k++) hullBoat.push(bi)
    }
  })
  const hullGeo = mergeGeometries(hullParts_)!
  const pos = hullGeo.getAttribute('position') as BufferAttribute
  const hullLocal: number[] = []
  for (let i = 0; i < pos.count; i++) hullLocal.push(pos.getX(i), pos.getY(i), pos.getZ(i))
  const hullMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false })
  const hull = new Mesh(hullGeo, hullMat)
  hull.frustumCulled = false

  // Lights.
  const lp: number[] = []
  const lc: number[] = []
  const lb: number[] = []
  const lightLocal: number[] = []
  VESSELS.forEach((v, bi) => {
    for (const s of lightSpots(v.kind)) {
      lightLocal.push(s[0]!, s[1]!, s[2]!)
      lp.push(0, 0, 0)
      lc.push(s[3]!, s[4]!, s[5]!)
      lb.push(bi)
    }
  })
  const lightGeo = new BufferGeometry()
  lightGeo.setAttribute('position', new Float32BufferAttribute(lp, 3))
  lightGeo.setAttribute('color', new Float32BufferAttribute(lc, 3))
  // Cabin windows, string lights and nav lights: night only, with a faint daytime floor for the nav lights.
  const lightMat = gateNightMaterial(new PointsMaterial({
    size: 3.4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  }), 0.3)
  const lights = new Points(lightGeo, lightMat)
  lights.frustumCulled = false

  // Wakes: two arms per moving vessel, each a chain of segments that fade with distance behind the stern.
  const wakeBoatIdx: number[] = []
  const wakeTemplate: number[] = []
  const wakeCol: number[] = []
  VESSELS.forEach((v, bi) => {
    if (!v.wake) return
    for (const side of [-1, 1]) {
      for (let s = 0; s < WAKE_SEG; s++) {
        const t0 = s / WAKE_SEG
        const t1 = (s + 1) / WAKE_SEG
        // Local (along, across) from the stern: the arm spreads with distance and runs behind the vessel.
        const a0 = -13 - t0 * WAKE_LEN
        const a1 = -13 - t1 * WAKE_LEN
        const w0 = side * (2 + t0 * 14)
        const w1 = side * (2 + t1 * 14)
        wakeTemplate.push(a0, 0, w0, a1, 0, w1)
        const fade = Math.max(0, 1 - t0) ** 1.5
        wakeCol.push(fade, fade, fade, fade * 0.9, fade * 0.9, fade * 0.9)
        wakeBoatIdx.push(bi, bi)
      }
    }
  })
  const wakePos = new Float32Array(wakeTemplate.length)
  const wakeGeo = new BufferGeometry()
  wakeGeo.setAttribute('position', new BufferAttribute(wakePos, 3))
  wakeGeo.setAttribute('color', new Float32BufferAttribute(wakeCol, 3))
  const wakeMat = new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
  const wake = new LineSegments(wakeGeo, wakeMat)
  wake.frustumCulled = false

  const wakeBoat = new Uint16Array(wakeBoatIdx)

  return {
    hull, hullGeo, hullLocal: new Float32Array(hullLocal), hullBoat: new Uint16Array(hullBoat),
    lights, lightGeo, lightLocal: new Float32Array(lightLocal), lightBoat: new Uint16Array(lb),
    wake, wakeGeo, wakeBoat, wakeTemplate: new Float32Array(wakeTemplate),
    hullMat, lightMat, wakeMat,
    dispose: () => {
      hullGeo.dispose(); hullMat.dispose()
      lightGeo.dispose(); lightMat.dispose()
      wakeGeo.dispose(); wakeMat.dispose()
    }
  }
}

/** Wrap a run position into [-WRAP, WRAP). */
function wrapZ(z: number): number {
  return ((((z + WRAP) % RUN) + RUN) % RUN) - WRAP
}

/** Each vessel's lane x, fixed. */
const CENTRE_X = VESSELS.map((v) => (v.river === 'west' ? -RIVER_CENTRE : RIVER_CENTRE) + v.lane)

export function Boats() {
  const reduced = useSky((s) => s.reducedMotion)
  const built = useMemo(() => buildBoats(), [])
  useEffect(() => () => built.dispose(), [built])

  const zs = useRef(new Float32Array(VESSELS.length))
  const clock = useRef(0)

  useFrame((_, delta) => {
    if (reduced) return
    clock.current += Math.min(delta, 0.05)
    const t = clock.current
    const z = zs.current
    for (let i = 0; i < VESSELS.length; i++) {
      const v = VESSELS[i]!
      z[i] = wrapZ(v.z0 + v.dir * v.speed * t)
    }
    const cx = CENTRE_X

    // Hull vertices: world x = centre + lateral, world z = boat z + along * dir.
    const hp = (built.hullGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const hl = built.hullLocal
    for (let k = 0; k < built.hullBoat.length; k++) {
      const bi = built.hullBoat[k]!
      const v = VESSELS[bi]!
      hp[k * 3] = cx[bi]! + hl[k * 3 + 2]!
      hp[k * 3 + 1] = hl[k * 3 + 1]!
      hp[k * 3 + 2] = z[bi]! + hl[k * 3]! * v.dir
    }
    ;(built.hullGeo.getAttribute('position') as BufferAttribute).needsUpdate = true

    const lpArr = (built.lightGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const ll = built.lightLocal
    for (let k = 0; k < built.lightBoat.length; k++) {
      const bi = built.lightBoat[k]!
      const v = VESSELS[bi]!
      lpArr[k * 3] = cx[bi]! + ll[k * 3 + 2]!
      lpArr[k * 3 + 1] = ll[k * 3 + 1]!
      lpArr[k * 3 + 2] = z[bi]! + ll[k * 3]! * v.dir
    }
    ;(built.lightGeo.getAttribute('position') as BufferAttribute).needsUpdate = true

    const wp = (built.wakeGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const wt = built.wakeTemplate
    for (let k = 0; k < built.wakeBoat.length; k++) {
      const bi = built.wakeBoat[k]!
      const v = VESSELS[bi]!
      wp[k * 3] = cx[bi]! + wt[k * 3 + 2]!
      wp[k * 3 + 1] = 0.05
      wp[k * 3 + 2] = z[bi]! + wt[k * 3]! * v.dir
    }
    ;(built.wakeGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
  })

  if (reduced) return null
  return (
    <>
      <primitive object={built.hull} />
      <primitive object={built.lights} />
      <primitive object={built.wake} />
    </>
  )
}
