// Aircraft far above the city: slow planes and two blimps on wide lazy ellipses, with blinking nav lights and
// one or two faint searchlight cones sweeping the streets. Three draw calls in total: the solid silhouettes
// (planes, blimps with a dim emissive strip), the nav-light points, and the searchlight cones.
// Positions are written on the CPU each frame into preallocated buffers. Renders nothing with reduced motion.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Points, PointsMaterial
} from 'three'
import { useSky } from '../state/store'

let pendingAir = 0

/** Advances the aircraft clock by `seconds` on the next frame (see the traffic fast-forward hook). */
export function advanceAircraft(seconds: number): void {
  pendingAir += Math.max(0, Math.min(seconds, 120))
}

interface Craft {
  blimp: boolean;
  cx: number; cz: number; rx: number; rz: number;
  /** Radians per second around the ellipse. */
  omega: number; phase: number; y: number;
  /** Carries a searchlight. */
  light: boolean;
}

// Fixed, hand-placed fleet: a deterministic sky.
const CRAFT: Craft[] = [
  { blimp: false, cx: 0, cz: -8, rx: 70, rz: 48, omega: 0.03, phase: 0.0, y: 88, light: true },
  { blimp: false, cx: -10, cz: 6, rx: 55, rz: 62, omega: -0.038, phase: 2.1, y: 64, light: false },
  { blimp: false, cx: 6, cz: 0, rx: 78, rz: 36, omega: 0.022, phase: 4.0, y: 102, light: true },
  { blimp: false, cx: -4, cz: 12, rx: 40, rz: 30, omega: -0.05, phase: 1.1, y: 58, light: false },
  { blimp: false, cx: 12, cz: -12, rx: 62, rz: 66, omega: 0.027, phase: 5.2, y: 76, light: false },
  { blimp: false, cx: 0, cz: 0, rx: 88, rz: 80, omega: -0.016, phase: 3.3, y: 112, light: false },
  { blimp: true, cx: -6, cz: 0, rx: 58, rz: 50, omega: 0.012, phase: 0.7, y: 72, light: false },
  { blimp: true, cx: 8, cz: 4, rx: 76, rz: 64, omega: -0.009, phase: 3.9, y: 94, light: false }
]

const BLIMP_LEN = 12
const BLIMP_R = 2.1
const LAT = 10
const LON = 14
const CONE_SEGS = 16
const CONE_RADIUS = 9
const CONE_CRAFT = 2

/** Local template of one plane (top-down silhouette, forward is +x): non-indexed triangles. */
const PLANE_LOCAL: number[] = (() => {
  const tris: number[][] = [
    // fuselage
    [1.6, 0, 0, -1.1, 0, 0.14, -1.1, 0, -0.14],
    // wings
    [0.5, 0, 0.1, -0.5, 0, 1.5, -0.9, 0, 0.1],
    [0.5, 0, -0.1, -0.5, 0, -1.5, -0.9, 0, -0.1],
    // tailplanes
    [-0.9, 0, 0.05, -1.3, 0, 0.6, -1.3, 0, 0.05],
    [-0.9, 0, -0.05, -1.3, 0, -0.6, -1.3, 0, -0.05]
  ]
  return tris.flat()
})()
const PLANE_COLOR = [0.14, 0.18, 0.27]

