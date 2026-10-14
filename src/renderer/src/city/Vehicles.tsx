// Vehicles: five instanced vehicle shapes (car, NYC taxi, SUV, truck, bus), one additive light layer for head and
// tail lights (far vehicles keep only this glow, which reads as a light streak), and one additive pool layer for the
// headlight light on the road ahead. Seven draw calls in all. Poses come from the traffic simulation (Traffic.tsx).
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Group,
  InstancedBufferAttribute, InstancedMesh, Matrix4, Points, PlaneGeometry, Quaternion, ShaderMaterial, Vector3
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { lanePoint, type Network, type VehicleState } from './lanes'
import {
  HALF_LENGTH, KIND_BUS, KIND_COUNT, KIND_SUV, KIND_TAXI, KIND_TRUCK, KIND_CAR, paintFor
} from './vehicleKinds'
import { FOG_DENSITY, FOG_HEX } from './Sky'
import { ROAD_Y } from './streets'

/** Beyond these camera distances the body (or the road pools) is not drawn; the light glow stays. */
export const BODY_FAR = 170
export const POOL_FAR = 110
/** Light glow fades out between LIGHT_FAR - LIGHT_FADE and LIGHT_FAR. */
export const LIGHT_FAR = 520
const LIGHT_FADE = 120

// Part codes, one per vertex: paint, glass, trim, headlamp, tail lamp, lit window or interior.
const PART = { paint: 0, glass: 1, trim: 2, head: 3, tail: 4, lit: 5 } as const

function box(w: number, h: number, d: number, x: number, y: number, z: number, part: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d).translate(x, y, z)
  g.deleteAttribute('uv')
  g.setAttribute('aPart', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(part), 1))
  return g
}

function lamps(geo: BufferGeometry[], half: number, y: number): void {
  for (const sx of [-1, 1]) {
    geo.push(box(0.05, 0.03, 0.012, sx * 0.09, y, half + 0.003, PART.head))
    geo.push(box(0.05, 0.03, 0.012, sx * 0.09, y, -half - 0.003, PART.tail))
  }
}

/** Merged geometry for one vehicle kind, in local units: forward is +z, the base sits at y = 0. */
export function vehicleGeometry(kind: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  if (kind === KIND_CAR || kind === KIND_TAXI) {
    parts.push(box(0.26, 0.13, 0.56, 0, 0.075, 0, PART.paint))
    parts.push(box(0.27, 0.035, 0.58, 0, 0.03, 0, PART.trim))
    parts.push(box(0.22, 0.09, 0.28, 0, 0.175, -0.02, kind === KIND_TAXI ? PART.lit : PART.glass))
    parts.push(box(0.12, 0.035, 0.07, 0, 0.27, -0.02, kind === KIND_TAXI ? PART.lit : PART.trim))
    lamps(parts, 0.28, 0.09)
  } else if (kind === KIND_SUV) {
    parts.push(box(0.28, 0.17, 0.6, 0, 0.1, 0, PART.paint))
    parts.push(box(0.25, 0.13, 0.42, 0, 0.255, -0.04, PART.glass))
    parts.push(box(0.27, 0.03, 0.6, 0, 0.02, 0, PART.trim))
    lamps(parts, 0.3, 0.1)
  } else if (kind === KIND_TRUCK) {
    parts.push(box(0.3, 0.36, 0.5, 0, 0.22, -0.2, PART.paint))
    parts.push(box(0.28, 0.24, 0.22, 0, 0.14, 0.25, PART.paint))
    parts.push(box(0.26, 0.1, 0.02, 0, 0.22, 0.36, PART.glass))
    parts.push(box(0.3, 0.03, 0.9, 0, 0.02, 0, PART.trim))
    lamps(parts, 0.32, 0.12)
  } else {
    parts.push(box(0.34, 0.5, 1.5, 0, 0.27, 0, PART.paint))
    for (const sx of [-1, 1]) parts.push(box(0.01, 0.2, 1.36, sx * 0.171, 0.36, 0, PART.lit))
    parts.push(box(0.33, 0.03, 1.48, 0, 0.53, 0, PART.trim))
    parts.push(box(0.3, 0.2, 0.02, 0, 0.36, 0.76, PART.glass))
    lamps(parts, 0.76, 0.12)
  }
  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error(`vehicle geometry ${kind}`)
  for (const p of parts) p.dispose()
  return merged
}

