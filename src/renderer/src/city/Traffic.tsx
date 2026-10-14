// Night traffic: every car is one additive light streak (white/amber/red/agent-coloured) drawn from a single
// InstancedBufferGeometry. Positions are updated on the CPU in one frame loop into typed arrays, with no
// per-frame allocation. Cars slow down near hot files (construction), far cars are culled and mid-range cars
// are thinned. A new agent sends a delivery convoy from the city edge to its current file's district.
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, ShaderMaterial, type PerspectiveCamera
} from 'three'
import type { AgentInfo, CityLayout } from '@shared/types'
import { buildingCenter, findBuilding } from '@shared/layout'
import { useSky, type Heat } from '../state/store'
import {
  buildLanes, componentOf, createVehicles, lanePoint, mulberry32, routeTo, stepVehicle,
  type Network, type Rng, type VehicleState
} from './lanes'
import { Aircraft, advanceAircraft } from './Aircraft'

declare global {
  interface Window {
    /** Test hook: simulate `seconds` of traffic and aircraft on the next frame, deterministically. */
    __skylineTrafficStep?: (seconds: number) => { total: number; drawn: number };
  }
}

/** One car per this many units of lane. */
const LANE_PER_CAR = 4
const MAX_CARS = 600
/** Vehicle slots reserved for delivery convoys (the first ones in the arrays). */
const CONVOY_SLOTS = 18
const CONVOY_SIZE = 3
/** Cars within this distance of a hot file slow down; the ramp reaches full speed at the edge. */
const HOT_RADIUS = 4
const HOT_WINDOW_MS = 90_000
/** Culling from the camera: beyond FAR no car is drawn; beyond MID only every other car. The framed view sits ~330 up. */
const FAR = 520
const MID = 380
// Above the tallest plate (0.08 per depth, so depth 4 tops out at 0.32).
const LIGHT_Y = 0.38
const SUB_STEP = 1 / 20

const VERT = `
attribute vec3 aHead;
attribute vec3 aTrail;
attribute vec4 aColor;
uniform float uWidth;
uniform float uPxWorld;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 tail = aHead - vec3(aTrail.x, 0.0, aTrail.y) * aTrail.z;
  vec3 along = mix(tail, aHead, position.x);
  float dist = length(cameraPosition - aHead);
  // Never thinner than about 1.7 pixels, so distant streaks still catch the bloom.
  float w = max(uWidth, dist * uPxWorld * 1.7);
  vec3 side = vec3(-aTrail.y, 0.0, aTrail.x);
  vec3 p = along + side * (position.y * w);
  vUv = vec2(position.x, position.y + 0.5);
  vColor = aColor.rgb;
  vAlpha = aColor.a;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`

const FRAG = `
uniform float uGain;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float along = vUv.x;
  float across = clamp(1.0 - abs(vUv.y - 0.5) * 2.0, 0.0, 1.0);
  float core = pow(across, 1.4);
  // Long-exposure profile: a faint tail that brightens into the head. The last part blooms.
  float intensity = 0.35 * along + pow(along, 4.0) + 2.5 * pow(along, 18.0);
  vec3 tailCol = vec3(1.0, 0.14, 0.06);
  vec3 col = mix(tailCol, vColor, smoothstep(0.3, 1.0, along));
  gl_FragColor = vec4(col * uGain * intensity * core * vAlpha, 1.0);
}`

