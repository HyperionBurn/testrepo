// Night traffic: the car simulation (lanes.ts stepTraffic: lanes, car-following, signals), drawn as real vehicles
// (Vehicles.tsx), traffic signals (Signals.tsx) and pedestrians (Pedestrians.tsx). The simulation is CPU, in typed
// arrays, with no per-frame allocation to speak of. Cars slow down near hot files (construction), a new agent sends a
// delivery convoy from the city edge, and with reduced motion nothing moves: only parked cars glow, and the signals
// hold their phase. Aircraft share this mount (Aircraft.tsx).
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Group, PerspectiveCamera, type Object3D } from 'three'
import type { AgentInfo, CityLayout } from '@shared/types'
import { buildingCenter, findBuilding } from '@shared/layout'
import { useSky, type Heat } from '../state/store'
import {
  buildLanes, componentOf, createVehicles, mulberry32, routeTo, stepTraffic, vehicleBudget,
  type Network, type Rng, type TrafficContext, type VehicleState
} from './lanes'
import { Aircraft, advanceAircraft } from './Aircraft'
import { VehicleLayer, parkedGlow, type VehicleFeed } from './Vehicles'
import { KIND_TRUCK, paintFor, pickKind } from './vehicleKinds'
import { SignalLayer } from './Signals'
import { PedestrianLayer } from './Pedestrians'

declare global {
  interface Window {
    /** Test hook: simulate `seconds` of traffic and aircraft on the next frame, deterministically. */
    __skylineTrafficStep?: (seconds: number) => { total: number; drawn: number };
  }
}

/** Cars within this distance of a hot file slow down; the ramp reaches full speed at the edge. */
const HOT_RADIUS = 4
const HOT_WINDOW_MS = 90_000
/** Vehicle slots reserved for delivery convoys (the first ones in the arrays). */
const CONVOY_SLOTS = 18
const CONVOY_SIZE = 3
/** Simulation sub-step of the frame loop, and the most real time one frame may simulate. */
const MAX_FRAME_STEP = 0.05
/** Pedestrians advance in these steps, so a long fast-forward keeps them on the sidewalks. */
const PED_STEP = 1 / 20

/** Whether the road surface and street furniture use the Kenney tiles (stylized) or the procedural road. */
export function usesStylizedRoads(): boolean {
  return (useSky.getState() as unknown as { buildingStyle?: string }).buildingStyle === 'stylized'
}

interface World {
  layout: CityLayout
  net: Network
  comp: Int32Array
  vehicles: VehicleState
  rng: Rng
  kinds: Uint8Array
  body: Float32Array
  head: Float32Array
  /** Per-segment bounding boxes, for the distance test against hot files. */
  sx0: Float32Array; sz0: Float32Array; sx1: Float32Array; sz1: Float32Array
  /** Per-segment speed multiplier, 1 = free flow. */
  drag: Float32Array
  edgeNodes: number[]
  routes: Map<number, Int32Array>
  ctx: TrafficContext
  feed: VehicleFeed
  layer: VehicleLayer
  signals: SignalLayer
  peds: PedestrianLayer
  group: Group
}

