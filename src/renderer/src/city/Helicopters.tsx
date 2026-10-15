// Helicopters: four craft on wide, buzzing orbits over the city at 80 to 120 units. Each has a dark body, a rotor blur
// disc, white strobes and a sweeping spotlight whose cone lands on the streets below. The bodies, discs, strobes and cones
// are four dynamic meshes, written per frame into preallocated arrays from one pose table. Hidden under reduced motion.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, Points, PointsMaterial
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useSky } from '../state/store'
import { colouredBox } from './Bridges'
import { gateNightMaterial, lightingUniforms, nightGate } from './lighting'

interface Heli {
  cx: number; cz: number
  /** Orbit radius is r0 + r1 * sin(breath * t + phase). */
  r0: number; r1: number; breath: number
  omega: number; phase: number
  y: number
}

const HELIS: readonly Heli[] = [
  { cx: -60, cz: 40, r0: 170, r1: 40, breath: 0.11, omega: 0.055, phase: 0.3, y: 96 },
  { cx: 40, cz: -120, r0: 240, r1: 60, breath: 0.07, omega: -0.042, phase: 2.2, y: 118 },
  { cx: 120, cz: 280, r0: 310, r1: 80, breath: 0.09, omega: 0.036, phase: 4.1, y: 84 },
  { cx: -200, cz: -260, r0: 230, r1: 50, breath: 0.13, omega: -0.048, phase: 5.3, y: 110 }
]

const N = HELIS.length
const CONE_SEGS = 12
const DISC_SEGS = 18
const ROTOR_R = 9.5
const CONE_R = 13
/** Pose slots per helicopter: x, y, z, forward x, forward z, spot x, spot z. */
const POSE = 7

/** Body in its own frame: x forward, y up, z to the right. */
function bodyParts(): BufferGeometry[] {
  const dark = new Color('#1d222d')
  const skid = new Color('#0c0e13')
  return [
    colouredBox(-3.2, 2.6, -1.2, 1.6, -1.5, 1.5, dark),
    colouredBox(-6.5, -2.4, 0.2, 0.9, -0.35, 0.35, dark),
    colouredBox(-6.9, -5.9, 0.8, 3.2, -0.12, 0.12, dark),
    colouredBox(-1.8, 1.4, -2.1, -1.9, -1.4, -1.25, skid),
    colouredBox(-1.8, 1.4, -2.1, -1.9, 1.25, 1.4, skid)
  ].map((g) => g.toNonIndexed())
}

/** Writes the pose of helicopter h at time t into the table. */
function poseInto(table: Float32Array, h: number, t: number): void {
  const heli = HELIS[h]!
  const th = heli.phase + heli.omega * t
  const r = heli.r0 + heli.r1 * Math.sin(heli.breath * t + heli.phase)
  const dr = heli.r1 * heli.breath * Math.cos(heli.breath * t + heli.phase)
  const x = heli.cx + r * Math.cos(th)
  const z = heli.cz + r * Math.sin(th)
  // Velocity from the product rule on (r cos th, r sin th): the heading.
  let vx = dr * Math.cos(th) - r * heli.omega * Math.sin(th)
  let vz = dr * Math.sin(th) + r * heli.omega * Math.cos(th)
  const l = Math.hypot(vx, vz) || 1
  vx /= l
  vz /= l
  const o = h * POSE
  table[o] = x
  table[o + 1] = heli.y
  table[o + 2] = z
  table[o + 3] = vx
  table[o + 4] = vz
  // The spot sweeps over the streets near the orbit centre.
  table[o + 5] = heli.cx + 40 * Math.sin(0.21 * t + heli.phase) + 18 * Math.sin(0.53 * t)
  table[o + 6] = heli.cz + 40 * Math.cos(0.17 * t + heli.phase) + 18 * Math.cos(0.41 * t)
}

export function Helicopters() {
  const reduced = useSky((s) => s.reducedMotion)
  if (reduced) return null
  return <Fleet />
}

