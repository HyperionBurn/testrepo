// Aircraft far above the city: five airliners on wide lazy ellipses at 330 to 470 units, each with blinking nav lights and
// a faint contrail glow that trails behind it. Blimps and searchlights are gone (helicopters carry the spotlights now). Three
// draw calls: the solid silhouettes, the nav-light points, and the contrail ribbons. Positions are written on the CPU each
// frame into preallocated buffers. Renders nothing with reduced motion.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Points, PointsMaterial
} from 'three'
import { useSky } from '../state/store'
import { gateNightMaterial, lightingUniforms, nightGate } from './lighting'

let pendingAir = 0

/** Advances the aircraft clock by `seconds` on the next frame (see the traffic fast-forward hook). */
export function advanceAircraft(seconds: number): void {
  pendingAir += Math.max(0, Math.min(seconds, 120))
}

interface Craft {
  cx: number; cz: number; rx: number; rz: number
  /** Radians per second around the ellipse. */
  omega: number; phase: number; y: number
}

// Fixed, hand-placed fleet: a deterministic sky.
const CRAFT: Craft[] = [
  { cx: 0, cz: -8, rx: 980, rz: 760, omega: 0.0042, phase: 0.0, y: 420 },
  { cx: -40, cz: 60, rx: 1240, rz: 900, omega: -0.0031, phase: 2.1, y: 470 },
  { cx: 60, cz: 0, rx: 1100, rz: 1320, omega: 0.0025, phase: 4.0, y: 360 },
  { cx: -120, cz: -40, rx: 860, rz: 1020, omega: -0.0048, phase: 1.1, y: 340 },
  { cx: 90, cz: 120, rx: 1420, rz: 1150, omega: 0.0019, phase: 5.2, y: 440 }
]
const N = CRAFT.length
const SCALE = 3.2
const CONTRAIL_SEGS = 22
const CONTRAIL_DT = 1.4
const CONTRAIL_W = 1.6

/** Local template of one airliner (top-down silhouette, forward +x): triangles. */
const PLANE_LOCAL: number[] = (() => {
  const tris: number[][] = [
    [1.6, 0, 0, -1.1, 0, 0.14, -1.1, 0, -0.14],
    [0.5, 0, 0.1, -0.5, 0, 1.5, -0.9, 0, 0.1],
    [0.5, 0, -0.1, -0.5, 0, -1.5, -0.9, 0, -0.1],
    [-0.9, 0, 0.05, -1.3, 0, 0.6, -1.3, 0, 0.05],
    [-0.9, 0, -0.05, -1.3, 0, -0.6, -1.3, 0, -0.05]
  ]
  return tris.flat().map((v) => v * SCALE)
})()
const PLANE_VERTS = PLANE_LOCAL.length / 3
/** Nav lights in the plane's frame: [lx, ly, lz, r, g, b]. The last one (tail strobe) flashes. */
const NAV: number[][] = [
  [-0.5 * SCALE, 0, 1.5 * SCALE, 1, 0.08, 0.06],
  [-0.5 * SCALE, 0, -1.5 * SCALE, 0.1, 1, 0.3],
  [-1.3 * SCALE, 0, 0, 1, 1, 1]
]

/** Position and forward heading of craft i at time t. */
function poseAt(i: number, t: number): { x: number; z: number; fx: number; fz: number } {
  const c = CRAFT[i]!
  const th = c.phase + c.omega * t
  const x = c.cx + c.rx * Math.cos(th)
  const z = c.cz + c.rz * Math.sin(th)
  let fx = -c.rx * Math.sin(th) * c.omega
  let fz = c.rz * Math.cos(th) * c.omega
  const l = Math.hypot(fx, fz) || 1
  fx /= l
  fz /= l
  return { x, z, fx, fz }
}

interface Fleet {
  body: BufferGeometry
  bodyCraft: Uint8Array
  bodyLocal: Float32Array
  lights: BufferGeometry
  lightCraft: Uint8Array
  lightLocal: Float32Array
  contrail: BufferGeometry
  solid: MeshBasicMaterial
  lightMat: PointsMaterial
  trailMat: MeshBasicMaterial
}