function buildWorld(layout: CityLayout): World {
  const net = buildLanes(layout)
  const comp = componentOf(net)
  const count = vehicleBudget(net.totalLength)
  const rng = mulberry32(0x5eed)
  const vehicles = createVehicles(count, net, rng, 2.6, 5)
  const n = vehicles.count
  const kinds = new Uint8Array(Math.max(1, n))
  const body = new Float32Array(Math.max(1, n) * 3)
  const head = new Float32Array(Math.max(1, n) * 3)
  for (let i = 0; i < n; i++) {
    const kind = pickKind(rng())
    kinds[i] = kind
    const [r, g, b] = paintFor(kind, rng())
    body[i * 3] = r
    body[i * 3 + 1] = g
    body[i * 3 + 2] = b
    head[i * 3] = 1
    head[i * 3 + 1] = 0.95
    head[i * 3 + 2] = 0.84
  }

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
    .filter((nd) => comp[nd.id] === mainComp && (Math.abs(nd.x) > layout.size / 2 - 8 || Math.abs(nd.z) > layout.size / 2 - 8))
    .map((nd) => nd.id)

  const ctx: TrafficContext = { clock: 0, pending: new Int32Array(Math.max(1, n)).fill(-1), drag: new Float32Array(segCount).fill(1) }
  const layer = new VehicleLayer(Math.max(1, n))
  const signals = new SignalLayer(net)
  const peds = new PedestrianLayer(layout, net)
  const group = new Group()
  group.name = 'skyline-traffic'
  group.add(layer.group, signals.lights.points, peds.points)

  return {
    layout, net, comp, vehicles: { ...vehicles, count: n }, rng, kinds, body, head,
    sx0, sz0, sx1, sz1, drag: ctx.drag!, edgeNodes, routes: new Map(), ctx,
    feed: { net, vehicles, kinds, body, head },
    layer, signals, peds, group
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

/** A delivery convoy: CONVOY_SIZE trucks from the city edge to the district of the agent's current file. */
function spawnConvoy(w: World, agent: AgentInfo, slot0: number): void {
  const net = w.net
  if (w.edgeNodes.length === 0) return
  const edge = w.edgeNodes[Math.floor(w.rng() * w.edgeNodes.length)]!
  const comp = w.comp[edge]!
  const b = agent.currentFile ? findBuilding(w.layout, agent.currentFile) : undefined
  const bc = b ? buildingCenter(b) : null
  let goal = -1
  let goalD = Infinity
  for (const nd of net.nodes) {
    if (w.comp[nd.id] !== comp) continue
    // Without a file, any node of the edge's component will do.
    const d = bc ? (nd.x - bc.x) ** 2 + (nd.z - bc.z) ** 2 : w.rng()
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
  const slots = Math.min(CONVOY_SLOTS, v.count)
  if (slots === 0) return
  const rgb = new Color(agent.color)
  for (let k = 0; k < CONVOY_SIZE; k++) {
    const slot = (slot0 + k) % slots
    v.seg[slot] = first
    v.dir[slot] = dir
    v.t[slot] = Math.min(seg.length * 0.5, k * 2.2)
    v.cruise[slot] = 5.6 + k * 0.25
    v.speed[slot] = v.cruise[slot]!
    v.routes[slot] = table
    w.ctx.pending[slot] = -1
    // Convoys are trucks in the agent's colour, with the agent's colour on their headlights.
    w.kinds[slot] = KIND_TRUCK
    w.body[slot * 3] = rgb.r
    w.body[slot * 3 + 1] = rgb.g
    w.body[slot * 3 + 2] = rgb.b
    w.head[slot * 3] = rgb.r
    w.head[slot * 3 + 1] = rgb.g
    w.head[slot * 3 + 2] = rgb.b
  }
}

/** Advances the simulation by `seconds`: cars with stepTraffic (it sub-steps), pedestrians in fixed steps. */
function simulate(w: World, seconds: number): void {
  stepTraffic(w.vehicles, seconds, w.net, w.rng, w.ctx)
  let left = seconds
  while (left > 1e-6) {
    const h = Math.min(PED_STEP, left)
    w.peds.advance(h)
    left -= h
  }
}

let pendingAdvance = 0
/** Last frame's counts, for the test hook. */
const carStats = { total: 0, drawn: 0 }
/** Agents that already sent a convoy. Kept across layouts, so a rescan does not send them again. */
const seenAgentIds = new Set<string>()
const convoyCursor = new WeakMap<World, number>()
const frameNo = new WeakMap<World, number>()
const lastHeat = new WeakMap<World, Record<string, Heat>>()
const lastAgents = new WeakMap<World, AgentInfo[]>()

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The moving city: cars, signals and people, stepped and drawn every frame. */
function Streets({ layout }: { layout: CityLayout }) {
  const world = useMemo(() => buildWorld(layout), [layout])
  useEffect(() => () => {
    world.layer.dispose()
    world.signals.dispose()
    world.peds.dispose()
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
        if (w.vehicles.count >= CONVOY_SIZE) {
          const cursor = convoyCursor.get(w) ?? 0
          spawnConvoy(w, a, cursor)
          convoyCursor.set(w, (cursor + CONVOY_SIZE) % Math.max(1, Math.min(CONVOY_SLOTS, w.vehicles.count)))
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
      simulate(w, Math.min(delta, MAX_FRAME_STEP))
    }

    // Drawing: vehicles, signals and people for this frame.
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180
    const px = size.height / (2 * Math.tan(fov / 2))
    const drawn = w.layer.update(w.feed, camera.position, px)
    w.signals.write(w.ctx.clock, px)
    w.peds.write(w.ctx.clock, px)
    carStats.total = w.vehicles.count
    carStats.drawn = drawn
  })

  return <primitive object={world.group} />
}

/** Parked cars and their dim glow, the signals frozen at their start phase: the reduced-motion city. */
function StillCity({ layout }: { layout: CityLayout }) {
  const still = useMemo(() => {
    const net = buildLanes(layout)
    const rng = mulberry32(0x9a7)
    const parked = parkedGlow(net, Math.min(900, Math.floor(net.totalLength * 0.5)), rng)
    const signals = new SignalLayer(net)
    signals.write(0, 1000)
    const group = new Group()
    group.name = 'skyline-parked'
    group.add(parked.points, signals.lights.points)
    return { group, parked, signals }
  }, [layout])
  useEffect(() => () => {
    still.parked.dispose()
    still.signals.dispose()
  }, [still])
  useFrame(({ camera, size }) => {
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180
    still.parked.setPx(size.height / (2 * Math.tan(fov / 2)))
  })
  return <primitive object={still.group as Object3D} />
}

/** Traffic streets and the aircraft above the city. With reduced motion only the parked cars and signals remain. */
export function Traffic() {
  const layout = useSky((s) => s.layout)
  const reduced = useSky((s) => s.reducedMotion)
  if (reduced) return layout ? <StillCity layout={layout} /> : null
  return (
    <>
      {layout && <Streets layout={layout} />}
      <Aircraft />
    </>
  )
}

