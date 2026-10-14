// Pedestrians: warm glimmering dots, one point layer (one draw call, at most PED_MAX points). Walkers stroll the
// sidewalks, weighted toward the middle of the city. At signalled junctions, crossers walk the crosswalk only while
// the road they cross is red. Nothing is drawn beyond PED_FAR units from the camera.
import { AdditiveBlending, BufferGeometry, DynamicDrawUsage, Float32BufferAttribute, Points, ShaderMaterial, Vector3 } from 'three'
import type { CityLayout } from '@shared/types'
import { chooseTurn, isSignalNode, mulberry32, PHASE_RED, signalOffset, signalPhase, type Network, type Rng } from './lanes'
import { ROAD_Y } from './streets'

export const PED_MAX = 2000
export const PED_FAR = 120
const SPEED_MIN = 0.9
const SPEED_MAX = 1.5
/** Walkers keep to the sidewalk, this far from the street centre line. */
const SIDE_OFFSET = 0.4
/** Crossers wait this far from the junction centre along the road; the crosswalk is 1.2 long across it. */
const CROSS_REACH = 0.75
const CROSS_HALF = 0.6

export interface Pedestrians {
  walkers: number
  crossers: number
  /** Walkers: current segment, direction (+1 / -1), distance along it, sidewalk side (+1 / -1), speed and a glimmer seed. */
  wSeg: Int32Array
  wDir: Int8Array
  wT: Float32Array
  wSide: Int8Array
  wSpeed: Float32Array
  wSeed: Float32Array
  /** Crossers: junction node, whether they cross an east-west road, their side of it (+1 / -1), and a seed. */
  cNode: Int32Array
  cAcross: Uint8Array
  cSide: Int8Array
  cSeed: Float32Array
  /** The hotspot the crowd gathers around: the centre of the buildings. */
  centre: { x: number; z: number }
}

/** Activity weight near the hotspot: 1 at the centre, falling off over `sigma`. */
function hot(x: number, z: number, cx: number, cz: number, sigma: number): number {
  const d2 = (x - cx) ** 2 + (z - cz) ** 2
  return Math.exp(-d2 / (2 * sigma * sigma))
}

/**
 * Where the people are. Deterministic for a layout and seed. The count is capped by `budget` (at most PED_MAX), and
 * denser streets and junctions sit closer to the hotspot.
 */
export function planPedestrians(layout: CityLayout, net: Network, rng: Rng, budget = PED_MAX): Pedestrians {
  let sx = 0
  let sz = 0
  for (const b of layout.buildings) {
    sx += b.x + b.w / 2
    sz += b.z + b.d / 2
  }
  const centre = layout.buildings.length > 0
    ? { x: sx / layout.buildings.length, z: sz / layout.buildings.length }
    : { x: 0, z: 0 }
  const sigma = Math.max(12, layout.size * 0.18)
  const cap = Math.max(0, Math.min(PED_MAX, Math.floor(budget)))

  // Crossers: up to two per signalled junction near the hotspot, and never more than 40 % of the cap.
  const junctions = net.nodes.filter((n) => isSignalNode(net, n.id))
  const crossCap = Math.min(Math.floor(cap * 0.4), junctions.length * 4)
  const crossers: { node: number; across: number; side: number; seed: number }[] = []
  for (const j of junctions) {
    const w = hot(j.x, j.z, centre.x, centre.z, sigma)
    const k = Math.round(w * 2 + rng() * 0.6)
    for (let c = 0; c < k && crossers.length < crossCap; c++) {
      crossers.push({ node: j.id, across: rng() < 0.5 ? 1 : 0, side: rng() < 0.5 ? -1 : 1, seed: rng() })
    }
  }

  // Walkers: segments picked by length and proximity to the hotspot.
  const walkers = Math.max(0, Math.min(cap - crossers.length, Math.floor(net.totalLength * 1.2)))
  const segs = net.segments
  const cum = new Float64Array(segs.length)
  let acc = 0
  segs.forEach((s, i) => {
    const mx = (net.nodes[s.a]!.x + net.nodes[s.b]!.x) / 2
    const mz = (net.nodes[s.a]!.z + net.nodes[s.b]!.z) / 2
    acc += s.length * (0.25 + hot(mx, mz, centre.x, centre.z, sigma))
    cum[i] = acc
  })
  const wSeg = new Int32Array(walkers)
  const wDir = new Int8Array(walkers)
  const wT = new Float32Array(walkers)
  const wSide = new Int8Array(walkers)
  const wSpeed = new Float32Array(walkers)
  const wSeed = new Float32Array(walkers)
  for (let i = 0; i < walkers && segs.length > 0; i++) {
    const r = rng() * acc
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cum[mid]! < r) lo = mid + 1
      else hi = mid
    }
    wSeg[i] = lo
    wDir[i] = rng() < 0.5 ? 1 : -1
    wT[i] = rng() * segs[lo]!.length
    wSide[i] = rng() < 0.5 ? -1 : 1
    wSpeed[i] = SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN)
    wSeed[i] = rng()
  }
  return {
    walkers: segs.length > 0 ? walkers : 0,
    crossers: crossers.length,
    wSeg, wDir, wT, wSide, wSpeed, wSeed,
    cNode: Int32Array.from(crossers, (c) => c.node),
    cAcross: Uint8Array.from(crossers, (c) => c.across),
    cSide: Int8Array.from(crossers, (c) => c.side),
    cSeed: Float32Array.from(crossers, (c) => c.seed),
    centre
  }
}