function Fleet() {
  const built = useMemo(() => {
    // Bodies: N copies of the body, merged, with the helicopter index per vertex.
    const copies: BufferGeometry[] = []
    const bodyHeli: number[] = []
    for (let h = 0; h < N; h++) {
      for (const p of bodyParts()) {
        copies.push(p)
        for (let k = 0; k < p.getAttribute('position').count; k++) bodyHeli.push(h)
      }
    }
    const bodyGeo = mergeGeometries(copies)!
    const bodyPos = bodyGeo.getAttribute('position') as BufferAttribute
    const bodyLocal = new Float32Array(bodyPos.array)
    const bodyMesh = new Mesh(bodyGeo, new MeshBasicMaterial({ vertexColors: true, toneMapped: false }))
    bodyMesh.frustumCulled = false

    // Rotor discs: a fan per helicopter, centre alpha high, rim zero.
    const perDisc = DISC_SEGS + 1
    const discPos = new Float32Array(N * perDisc * 3)
    const discCol = new Float32Array(N * perDisc * 4)
    const discIdx: number[] = []
    for (let h = 0; h < N; h++) {
      const base = h * perDisc
      for (let s = 0; s < DISC_SEGS; s++) discIdx.push(base, base + 1 + s, base + 1 + ((s + 1) % DISC_SEGS))
      discCol.set([0.6, 0.7, 0.85, 0.22], base * 4)
      for (let s = 0; s < DISC_SEGS; s++) discCol.set([0.6, 0.7, 0.85, 0], (base + 1 + s) * 4)
    }
    const discGeo = new BufferGeometry()
    discGeo.setAttribute('position', new BufferAttribute(discPos, 3))
    discGeo.setAttribute('color', new BufferAttribute(discCol, 4))
    discGeo.setIndex(discIdx)
    const discMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
    const discMesh = new Mesh(discGeo, discMat)
    discMesh.frustumCulled = false

    // Strobes: one on the tail and one under the belly per helicopter.
    const strobeGeo = new BufferGeometry()
    strobeGeo.setAttribute('position', new BufferAttribute(new Float32Array(N * 2 * 3), 3))
    strobeGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(N * 2 * 3), 3))
    // Strobes stay as small flashes by day (half strength); the spotlight cones below are night only.
    const strobeMat = gateNightMaterial(new PointsMaterial({ size: 4.2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }), 0.5)
    const strobes = new Points(strobeGeo, strobeMat)
    strobes.frustumCulled = false

    // Spotlight cones: an apex at the belly, a ring of CONE_SEGS triangles on the street.
    const coneGeo = new BufferGeometry()
    coneGeo.setAttribute('position', new BufferAttribute(new Float32Array(N * CONE_SEGS * 3 * 3), 3))
    coneGeo.setAttribute('color', new BufferAttribute(new Float32Array(N * CONE_SEGS * 3 * 4), 4))
    const coneMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: 2, blending: AdditiveBlending, toneMapped: false })
    const cones = new Mesh(coneGeo, coneMat)
    cones.frustumCulled = false

    return {
      bodyMesh, bodyGeo, bodyLocal, bodyHeli: new Uint8Array(bodyHeli), bodyMat: bodyMesh.material as MeshBasicMaterial,
      discMesh, discGeo, discMat,
      strobes, strobeGeo, strobeMat, cones, coneGeo, coneMat,
      table: new Float32Array(N * POSE)
    }
  }, [])

  useEffect(() => () => {
    built.bodyGeo.dispose()
    built.bodyMat.dispose()
    built.discGeo.dispose()
    built.discMat.dispose()
    built.strobeGeo.dispose()
    built.strobeMat.dispose()
    built.coneGeo.dispose()
    built.coneMat.dispose()
  }, [built])

  const clock = useRef(0)

  useFrame((_, delta) => {
    clock.current += Math.min(delta, 0.05)
    const t = clock.current
    const T = built.table
    for (let h = 0; h < N; h++) poseInto(T, h, t)
    // Searchlights are night only: their cones fade out with the night mix, so no beam crosses the daytime sky.
    const gate = nightGate(lightingUniforms.uNight.value)

    // Bodies: local (x forward, y up, z right) mapped by each helicopter's heading.
    const bp = (built.bodyGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const loc = built.bodyLocal
    for (let k = 0; k < built.bodyHeli.length; k++) {
      const h = built.bodyHeli[k]!
      const o = h * POSE
      const fx = T[o + 3]!, fz = T[o + 4]!
      const rx = -fz, rz = fx
      const lx = loc[k * 3]!, ly = loc[k * 3 + 1]!, lz = loc[k * 3 + 2]!
      bp[k * 3] = T[o]! + lx * fx + lz * rx
      bp[k * 3 + 1] = T[o + 1]! + ly
      bp[k * 3 + 2] = T[o + 2]! + lx * fz + lz * rz
    }
    ;(built.bodyGeo.getAttribute('position') as BufferAttribute).needsUpdate = true

    // Rotor discs, strobes and cones.
    const dp = (built.discGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const sp = (built.strobeGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const sc = (built.strobeGeo.getAttribute('color') as BufferAttribute).array as Float32Array
    const cp = (built.coneGeo.getAttribute('position') as BufferAttribute).array as Float32Array
    const cc = (built.coneGeo.getAttribute('color') as BufferAttribute).array as Float32Array
    const perDisc = DISC_SEGS + 1
    for (let h = 0; h < N; h++) {
      const o = h * POSE
      const px = T[o]!, py = T[o + 1]!, pz = T[o + 2]!
      const fx = T[o + 3]!, fz = T[o + 4]!
      const rx = -fz, rz = fx
      const heli = HELIS[h]!

      const rotorY = py + 2.6
      const base = h * perDisc
      dp[base * 3] = px
      dp[base * 3 + 1] = rotorY
      dp[base * 3 + 2] = pz
      for (let s = 0; s < DISC_SEGS; s++) {
        const a = (s / DISC_SEGS) * Math.PI * 2
        const c = Math.cos(a) * ROTOR_R
        const si = Math.sin(a) * ROTOR_R
        const k = (base + 1 + s) * 3
        dp[k] = px + c * fx + si * rx
        dp[k + 1] = rotorY
        dp[k + 2] = pz + c * fz + si * rz
      }

      // Strobes: tail (bright pulse twice a second) and belly (dimmer, in step).
      const flash = Math.pow(Math.max(0, Math.sin((t * 1.9 + heli.phase) * Math.PI * 2)), 14)
      const strobePts: Array<[number, number, number, number]> = [
        [-6.3, 1.4, 0, flash],
        [0, -1.6, 0, flash * 0.6]
      ]
      strobePts.forEach(([lx, ly, lz, amp], j) => {
        const k = (h * 2 + j) * 3
        sp[k] = px + lx * fx + lz * rx
        sp[k + 1] = py + ly
        sp[k + 2] = pz + lx * fz + lz * rz
        sc[k] = amp
        sc[k + 1] = amp
        sc[k + 2] = amp
      })

      // Spotlight: apex under the belly, ring on the target street spot.
      const ax = px, ay = py - 1.6, az = pz
      const tx = T[o + 5]!, ty = 0.4, tz = T[o + 6]!
      let dx = tx - ax, dy = ty - ay, dz = tz - az
      const dl = Math.hypot(dx, dy, dz) || 1
      dx /= dl; dy /= dl; dz /= dl
      const [hx, hy, hz] = Math.abs(dz) < 0.9 ? [0, 0, 1] : [1, 0, 0]
      let ux = dy * hz - dz * hy
      let uy = dz * hx - dx * hz
      let uz = dx * hy - dy * hx
      const ul = Math.hypot(ux, uy, uz) || 1
      ux /= ul; uy /= ul; uz /= ul
      const vx = dy * uz - dz * uy
      const vy = dz * ux - dx * uz
      const vz = dx * uy - dy * ux
      const flick = 0.85 + 0.15 * Math.sin(t * 0.7 + h)
      for (let s = 0; s < CONE_SEGS; s++) {
        const a0 = (2 * Math.PI * s) / CONE_SEGS
        const a1 = (2 * Math.PI * (s + 1)) / CONE_SEGS
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
        const ring = (c: number, sn: number): [number, number, number] => [
          tx + CONE_R * (c * ux + sn * vx), ty + CONE_R * (c * uy + sn * vy), tz + CONE_R * (c * uz + sn * vz)
        ]
        const tri: Array<[number, number, number]> = [[ax, ay, az], ring(c0, s0), ring(c1, s1)]
        const alpha = [0.16, 0, 0]
        for (let q = 0; q < 3; q++) {
          const kv = ((h * CONE_SEGS + s) * 3 + q)
          cp[kv * 3] = tri[q]![0]
          cp[kv * 3 + 1] = tri[q]![1]
          cp[kv * 3 + 2] = tri[q]![2]
          cc[kv * 4] = 0.85
          cc[kv * 4 + 1] = 0.92
          cc[kv * 4 + 2] = 1
          cc[kv * 4 + 3] = alpha[q]! * flick * gate
        }
      }
    }
    ;(built.discGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(built.strobeGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(built.strobeGeo.getAttribute('color') as BufferAttribute).needsUpdate = true
    ;(built.coneGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(built.coneGeo.getAttribute('color') as BufferAttribute).needsUpdate = true
  })

  return (
    <>
      <primitive object={built.bodyMesh} />
      <primitive object={built.discMesh} />
      <primitive object={built.strobes} />
      <primitive object={built.cones} />
    </>
  )
}