const VEH_VERT = `
attribute float aPart;
attribute vec3 aBody;
varying vec3 vN;
varying vec3 vBody;
varying float vPart;
varying float vFog;
void main() {
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  vec4 w = modelMatrix * im * vec4(position, 1.0);
  vN = normalize(mat3(im) * normal);
  vBody = aBody;
  vPart = aPart;
  float dist = length(cameraPosition - w.xyz);
  vFog = 1.0 - exp(-pow(dist * ${FOG_DENSITY.toFixed(5)}, 2.0));
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const VEH_FRAG = `
uniform vec3 uFog;
varying vec3 vN;
varying vec3 vBody;
varying float vPart;
varying float vFog;
void main() {
  vec3 N = normalize(vN);
  float lam = 0.42 + 0.58 * max(dot(N, normalize(vec3(0.3, 0.9, 0.25))), 0.0);
  vec3 col;
  if (vPart < 0.5) col = vBody * lam;
  else if (vPart < 1.5) col = vec3(0.025, 0.035, 0.06) + vec3(0.3, 0.38, 0.6) * 0.08 * max(N.y, 0.0);
  else if (vPart < 2.5) col = vec3(0.02) * lam;
  else if (vPart < 3.5) col = vec3(1.0, 0.96, 0.88) * 3.2;
  else if (vPart < 4.5) col = vec3(1.0, 0.08, 0.04) * 2.6;
  else col = vec3(1.0, 0.7, 0.32) * 1.3;
  col = mix(col, uFog, vFog * 0.85);
  gl_FragColor = vec4(col, 1.0);
}`

const LIGHT_VERT = `
attribute vec4 aColor;
uniform float uPx;
varying vec4 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aColor.a * uPx / d, 1.6, 48.0);
  vC = aColor;
}`

const LIGHT_FRAG = `
varying vec4 vC;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float a = exp(-r2 * 7.0) + 0.3 * exp(-r2 * 2.2);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC.rgb * a, 1.0);
}`

const POOL_VERT = `
varying vec2 vUv;
varying float vFog;
void main() {
  vUv = uv;
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  vec4 w = modelMatrix * im * vec4(position, 1.0);
  float dist = length(cameraPosition - w.xyz);
  vFog = 1.0 - exp(-pow(dist * ${FOG_DENSITY.toFixed(5)}, 2.0));
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const POOL_FRAG = `
uniform vec3 uColor;
uniform float uGain;
varying vec2 vUv;
varying float vFog;
void main() {
  // A tapered light cone: narrow at the car (uv.y = 1, the vehicle end) and wider as it reaches down the road
  // (uv.y = 0). Brightest near the car, fading out with distance along the cone.
  vec2 p = vUv - 0.5;
  float far = 1.0 - vUv.y;
  float halfW = mix(0.32, 0.5, far);
  float across = clamp(1.0 - abs(p.x) / halfW, 0.0, 1.0);
  float along = (1.0 - far) * (1.0 - far) * (1.0 - smoothstep(0.55, 1.0, far));
  float a = pow(across, 1.6) * (0.25 + 0.75 * along);
  vec3 col = uColor * a * uGain * (1.0 - vFog);
  gl_FragColor = vec4(col, 1.0);
}`

/** Light points: one additive quad per light, sized in world units, tinted and intensity-scaled per light. */
export class LightPoints {
  readonly points: Points
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly geo: BufferGeometry
  private readonly mat: ShaderMaterial
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
    this.pos = new Float32Array(this.capacity * 3)
    this.col = new Float32Array(this.capacity * 4)
    this.geo = new BufferGeometry()
    const posAttr = new Float32BufferAttribute(this.pos, 3)
    posAttr.setUsage(DynamicDrawUsage)
    const colAttr = new Float32BufferAttribute(this.col, 4)
    colAttr.setUsage(DynamicDrawUsage)
    this.geo.setAttribute('position', posAttr)
    this.geo.setAttribute('aColor', colAttr)
    this.geo.setDrawRange(0, 0)
    this.mat = new ShaderMaterial({
      uniforms: { uPx: { value: 1000 } },
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.points = new Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.points.raycast = () => {}
  }

  /** Writes light i: position, colour (already scaled by intensity), and its size in world units. */
  set(i: number, x: number, y: number, z: number, r: number, g: number, b: number, size: number): void {
    this.pos[i * 3] = x
    this.pos[i * 3 + 1] = y
    this.pos[i * 3 + 2] = z
    this.col[i * 4] = r
    this.col[i * 4 + 1] = g
    this.col[i * 4 + 2] = b
    this.col[i * 4 + 3] = size
  }

  /** Pixels per world unit at distance 1 (viewport height over the frustum height). */
  setPx(px: number): void {
    this.mat.uniforms.uPx!.value = px
  }

  /** Draws the first n lights and flags the buffers as changed. */
  commit(n: number): void {
    this.geo.setDrawRange(0, Math.min(n, this.capacity))
    ;(this.geo.getAttribute('position') as Float32BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aColor') as Float32BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}

export interface VehicleFeed {
  net: Network
  vehicles: VehicleState
  /** Kind per vehicle (KIND_*). */
  kinds: Uint8Array
  /** Body paint per vehicle, rgb 0..1. */
  body: Float32Array
  /** Headlight tint per vehicle, rgb 0..1. */
  head: Float32Array
}

/** Moving vehicles: bodies by kind, light glow, and headlight pools on the road. */
export class VehicleLayer {
  readonly group = new Group()
  private readonly bodies: InstancedMesh[] = []
  private readonly bodyColours: InstancedBufferAttribute[] = []
  private readonly pools: InstancedMesh
  readonly lights: LightPoints
  private readonly m4 = new Matrix4()
  private readonly q = new Quaternion()
  private readonly pos = new Vector3()
  private readonly scl = new Vector3(1, 1, 1)
  private readonly lane = new Float32Array(3)
  private readonly mats: ShaderMaterial[] = []
  private readonly geos: BufferGeometry[] = []

  constructor(capacity: number) {
    const cap = Math.max(1, capacity)
    const bodyMat = new ShaderMaterial({
      uniforms: { uFog: { value: new Color(FOG_HEX) } },
      vertexShader: VEH_VERT,
      fragmentShader: VEH_FRAG
    })
    this.mats.push(bodyMat)
    for (let kind = 0; kind < KIND_COUNT; kind++) {
      const geo = vehicleGeometry(kind)
      const colours = new InstancedBufferAttribute(new Float32Array(cap * 3), 3)
      colours.setUsage(DynamicDrawUsage)
      geo.setAttribute('aBody', colours)
      this.geos.push(geo)
      this.bodyColours.push(colours)
      const mesh = new InstancedMesh(geo, bodyMat, cap)
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.raycast = () => {}
      this.bodies.push(mesh)
      this.group.add(mesh)
    }

    const poolGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const poolMat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color(1.0, 0.86, 0.6) }, uGain: { value: 0.32 }, uFog: { value: new Color(FOG_HEX) } },
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.mats.push(poolMat)
    this.geos.push(poolGeo)
    this.pools = new InstancedMesh(poolGeo, poolMat, cap)
    this.pools.instanceMatrix.setUsage(DynamicDrawUsage)
    this.pools.count = 0
    this.pools.frustumCulled = false
    this.pools.raycast = () => {}
    this.group.add(this.pools)

    this.lights = new LightPoints(cap * 2)
    this.group.add(this.lights.points)
  }

  /** Writes the poses of every moving vehicle into the instance buffers. */
  /** Returns the number of vehicle bodies drawn this frame. */
  update(feed: VehicleFeed, cam: Vector3, pxPerUnit: number): number {
    const v = feed.vehicles
    const net = feed.net
    const counts = new Int32Array(KIND_COUNT)
    let lightN = 0
    let poolN = 0
    this.lights.setPx(pxPerUnit)
    for (let i = 0; i < v.count; i++) {
      const seg = net.segments[v.seg[i]!]!
      const dir = v.dir[i]!
      lanePoint(net, v.seg[i]!, dir, v.t[i]!, this.lane, 0, ROAD_Y)
      const x = this.lane[0]!
      const z = this.lane[2]!
      const ux = dir * seg.ux
      const uz = dir * seg.uz
      const kind = feed.kinds[i]!
      const dist = Math.hypot(x - cam.x, ROAD_Y - cam.y, z - cam.z)
      const fade = 1 - smoothstep(LIGHT_FAR - LIGHT_FADE, LIGHT_FAR, dist)
      if (fade <= 0) continue
      const half = HALF_LENGTH[kind]!
      // Lights: a head and a tail at each end. Stopped cars show brighter tails.
      const stopped = v.speed[i]! < 0.3
      const head = [feed.head[i * 3]!, feed.head[i * 3 + 1]!, feed.head[i * 3 + 2]!]
      const hx = x + ux * (half + 0.02)
      const hz = z + uz * (half + 0.02)
      const tx = x - ux * (half + 0.02)
      const tz = z - uz * (half + 0.02)
      this.lights.set(lightN++, hx, ROAD_Y + 0.09, hz, head[0]! * 2.8 * fade, head[1]! * 2.8 * fade, head[2]! * 2.8 * fade, 0.34)
      this.lights.set(lightN++, tx, ROAD_Y + 0.09, tz, 1.0 * (stopped ? 1.8 : 1.0) * fade, 0.06 * fade, 0.02 * fade, 0.3)
      // Headlight pool on the road ahead.
      if (dist < POOL_FAR) {
        this.m4.compose(this.pos.set(x + ux * (half + 0.9), ROAD_Y + 0.05, z + uz * (half + 0.9)), this.q.setFromAxisAngle(UP, Math.atan2(ux, uz)), this.scl.set(0.9, 1, 2.0))
        this.pools.setMatrixAt(poolN++, this.m4)
      }
      // Bodies, unless the vehicle is far away.
      if (dist > BODY_FAR) continue
      const k = counts[kind]!++
      this.m4.compose(this.pos.set(x, ROAD_Y, z), this.q.setFromAxisAngle(UP, Math.atan2(ux, uz)), this.scl.set(1, 1, 1))
      this.bodies[kind]!.setMatrixAt(k, this.m4)
      const bc = this.bodyColours[kind]!.array as Float32Array
      bc[k * 3] = feed.body[i * 3]!
      bc[k * 3 + 1] = feed.body[i * 3 + 1]!
      bc[k * 3 + 2] = feed.body[i * 3 + 2]!
    }
    for (let kind = 0; kind < KIND_COUNT; kind++) {
      const mesh = this.bodies[kind]!
      mesh.count = counts[kind]!
      mesh.instanceMatrix.needsUpdate = true
      this.bodyColours[kind]!.needsUpdate = true
    }
    this.pools.count = poolN
    this.pools.instanceMatrix.needsUpdate = true
    this.lights.commit(lightN)
    return counts.reduce((a, b) => a + b, 0)
  }

  dispose(): void {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.lights.dispose()
  }
}

const UP = new Vector3(0, 1, 0)

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Parked cars along the kerbs: static, with dim tail glow only. Used with reduced motion, when nothing moves.
 * `pick` returns a uniform random number in [0, 1); `count` is the number of parked cars.
 */
export function parkedGlow(net: Network, count: number, pick: () => number): LightPoints {
  const lights = new LightPoints(Math.max(1, count * 2))
  let n = 0
  const segs = net.segments
  for (let k = 0; k < count && segs.length > 0; k++) {
    const s = Math.floor(pick() * segs.length)
    const seg = segs[s]!
    const along = pick() * seg.length
    const side = pick() < 0.5 ? -1 : 1
    const a = net.nodes[seg.a]!
    const x = a.x + seg.ux * along - seg.uz * side * 0.4
    const z = a.z + seg.uz * along + seg.ux * side * 0.4
    lights.set(n++, x, ROAD_Y + 0.1, z, 0.8, 0.05, 0.02, 0.26)
    lights.set(n++, x + 0.02, ROAD_Y + 0.1, z + 0.02, 0.5, 0.45, 0.4, 0.14)
  }
  lights.commit(n)
  lights.setPx(1000)
  return lights
}