const PED_VERT = `
attribute float aSeed;
uniform float uTime;
uniform float uPx;
varying float vB;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  if (d > ${PED_FAR.toFixed(1)} || d < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vB = 0.0;
    return;
  }
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.14 * uPx / d, 1.2, 6.0);
  vB = (0.55 + 0.45 * sin(uTime * 2.6 + aSeed * 6.2831)) * (1.0 - smoothstep(${(PED_FAR * 0.7).toFixed(1)}, ${PED_FAR.toFixed(1)}, d));
}`

const PED_FRAG = `
varying float vB;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(p, p) * 5.0);
  if (a < 0.02 || vB <= 0.0) discard;
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * 1.5 * a * vB, 1.0);
}`

/** The crowd as one point layer. `advance` moves the walkers; `write` places everyone for a clock time. */
export class PedestrianLayer {
  readonly points: Points
  private readonly plan: Pedestrians
  private readonly net: Network
  private readonly pos: Float32Array
  private readonly seeds: Float32Array
  private readonly geo: BufferGeometry
  private readonly mat: ShaderMaterial
  private readonly rng: Rng
  private time = 0

  constructor(layout: CityLayout, net: Network, seed = 0x9ed) {
    this.net = net
    this.rng = mulberry32(seed)
    this.plan = planPedestrians(layout, net, this.rng)
    const n = this.plan.walkers + this.plan.crossers
    this.pos = new Float32Array(Math.max(1, n) * 3)
    this.seeds = new Float32Array(Math.max(1, n))
    for (let i = 0; i < this.plan.walkers; i++) this.seeds[i] = this.plan.wSeed[i]!
    for (let i = 0; i < this.plan.crossers; i++) this.seeds[this.plan.walkers + i] = this.plan.cSeed[i]!
    this.geo = new BufferGeometry()
    const p = new Float32BufferAttribute(this.pos, 3)
    p.setUsage(DynamicDrawUsage)
    this.geo.setAttribute('position', p)
    this.geo.setAttribute('aSeed', new Float32BufferAttribute(this.seeds, 1))
    this.geo.setDrawRange(0, n)
    this.mat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: 1000 } },
      vertexShader: PED_VERT,
      fragmentShader: PED_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.points = new Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.points.raycast = () => {}
    this.write(0, 1000, 0)
  }

  /** Moves the walkers along the sidewalks, turning at junctions as the cars do. */
  advance(seconds: number): void {
    const { net, plan } = this
    const segs = net.segments
    for (let i = 0; i < plan.walkers; i++) {
      let s = plan.wSeg[i]!
      let d = plan.wDir[i]!
      let t = plan.wT[i]! + plan.wSpeed[i]! * seconds
      for (let guard = 0; guard < 4; guard++) {
        const seg = segs[s]!
        if (t <= seg.length) break
        const node = d > 0 ? seg.b : seg.a
        const next = chooseTurn(net, s, d, node, this.rng)
        t -= seg.length
        d = next === s ? -d : net.segments[next]!.a === node ? 1 : -1
        s = next
      }
      plan.wSeg[i] = s
      plan.wDir[i] = d as 1 | -1
      plan.wT[i] = Math.min(t, segs[s]!.length)
    }
    this.time += seconds
  }

  /** Places everyone for the traffic clock `clock` (seconds), at pixel scale `px` (pixels per unit at distance 1). */
  write(clock: number, px: number, timeSeconds: number = this.time): void {
    const { net, plan } = this
    const segs = net.segments
    this.mat.uniforms.uTime!.value = timeSeconds
    this.mat.uniforms.uPx!.value = px
    for (let i = 0; i < plan.walkers; i++) {
      const seg = segs[plan.wSeg[i]!]!
      const d = plan.wDir[i]!
      const start = net.nodes[d > 0 ? seg.a : seg.b]!
      const tx = d * seg.ux
      const tz = d * seg.uz
      const off = plan.wSide[i]! * SIDE_OFFSET
      const t = plan.wT[i]!
      this.pos[i * 3] = start.x + tx * t - tz * off
      this.pos[i * 3 + 1] = ROAD_Y + 0.05
      this.pos[i * 3 + 2] = start.z + tz * t + tx * off
    }
    for (let c = 0; c < plan.crossers; c++) {
      const i = plan.walkers + c
      const node = net.nodes[plan.cNode[c]!]!
      const across = plan.cAcross[c]! === 1
      // The road this crossing goes over: east-west when across, so it is red for east-west traffic.
      const offset = signalOffset(node.id)
      const red = signalPhase(clock, offset, across) === PHASE_RED
      const p = red ? 0.5 - 0.5 * Math.cos(2 * Math.PI * (clock * 0.6 + plan.cSeed[c]!)) : 0
      const along = -CROSS_HALF + 2 * CROSS_HALF * p
      const side = plan.cSide[c]! * CROSS_REACH
      if (across) {
        this.pos[i * 3] = node.x + side
        this.pos[i * 3 + 2] = node.z + along
      } else {
        this.pos[i * 3] = node.x + along
        this.pos[i * 3 + 2] = node.z + side
      }
      this.pos[i * 3 + 1] = ROAD_Y + 0.05
    }
    ;(this.geo.getAttribute('position') as Float32BufferAttribute).needsUpdate = true
  }

  /** Distance-sorted helper for tests and the camera: the number of people within `r` of a point. */
  countNear(p: Vector3, r: number): number {
    let k = 0
    const n = this.plan.walkers + this.plan.crossers
    for (let i = 0; i < n; i++) {
      if (Math.hypot(this.pos[i * 3]! - p.x, this.pos[i * 3 + 2]! - p.z) < r) k++
    }
    return k
  }

  get count(): number {
    return this.plan.walkers + this.plan.crossers
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}