function buildFleet(): Fleet {
  const bodyCraft: number[] = []
  const bodyLocal: number[] = []
  for (let i = 0; i < N; i++) {
    for (let v = 0; v < PLANE_VERTS; v++) {
      bodyCraft.push(i)
      bodyLocal.push(PLANE_LOCAL[v * 3]!, PLANE_LOCAL[v * 3 + 1]!, PLANE_LOCAL[v * 3 + 2]!)
    }
  }
  const body = new BufferGeometry()
  body.setAttribute('position', new BufferAttribute(new Float32Array(bodyCraft.length * 3), 3))
  body.setAttribute('color', new Float32BufferAttribute(new Float32Array(bodyCraft.length * 3).fill(0), 3))
  const bodyColour = body.getAttribute('color') as BufferAttribute
  for (let k = 0; k < bodyCraft.length; k++) bodyColour.setXYZ(k, 0.14, 0.18, 0.27)

  const lightCraft: number[] = []
  const lightLocal: number[] = []
  for (let i = 0; i < N; i++) {
    for (const L of NAV) {
      lightCraft.push(i)
      lightLocal.push(L[0]!, L[1]!, L[2]!)
    }
  }
  const lights = new BufferGeometry()
  lights.setAttribute('position', new BufferAttribute(new Float32Array(lightCraft.length * 3), 3))
  lights.setAttribute('color', new BufferAttribute(new Float32Array(lightCraft.length * 3), 3))

  // Contrails: K segments of a ribbon per craft, each segment two vertices per sample, with alpha.
  const trailVerts = N * (CONTRAIL_SEGS + 1) * 2
  const contrail = new BufferGeometry()
  contrail.setAttribute('position', new BufferAttribute(new Float32Array(trailVerts * 3), 3))
  contrail.setAttribute('color', new BufferAttribute(new Float32Array(trailVerts * 4), 4))
  const idx: number[] = []
  for (let i = 0; i < N; i++) {
    const base = i * (CONTRAIL_SEGS + 1) * 2
    for (let k = 0; k < CONTRAIL_SEGS; k++) {
      const a = base + k * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  contrail.setIndex(idx)

  const solid = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false })
  // Nav lights: small red and green points by day, full strength at night.
  const lightMat = gateNightMaterial(new PointsMaterial({
    vertexColors: true, size: 4.2, sizeAttenuation: false, transparent: true,
    depthWrite: false, blending: AdditiveBlending, toneMapped: false
  }), 0.3)
  const trailMat = new MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, toneMapped: false
  })
  return {
    body,
    bodyCraft: new Uint8Array(bodyCraft),
    bodyLocal: new Float32Array(bodyLocal),
    lights,
    lightCraft: new Uint8Array(lightCraft),
    lightLocal: new Float32Array(lightLocal),
    contrail,
    solid,
    lightMat,
    trailMat
  }
}