/** Light-streak palette: head colour per car, weighted. The tail is always red. */
function carColor(r: number, out: Float32Array, o: number): void {
  // [r, g, b] for heads: warm white, amber, hot red, cyan, magenta.
  let c: [number, number, number]
  if (r < 0.55) c = [1.0, 0.94, 0.84]
  else if (r < 0.75) c = [1.0, 0.55, 0.15]
  else if (r < 0.85) c = [1.0, 0.16, 0.08]
  else if (r < 0.93) c = [0.35, 0.9, 1.0]
  else c = [1.0, 0.25, 0.95]
  out[o] = c[0]
  out[o + 1] = c[1]
  out[o + 2] = c[2]
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

interface World {
  layout: CityLayout;
  net: Network;
  comp: Int32Array;
  vehicles: VehicleState;
  rng: Rng;
  /** Per-vehicle head colour (rgb). */
  colors: Float32Array;
  /** Per-segment bounding boxes, for the distance test against hot files. */
  sx0: Float32Array; sz0: Float32Array; sx1: Float32Array; sz1: Float32Array;
  /** Per-segment speed multiplier, 1 = free flow. */
  drag: Float32Array;
  /** Nodes on the city edge in the largest component, where convoys enter. */
  edgeNodes: number[];
  /** Next-hop tables by goal node. */
  routes: Map<number, Int32Array>;
  /** Scratch and instanced buffers. */
  scratch: Float32Array;
  head: Float32Array; trail: Float32Array; tint: Float32Array;
  geometry: InstancedBufferGeometry;
  material: ShaderMaterial;
  mesh: Mesh;
}

function buildWorld(layout: CityLayout): World {
  const net = buildLanes(layout)
  const comp = componentOf(net)
  const count = Math.min(MAX_CARS, Math.floor(net.totalLength / LANE_PER_CAR))
  const rng = mulberry32(0x5eed)
  const vehicles = createVehicles(count, net, rng, 2.6, 5)
  const n = vehicles.count

  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) carColor(rng(), colors, i * 3)

  const segCount = net.segments.length
  const sx0 = new Float32Array(segCount), sz0 = new Float32Array(segCount)
  const sx1 = new Float32Array(segCount), sz1 = new Float32Array(segCount)
  net.segments.forEach((s, i) => {
    const a = net.nodes[s.a]!
    const b = net.nodes[s.b]!
    sx0[i] = Math.min(a.x, b.x)
    sx1[i] = Math.max(a.x, b.x)
    sz0[i] = Math.min(a.z, b.z)
    sz1[i] = Math.max(a.z, b.z)
  })

  // Convoys enter at the boundary of the largest connected street network.
  const sizes = new Map<number, number>()
  for (const c of comp) sizes.set(c, (sizes.get(c) ?? 0) + 1)
  let mainComp = -1
  let best = -1
  for (const [c, k] of sizes) {
    if (k > best) {
      best = k
      mainComp = c
    }
  }
  const edgeNodes = net.nodes
    .filter((nd) => comp[nd.id] === mainComp && (Math.abs(nd.x) > 56 || Math.abs(nd.z) > 56))
    .map((nd) => nd.id)

  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const head = new Float32Array(Math.max(1, n) * 3)
  const trail = new Float32Array(Math.max(1, n) * 3)
  const tint = new Float32Array(Math.max(1, n) * 4)
  geometry.setAttribute('aHead', new InstancedBufferAttribute(head, 3))
  geometry.setAttribute('aTrail', new InstancedBufferAttribute(trail, 3))
  geometry.setAttribute('aColor', new InstancedBufferAttribute(tint, 4))
  geometry.instanceCount = 0

  const material = new ShaderMaterial({
    uniforms: {
      uWidth: { value: 0.2 },
      uPxWorld: { value: 0.002 },
      uGain: { value: 1.6 }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 3

  return {
    layout, net, comp, vehicles, rng, colors, sx0, sz0, sx1, sz1,
    drag: new Float32Array(segCount).fill(1),
    edgeNodes,
    routes: new Map(),
    scratch: new Float32Array(3),
    head, trail, tint, geometry, material, mesh
  }
}

/** Marks lanes near hot files as jammed. Recomputed when the heat map changes. */
function computeDrag(w: World, heat: Record<string, Heat>, now: number): void {
  const drag = w.drag
  drag.fill(1)
  for (const path in heat) {
    const h = heat[path]
    if (!h || now - h.ts > HOT_WINDOW_MS) continue
    const b = findBuilding(w.layout, path)
    if (!b) continue
    const c = buildingCenter(b)
    for (let s = 0; s < drag.length; s++) {
      const cx = Math.min(w.sx1[s]!, Math.max(w.sx0[s]!, c.x))
      const cz = Math.min(w.sz1[s]!, Math.max(w.sz0[s]!, c.z))
      const d = Math.hypot(c.x - cx, c.z - cz)
      if (d >= HOT_RADIUS) continue
      const f = 0.18 + 0.82 * smooth(0, HOT_RADIUS, d)
      if (f < drag[s]!) drag[s] = f
    }
  }
}

/** A delivery convoy: CONVOY_SIZE vehicles from the city edge to the district of the agent's current file. */
function spawnConvoy(w: World, agent: AgentInfo, slot0: number): void {
  const net = w.net
  if (w.edgeNodes.length === 0) return
  const edge = w.edgeNodes[Math.floor(w.rng() * w.edgeNodes.length)]!
  const comp = w.comp[edge]!
  const b = agent.currentFile ? findBuilding(w.layout, agent.currentFile) : undefined
  let goal = -1
  let goalD = Infinity
  const tx = b ? buildingCenter(b).x : 0
  const tz = b ? buildingCenter(b).z : 0
  for (const nd of net.nodes) {
    if (w.comp[nd.id] !== comp) continue
    const d = b ? (nd.x - tx) ** 2 + (nd.z - tz) ** 2 : w.rng() // no file: any node in the district of the edge
    if (d < goalD) {
      goalD = d
      goal = nd.id
    }
  }
  if (goal < 0 || goal === edge) return
  let table = w.routes.get(goal)
  if (!table) {
    table = routeTo(net, goal)
    w.routes.set(goal, table)
  }
  const first = table[edge]!
  if (first < 0) return
  const seg = net.segments[first]!
  const dir = seg.a === edge ? 1 : -1
  const v = w.vehicles
  const rgb = new Color(agent.color)
  for (let k = 0; k < CONVOY_SIZE; k++) {
    const slot = (slot0 + k) % Math.max(1, Math.min(CONVOY_SLOTS, v.count))
    if (slot >= v.count) break
    v.seg[slot] = first
    v.dir[slot] = dir
    v.t[slot] = Math.min(seg.length * 0.5, k * 2.2)
    v.cruise[slot] = 5.6 + k * 0.25
    v.speed[slot] = v.cruise[slot]!
    v.routes[slot] = table
    // Convoys carry the agent's colour as their head light.
    w.colors[slot * 3] = rgb.r
    w.colors[slot * 3 + 1] = rgb.g
    w.colors[slot * 3 + 2] = rgb.b
  }
}

/** Advances the simulation by `seconds`, in fixed sub-steps so fast-forward matches a normal run. */
function simulate(w: World, seconds: number): void {
  let left = seconds
  while (left > 1e-6) {
    const h = Math.min(SUB_STEP, left)
    stepVehicle(w.vehicles, h, w.net, w.rng, w.drag)
    left -= h
  }
}

let pendingAdvance = 0
/** Last frame's counts, for the test hook. */
const carStats = { total: 0, drawn: 0 }

function Streets({ layout }: { layout: CityLayout }) {
  const world = useMemo(() => buildWorld(layout), [layout])
  useEffect(() => () => {
    world.geometry.dispose()
    world.material.dispose()
  }, [world])

  useEffect(() => {
    const hook = (seconds: number) => {
      pendingAdvance += Math.max(0, Math.min(seconds, 120))
      advanceAircraft(seconds)
      return { ...carStats }
    }
    window.__skylineTrafficStep = hook
    return () => {
      if (window.__skylineTrafficStep === hook) delete window.__skylineTrafficStep
    }
  }, [])

  useFrame(({ camera, size }, delta) => {
    const w = world
    const st = useSky.getState()
    // New agents: send a convoy each, a few per frame at most.
    if (st.agents !== lastAgents.get(w)) {
      lastAgents.set(w, st.agents)
      let sent = 0
      for (const a of st.agents) {
        if (seenAgentIds.has(a.id) || sent >= 3) continue
        seenAgentIds.add(a.id)
        if (w.vehicles.count >= 2 * CONVOY_SIZE) {
          spawnConvoy(w, a, convoyCursor.get(w) ?? 0)
          convoyCursor.set(w, ((convoyCursor.get(w) ?? 0) + CONVOY_SIZE) % CONVOY_SLOTS)
        }
        sent++
      }
    }

    // Slowdowns follow the heat map; recomputed on change and about twice a second.
    const frame = (frameNo.get(w) ?? 0) + 1
    frameNo.set(w, frame)
    if (st.heat !== lastHeat.get(w) || frame % 30 === 0) {
      lastHeat.set(w, st.heat)
      computeDrag(w, st.heat, Date.now())
    }

    // Simulation: a fast-forward request, or the real frame time.
    if (pendingAdvance > 0) {
      simulate(w, pendingAdvance)
      pendingAdvance = 0
    } else {
      simulate(w, Math.min(delta, 0.05))
    }

    // Instance buffers, with distance culling.
    const cam = camera.position
    const cx = cam.x, cy = cam.y, cz = cam.z
    const v = w.vehicles
    const net = w.net
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180
    w.material.uniforms.uPxWorld!.value = (2 * Math.tan(fov / 2)) / Math.max(1, size.height)
    const sc = w.scratch
    let k = 0
    for (let i = 0; i < v.count; i++) {
      lanePoint(net, v.seg[i]!, v.dir[i]!, v.t[i]!, sc, 0, LIGHT_Y)
      const dx = sc[0]! - cx
      const dy = sc[1]! - cy
      const dz = sc[2]! - cz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist > FAR) continue
      if (dist > MID && (i & 1) === 1) continue
      const fade = 1 - smooth(FAR - 40, FAR, dist)
      const ux = v.dir[i]! * net.segments[v.seg[i]!]!.ux
      const uz = v.dir[i]! * net.segments[v.seg[i]!]!.uz
      const len = 1.4 + v.speed[i]! * 0.5
      w.head[k * 3] = sc[0]!
      w.head[k * 3 + 1] = sc[1]!
      w.head[k * 3 + 2] = sc[2]!
      w.trail[k * 3] = ux
      w.trail[k * 3 + 1] = uz
      w.trail[k * 3 + 2] = len
      w.tint[k * 4] = w.colors[i * 3]!
      w.tint[k * 4 + 1] = w.colors[i * 3 + 1]!
      w.tint[k * 4 + 2] = w.colors[i * 3 + 2]!
      w.tint[k * 4 + 3] = fade
      k++
    }
    carStats.total = v.count
    carStats.drawn = k
    const g = w.geometry
    g.instanceCount = k
    ;(g.getAttribute('aHead') as InstancedBufferAttribute).needsUpdate = true
    ;(g.getAttribute('aTrail') as InstancedBufferAttribute).needsUpdate = true
    ;(g.getAttribute('aColor') as InstancedBufferAttribute).needsUpdate = true
  })

  return <primitive object={world.mesh} />
}

// Per-world bookkeeping for the frame loop, kept off the component so a layout change starts clean.
// Agents that already sent a convoy. Kept across layouts, so a rescan does not send them again.
const seenAgentIds = new Set<string>()
const lastAgents = new WeakMap<World, AgentInfo[]>()
const convoyCursor = new WeakMap<World, number>()
const frameNo = new WeakMap<World, number>()
const lastHeat = new WeakMap<World, Record<string, Heat>>()

/** Traffic streets and the aircraft above the city. Renders nothing with reduced motion. */
export function Traffic() {
  const layout = useSky((s) => s.layout)
  const reduced = useSky((s) => s.reducedMotion)
  if (reduced) return null
  return (
    <>
      {layout && <Streets layout={layout} />}
      <Aircraft />
    </>
  )
}