/** Local template of a blimp: an ellipsoid along x with a dim emissive strip along the top. */
const BLIMP_LOCAL: { pos: number[]; col: number[] } = (() => {
  const pos: number[] = []
  const col: number[] = []
  const point = (phi: number, theta: number): [number, number, number] => [
    (BLIMP_LEN / 2) * Math.cos(phi),
    BLIMP_R * Math.sin(phi) * Math.cos(theta),
    BLIMP_R * Math.sin(phi) * Math.sin(theta)
  ]
  const colorOf = (p: [number, number, number]): number[] => {
    const top = p[1] > 0.55 * BLIMP_R && Math.abs(p[2]) < 0.3 * BLIMP_R
    return top ? [0.62, 0.44, 0.24] : [0.13, 0.16, 0.24]
  }
  const vert = (p: [number, number, number]) => {
    pos.push(p[0], p[1], p[2])
    col.push(...colorOf(p))
  }
  for (let i = 0; i < LAT; i++) {
    const p0 = (Math.PI * i) / LAT
    const p1 = (Math.PI * (i + 1)) / LAT
    for (let j = 0; j < LON; j++) {
      const t0 = (2 * Math.PI * j) / LON
      const t1 = (2 * Math.PI * (j + 1)) / LON
      const a = point(p0, t0), b = point(p1, t0), c = point(p1, t1), d = point(p0, t1)
      vert(a); vert(b); vert(c)
      vert(a); vert(c); vert(d)
    }
  }
  return { pos, col }
})()

/** Local nav-light positions per craft kind: [lx, ly, lz, r, g, b]. */
const PLANE_LIGHTS = [
  [-0.5, 0, 1.5, 1, 0.08, 0.06], // port (red)
  [-0.5, 0, -1.5, 0.1, 1, 0.3], // starboard (green)
  [-1.3, 0, 0, 1, 1, 1] // tail strobe (white)
]
const BLIMP_LIGHTS = [
  [BLIMP_LEN / 2, 0, 0, 1, 1, 1],
  [-BLIMP_LEN / 2, 0, 0, 1, 0.08, 0.06]
]

interface Fleet {
  body: BufferGeometry;
  lights: BufferGeometry;
  cones: BufferGeometry;
  bodyOffset: number[];
  bodyVerts: number;
  lightOffset: number[];
  lightCount: number;
  pose: Float32Array;
  solid: MeshBasicMaterial;
  lightMat: PointsMaterial;
  coneMat: MeshBasicMaterial;
}

function buildFleet(): Fleet {
  const bodyOffset: number[] = []
  const lightOffset: number[] = []
  let verts = 0
  let lights = 0
  for (const c of CRAFT) {
    bodyOffset.push(verts)
    lightOffset.push(lights)
    verts += c.blimp ? BLIMP_LOCAL.pos.length / 3 : PLANE_LOCAL.length / 3
    lights += c.blimp ? BLIMP_LIGHTS.length : PLANE_LIGHTS.length
  }
  const body = new BufferGeometry()
  body.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3))
  body.setAttribute('color', new BufferAttribute(new Float32Array(verts * 3), 3))

  const lightGeo = new BufferGeometry()
  lightGeo.setAttribute('position', new BufferAttribute(new Float32Array(lights * 3), 3))
  lightGeo.setAttribute('color', new BufferAttribute(new Float32Array(lights * 3), 3))

  const coneVerts = CONE_CRAFT * CONE_SEGS * 3
  const cones = new BufferGeometry()
  cones.setAttribute('position', new BufferAttribute(new Float32Array(coneVerts * 3), 3))
  cones.setAttribute('color', new BufferAttribute(new Float32Array(coneVerts * 4), 4))

  // Static body colours: blimps carry their strip colours, planes a flat dark colour.
  const bodyCol = (body.getAttribute('color') as BufferAttribute).array as Float32Array
  let o = 0
  for (const c of CRAFT) {
    const n = c.blimp ? BLIMP_LOCAL.pos.length / 3 : PLANE_LOCAL.length / 3
    for (let v = 0; v < n; v++) {
      const k = (o + v) * 3
      if (c.blimp) {
        bodyCol[k] = BLIMP_LOCAL.col[v * 3]!
        bodyCol[k + 1] = BLIMP_LOCAL.col[v * 3 + 1]!
        bodyCol[k + 2] = BLIMP_LOCAL.col[v * 3 + 2]!
      } else {
        bodyCol[k] = PLANE_COLOR[0]!
        bodyCol[k + 1] = PLANE_COLOR[1]!
        bodyCol[k + 2] = PLANE_COLOR[2]!
      }
    }
    o += n
  }

  const solid = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false })
  const lightMat = new PointsMaterial({
    vertexColors: true, size: 2.6, sizeAttenuation: true, transparent: true,
    depthWrite: false, blending: AdditiveBlending, toneMapped: false
  })
  const coneMat = new MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide,
    blending: AdditiveBlending, toneMapped: false
  })
  return {
    body, lights: lightGeo, cones, bodyOffset, bodyVerts: verts, lightOffset, lightCount: lights,
    pose: new Float32Array(CRAFT.length * 5), solid, lightMat, coneMat
  }
}