/** Writes the solid bodies, nav lights and contrails for time t. */
function writeFleet(f: Fleet, t: number): void {
  const bp = (f.body.getAttribute('position') as BufferAttribute).array as Float32Array
  const lp = (f.lights.getAttribute('position') as BufferAttribute).array as Float32Array
  const lc = (f.lights.getAttribute('color') as BufferAttribute).array as Float32Array
  const cp = (f.contrail.getAttribute('position') as BufferAttribute).array as Float32Array
  const cc = (f.contrail.getAttribute('color') as BufferAttribute).array as Float32Array

  const poses = CRAFT.map((_, i) => poseAt(i, t))
  // Contrails are a faint veil by day and read as light only at night, so the ribbons never look like beams.
  const trail = 0.3 + 0.7 * nightGate(lightingUniforms.uNight.value)
  const height = (i: number) => CRAFT[i]!.y

  for (let k = 0; k < f.bodyCraft.length; k++) {
    const i = f.bodyCraft[k]!
    const p = poses[i]!
    const lx = f.bodyLocal[k * 3]!, ly = f.bodyLocal[k * 3 + 1]!, lz = f.bodyLocal[k * 3 + 2]!
    // Right-hand side of the heading, in the ground plane.
    const rx = -p.fz, rz = p.fx
    bp[k * 3] = p.x + lx * p.fx + lz * rx
    bp[k * 3 + 1] = height(i) + ly
    bp[k * 3 + 2] = p.z + lx * p.fz + lz * rz
  }
  ;(f.body.getAttribute('position') as BufferAttribute).needsUpdate = true

  const blink = (phase: number, rate: number) => 0.2 + 0.8 * (Math.sin((t * rate + phase) * Math.PI * 2) > 0 ? 1 : 0.15)
  for (let k = 0; k < f.lightCraft.length; k++) {
    const i = f.lightCraft[k]!
    const j = k % NAV.length
    const p = poses[i]!
    const L = NAV[j]!
    const rx = -p.fz, rz = p.fx
    const lx = f.lightLocal[k * 3]!, lz = f.lightLocal[k * 3 + 2]!
    lp[k * 3] = p.x + lx * p.fx + lz * rx
    lp[k * 3 + 1] = height(i) + f.lightLocal[k * 3 + 1]!
    lp[k * 3 + 2] = p.z + lx * p.fz + lz * rz
    const phase = i * 0.37 + j * 0.21
    const g = j === NAV.length - 1 ? (((t * 1.3 + phase) % 1) < 0.08 ? 3 : 0.05) : blink(phase, 0.6)
    lc[k * 3] = L[3]! * g
    lc[k * 3 + 1] = L[4]! * g
    lc[k * 3 + 2] = L[5]! * g
  }
  ;(f.lights.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(f.lights.getAttribute('color') as BufferAttribute).needsUpdate = true

  // Contrails: sample the path backwards in time, offset sideways to make a ribbon, and fade with age.
  for (let i = 0; i < N; i++) {
    const base = i * (CONTRAIL_SEGS + 1) * 2
    for (let k = 0; k <= CONTRAIL_SEGS; k++) {
      const q = poseAt(i, t - k * CONTRAIL_DT)
      const nx = -q.fz, nz = q.fx
      const y = height(i) - 0.4
      const w = CONTRAIL_W * (1 + k * 0.03)
      const a = Math.pow(1 - k / (CONTRAIL_SEGS + 1), 2) * 0.55
      const v0 = base + k * 2
      const v1 = v0 + 1
      cp[v0 * 3] = q.x + nx * w
      cp[v0 * 3 + 1] = y
      cp[v0 * 3 + 2] = q.z + nz * w
      cp[v1 * 3] = q.x - nx * w
      cp[v1 * 3 + 1] = y
      cp[v1 * 3 + 2] = q.z - nz * w
      for (const v of [v0, v1]) {
        cc[v * 4] = 0.72
        cc[v * 4 + 1] = 0.8
        cc[v * 4 + 2] = 1.0
        cc[v * 4 + 3] = a * trail
      }
    }
  }
  ;(f.contrail.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(f.contrail.getAttribute('color') as BufferAttribute).needsUpdate = true
}

/** The airliner fleet. Renders nothing with reduced motion. */
export function Aircraft() {
  const reduced = useSky((s) => s.reducedMotion)
  if (reduced) return null
  return <Fleet />
}

function Fleet() {
  const fleet = useMemo(() => buildFleet(), [])
  useEffect(() => () => {
    fleet.body.dispose()
    fleet.lights.dispose()
    fleet.contrail.dispose()
    fleet.solid.dispose()
    fleet.lightMat.dispose()
    fleet.trailMat.dispose()
  }, [fleet])

  const solidMesh = useMemo(() => {
    const m = new Mesh(fleet.body, fleet.solid)
    m.frustumCulled = false
    return m
  }, [fleet])
  const lightPoints = useMemo(() => {
    const p = new Points(fleet.lights, fleet.lightMat)
    p.frustumCulled = false
    p.renderOrder = 4
    return p
  }, [fleet])
  const trailMesh = useMemo(() => {
    const m = new Mesh(fleet.contrail, fleet.trailMat)
    m.frustumCulled = false
    m.renderOrder = 3
    return m
  }, [fleet])

  const clock = useRef(0)
  useFrame((_, delta) => {
    const step = pendingAir > 0 ? pendingAir : Math.min(delta, 0.05)
    pendingAir = 0
    clock.current += step
    writeFleet(fleet, clock.current)
  })

  return (
    <>
      <primitive object={solidMesh} />
      <primitive object={lightPoints} />
      <primitive object={trailMesh} />
    </>
  )
}