/** World position and heading of craft `i` at clock time `t`, into pose[i*5 .. i*5+4] as (x, y, z, fx, fz). */
function poseAt(f: Fleet, i: number, t: number): void {
  const c = CRAFT[i]!
  const th = c.phase + c.omega * t
  const x = c.cx + c.rx * Math.cos(th)
  const z = c.cz + c.rz * Math.sin(th)
  let fx = -c.rx * Math.sin(th) * c.omega
  let fz = c.rz * Math.cos(th) * c.omega
  const l = Math.hypot(fx, fz) || 1
  fx /= l
  fz /= l
  const o = i * 5
  f.pose[o] = x
  f.pose[o + 1] = c.y
  f.pose[o + 2] = z
  f.pose[o + 3] = fx
  f.pose[o + 4] = fz
}

/** Writes the solid body, the nav lights and the searchlight cones for the current poses. */
function writeFleet(f: Fleet, t: number): void {
  const bodyPos = (f.body.getAttribute('position') as BufferAttribute).array as Float32Array
  const lightPos = (f.lights.getAttribute('position') as BufferAttribute).array as Float32Array
  const lightCol = (f.lights.getAttribute('color') as BufferAttribute).array as Float32Array
  const blink = (phase: number, rate: number) => 0.2 + 0.8 * (Math.sin((t * rate + phase) * Math.PI * 2) > 0 ? 1 : 0.15)

  CRAFT.forEach((c, i) => {
    const o = i * 5
    const px = f.pose[o]!, py = f.pose[o + 1]!, pz = f.pose[o + 2]!
    const fx = f.pose[o + 3]!, fz = f.pose[o + 4]!
    // Right-hand side of the heading, in the ground plane.
    const rx = -fz, rz = fx
    const place = (lx: number, ly: number, lz: number, out: Float32Array, k: number) => {
      out[k] = px + lx * fx + lz * rx
      out[k + 1] = py + ly
      out[k + 2] = pz + lx * fz + lz * rz
    }
    const src = c.blimp ? BLIMP_LOCAL.pos : PLANE_LOCAL
    const base = f.bodyOffset[i]!
    const n = src.length / 3
    for (let v = 0; v < n; v++) {
      place(src[v * 3]!, src[v * 3 + 1]!, src[v * 3 + 2]!, bodyPos, (base + v) * 3)
    }

    const lights = c.blimp ? BLIMP_LIGHTS : PLANE_LIGHTS
    const lb = f.lightOffset[i]!
    lights.forEach((L, j) => {
      const k = (lb + j) * 3
      place(L[0]!, L[1]!, L[2]!, lightPos, k)
      const phase = i * 0.37 + j * 0.21
      // Red and green steady-blink; the tail strobe is a short flash.
      const g = j === lights.length - 1 && !c.blimp ? (((t * 1.3 + phase) % 1) < 0.08 ? 3 : 0.05) : blink(phase, 0.6)
      lightCol[k] = L[3]! * g
      lightCol[k + 1] = L[4]! * g
      lightCol[k + 2] = L[5]! * g
    })
  })

  // Searchlights: a faint additive cone from each carrying craft to a point sweeping over the streets.
  const coneCol = (f.cones.getAttribute('color') as BufferAttribute).array as Float32Array
  const conePos = (f.cones.getAttribute('position') as BufferAttribute).array as Float32Array
  let cI = 0
  let k = 0
  CRAFT.forEach((c, i) => {
    if (!c.light || cI >= CONE_CRAFT) return
    const seed = cI * 2.3
    cI++
    const o = i * 5
    const ax = f.pose[o]!, ay = f.pose[o + 1]!, az = f.pose[o + 2]!
    const tx = 34 * Math.sin(0.11 * t + seed) + 12 * Math.sin(0.37 * t + seed * 2)
    const tz = 30 * Math.cos(0.07 * t + seed) + 9 * Math.cos(0.23 * t)
    let dx = tx - ax, dy = 0.4 - ay, dz = tz - az
    const dl = Math.hypot(dx, dy, dz) || 1
    dx /= dl; dy /= dl; dz /= dl
    // Basis perpendicular to the beam: u = d x h, v = d x u.
    const [hx, hy, hz] = Math.abs(dz) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    let ux = dy * hz - dz * hy
    let uy = dz * hx - dx * hz
    let uz = dx * hy - dy * hx
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul; uy /= ul; uz /= ul
    const vx = dy * uz - dz * uy
    const vy = dz * ux - dx * uz
    const vz = dx * uy - dy * ux
    for (let s = 0; s < CONE_SEGS; s++) {
      const a0 = (2 * Math.PI * s) / CONE_SEGS
      const a1 = (2 * Math.PI * (s + 1)) / CONE_SEGS
      const r0 = Math.cos(a0), q0 = Math.sin(a0)
      const r1 = Math.cos(a1), q1 = Math.sin(a1)
      const bx0 = tx + CONE_RADIUS * (r0 * ux + q0 * vx), by0 = 0.4 + CONE_RADIUS * (r0 * uy + q0 * vy), bz0 = tz + CONE_RADIUS * (r0 * uz + q0 * vz)
      const bx1 = tx + CONE_RADIUS * (r1 * ux + q1 * vx), by1 = 0.4 + CONE_RADIUS * (r1 * uy + q1 * vy), bz1 = tz + CONE_RADIUS * (r1 * uz + q1 * vz)
      const ring = [[bx0, by0, bz0], [bx1, by1, bz1]]
      const pts = [[ax, ay, az], ring[0]!, ring[1]!]
      const alpha = [0.2, 0.0, 0.0]
      for (let p = 0; p < 3; p++) {
        const q = pts[p]!
        const w = (k + p) * 3
        conePos[w] = q[0]!
        conePos[w + 1] = q[1]!
        conePos[w + 2] = q[2]!
        const cc = (k + p) * 4
        coneCol[cc] = 0.55
        coneCol[cc + 1] = 0.8
        coneCol[cc + 2] = 1.0
        coneCol[cc + 3] = alpha[p]! * (0.75 + 0.25 * Math.sin(t * 0.5 + seed))
      }
      k += 3
    }
  })
  // Unused cone slots (if fewer carry a light) stay at zero alpha.
  for (let j = k; j < coneCol.length / 4; j++) coneCol[j * 4 + 3] = 0

  ;(f.body.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(f.lights.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(f.lights.getAttribute('color') as BufferAttribute).needsUpdate = true
  ;(f.cones.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(f.cones.getAttribute('color') as BufferAttribute).needsUpdate = true
}

/** The aircraft fleet. Renders nothing with reduced motion. */
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
    fleet.cones.dispose()
    fleet.solid.dispose()
    fleet.lightMat.dispose()
    fleet.coneMat.dispose()
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
  const coneMesh = useMemo(() => {
    const m = new Mesh(fleet.cones, fleet.coneMat)
    m.frustumCulled = false
    m.renderOrder = 4
    return m
  }, [fleet])

  const clock = useRef(0)
  useFrame((_, delta) => {
    const step = pendingAir > 0 ? pendingAir : Math.min(delta, 0.05)
    pendingAir = 0
    clock.current += step
    const t = clock.current
    for (let i = 0; i < CRAFT.length; i++) poseAt(fleet, i, t)
    writeFleet(fleet, t)
  })

  return (
    <>
      <primitive object={solidMesh} />
      <primitive object={lightPoints} />
      <primitive object={coneMesh} />
    </>
  )
}
