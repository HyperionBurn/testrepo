// Traffic network derived from the city layout. Pure: no three.js, no React, no store.
//
// Streets are the gaps between district plates. Each plate's edges are pushed outward by half of its
// street (1.2 for top-level plates, 0.6 nested), so neighbouring plates produce the same centre line
// on their shared street, which is then deduplicated. Everything is computed on a quarter-unit integer
// grid, so the same layout always yields the same network and overlaps match exactly.
//
// Vehicles drive on lanes: a segment plus a direction (+1 from segment.a to segment.b, -1 back).
// Each direction is one lane, offset 0.25 to its own side of the centre line.
import type { CityLayout } from '@shared/types'

/** Lane offset from a segment's centre line, world units. */
export const LANE_OFFSET = 0.25
/** Street centre lines sit this far outside a plate: half of the top-level or nested street. */
const OFFSET_TOP = 1.2
const OFFSET_NESTED = 0.6
/** Integer grid per world unit: 4 means quarter-unit snapping. */
const GRID = 4

export interface Node {
  id: number;
  x: number;
  z: number;
  /** Segments that touch this node (each segment appears once per endpoint it has here). */
  segments: number[];
}

export interface Segment {
  id: number;
  /** Endpoint at the smaller coordinate along the axis (a -> b is the +axis direction). */
  a: number;
  /** Endpoint at the larger coordinate. */
  b: number;
  horizontal: boolean;
  /** Unit direction from a to b. */
  ux: number;
  uz: number;
  length: number;
}

export interface Network {
  segments: Segment[];
  nodes: Node[];
  /** Sum of segment lengths: the length of one lane per direction. */
  totalLength: number;
}

/** Deterministic PRNG in [0, 1). Same seed, same sequence. */
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Interval { lo: number; hi: number }

/** Merges overlapping or touching intervals. Input is sorted in place. */
function mergeIntervals(list: Interval[]): Interval[] {
  list.sort((p, q) => p.lo - q.lo || p.hi - q.hi)
  const out: Interval[] = []
  for (const iv of list) {
    const last = out[out.length - 1]
    if (last && iv.lo <= last.hi) last.hi = Math.max(last.hi, iv.hi)
    else out.push({ lo: iv.lo, hi: iv.hi })
  }
  return out
}

/**
 * Builds the street network from the district plates. Segments are maximal straight runs between
 * junctions: a junction is an endpoint of any street or a crossing with a perpendicular street, so
 * every segment connects to at least one node and collinear neighbours are already merged.
 */
export function buildLanes(layout: Pick<CityLayout, 'districts'>): Network {
  // Raw centre lines, grouped by their fixed coordinate (z for horizontal, x for vertical).
  const hByZ = new Map<number, Interval[]>()
  const vByX = new Map<number, Interval[]>()
  const addH = (z: number, lo: number, hi: number) => {
    const list = hByZ.get(z) ?? []
    list.push({ lo, hi })
    hByZ.set(z, list)
  }
  const addV = (x: number, lo: number, hi: number) => {
    const list = vByX.get(x) ?? []
    list.push({ lo, hi })
    vByX.set(x, list)
  }

  for (const d of layout.districts) {
    const off = d.depth <= 1 ? OFFSET_TOP : OFFSET_NESTED
    const x0 = Math.round((d.x - off) * GRID)
    const x1 = Math.round((d.x + d.w + off) * GRID)
    const z0 = Math.round((d.z - off) * GRID)
    const z1 = Math.round((d.z + d.d + off) * GRID)
    if (x1 <= x0 || z1 <= z0) continue
    addH(z0, x0, x1)
    addH(z1, x0, x1)
    addV(x0, z0, z1)
    addV(x1, z0, z1)
  }

  // Maximal straight streets after deduplication and collinear merging.
  const hs: { z: number; lo: number; hi: number }[] = []
  const vs: { x: number; lo: number; hi: number }[] = []
  for (const z of [...hByZ.keys()].sort((p, q) => p - q)) {
    for (const iv of mergeIntervals(hByZ.get(z) ?? [])) hs.push({ z, lo: iv.lo, hi: iv.hi })
  }
  for (const x of [...vByX.keys()].sort((p, q) => p - q)) {
    for (const iv of mergeIntervals(vByX.get(x) ?? [])) vs.push({ x, lo: iv.lo, hi: iv.hi })
  }

  // Junctions: crossings (a perpendicular street passes through or ends on this one) and endpoints.
  const hSplits: number[][] = hs.map(() => [])
  const vSplits: number[][] = vs.map(() => [])
  const junctions = new Map<string, { x: number; z: number }>()
  const junctionKey = (x: number, z: number) => `${x},${z}`
  const addJunction = (x: number, z: number) => {
    const k = junctionKey(x, z)
    if (!junctions.has(k)) junctions.set(k, { x, z })
  }
  for (const h of hs) {
    addJunction(h.lo, h.z)
    addJunction(h.hi, h.z)
  }
  for (const v of vs) {
    addJunction(v.x, v.lo)
    addJunction(v.x, v.hi)
  }
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]!
    for (let j = 0; j < vs.length; j++) {
      const v = vs[j]!
      if (v.x < h.lo || v.x > h.hi || h.z < v.lo || h.z > v.hi) continue
      hSplits[i]!.push(v.x)
      vSplits[j]!.push(h.z)
      addJunction(v.x, h.z)
    }
  }

  // Nodes in a stable order: by x, then z.
  const sorted = [...junctions.values()].sort((p, q) => p.x - q.x || p.z - q.z)
  const nodes: Node[] = []
  const nodeAt = new Map<string, number>()
  for (const j of sorted) {
    nodeAt.set(junctionKey(j.x, j.z), nodes.length)
    nodes.push({ id: nodes.length, x: j.x / GRID, z: j.z / GRID, segments: [] })
  }

  const segments: Segment[] = []
  let totalLength = 0
  const cut = (horizontal: boolean, fixed: number, lo: number, hi: number, splits: number[]) => {
    const stops = [...new Set([lo, hi, ...splits])].sort((p, q) => p - q)
    for (let k = 0; k + 1 < stops.length; k++) {
      const p = stops[k]!
      const q = stops[k + 1]!
      const na = nodeAt.get(horizontal ? junctionKey(p, fixed) : junctionKey(fixed, p))
      const nb = nodeAt.get(horizontal ? junctionKey(q, fixed) : junctionKey(fixed, q))
      if (na === undefined || nb === undefined || na === nb) continue
      const length = (q - p) / GRID
      const seg: Segment = {
        id: segments.length,
        a: na,
        b: nb,
        horizontal,
        ux: horizontal ? 1 : 0,
        uz: horizontal ? 0 : 1,
        length
      }
      segments.push(seg)
      nodes[na]!.segments.push(seg.id)
      nodes[nb]!.segments.push(seg.id)
      totalLength += length
    }
  }
  hs.forEach((h, i) => cut(true, h.z, h.lo, h.hi, hSplits[i]!))
  vs.forEach((v, j) => cut(false, v.x, v.lo, v.hi, vSplits[j]!))

  return { segments, nodes, totalLength }
}

/** Node nearest to a point on the ground plane. -1 for an empty network. */
export function nearestNode(net: Network, x: number, z: number): number {
  let best = -1
  let bestD = Infinity
  for (const n of net.nodes) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2
    if (d < bestD) {
      bestD = d
      best = n.id
    }
  }
  return best
}

/**
 * Connected component of every node (0-based ids, numbered in node order). Nested streets can form loops
 * that do not meet the main network, so routes only exist within a component.
 */
export function componentOf(net: Network): Int32Array {
  const comp = new Int32Array(net.nodes.length).fill(-1)
  let next = 0
  for (let start = 0; start < net.nodes.length; start++) {
    if (comp[start] >= 0) continue
    comp[start] = next
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      for (const sid of net.nodes[queue[head]!]!.segments) {
        const seg = net.segments[sid]!
        const v = seg.a === queue[head] ? seg.b : seg.a
        if (comp[v] >= 0) continue
        comp[v] = next
        queue.push(v)
      }
    }
    next++
  }
  return comp
}

/**
 * Next-hop table towards `goal`: table[node] is the segment to take from `node` on a shortest path to
 * the goal, or -1 at the goal itself (and for nodes the goal cannot reach).
 */
export function routeTo(net: Network, goal: number): Int32Array {
  const table = new Int32Array(net.nodes.length).fill(-1)
  if (goal < 0 || goal >= net.nodes.length) return table
  const seen = new Uint8Array(net.nodes.length)
  const queue = [goal]
  seen[goal] = 1
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!
    for (const sid of net.nodes[u]!.segments) {
      const seg = net.segments[sid]!
      const v = seg.a === u ? seg.b : seg.a
      if (seen[v]) continue
      seen[v] = 1
      table[v] = sid // from v, this segment leads back towards the goal
      queue.push(v)
    }
  }
  return table
}

export interface VehicleState {
  readonly count: number;
  /** Current segment. */
  seg: Int32Array;
  /** +1 travelling a -> b, -1 travelling b -> a. */
  dir: Int8Array;
  /** Distance travelled along the segment from the lane's start node. */
  t: Float32Array;
  /** Current speed, world units per second. */
  speed: Float32Array;
  /** Speed the vehicle wants on open road. */
  cruise: Float32Array;
  /** Optional next-hop table per vehicle (see routeTo). Null: wander at random. */
  routes: (Int32Array | null)[];
}

/** Random vehicles on random lanes, placed with probability proportional to segment length. */
export function createVehicles(count: number, net: Network, rng: Rng, cruiseMin = 2.6, cruiseMax = 5): VehicleState {
  const n = Math.max(0, Math.min(count, Math.floor(net.totalLength) * 2))
  const v: VehicleState = {
    count: n,
    seg: new Int32Array(n),
    dir: new Int8Array(n),
    t: new Float32Array(n),
    speed: new Float32Array(n),
    cruise: new Float32Array(n),
    routes: new Array<Int32Array | null>(n).fill(null)
  }
  if (net.segments.length === 0) return { ...v, count: 0 }
  // Cumulative lengths for length-weighted choice.
  const cum = new Float64Array(net.segments.length)
  let acc = 0
  net.segments.forEach((s, i) => {
    acc += s.length
    cum[i] = acc
  })
  for (let i = 0; i < n; i++) {
    const r = rng() * acc
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cum[mid]! < r) lo = mid + 1
      else hi = mid
    }
    const s = net.segments[lo]!
    v.seg[i] = lo
    v.dir[i] = rng() < 0.5 ? 1 : -1
    v.t[i] = rng() * s.length
    v.cruise[i] = cruiseMin + rng() * (cruiseMax - cruiseMin)
    v.speed[i] = v.cruise[i]!
  }
  return v
}

/**
 * Advances every vehicle by dt seconds. `drag` (optional, one multiplier per segment, 1 = free flow)
 * slows vehicles on that segment, e.g. near active edit sites. At a node a vehicle follows its route
 * if it has one; otherwise it goes straight 75% of the time when it can, turns otherwise, and never
 * U-turns unless the node is a dead end.
 */
export function stepVehicle(v: VehicleState, dt: number, net: Network, rng: Rng, drag?: Float32Array): void {
  const segs = net.segments
  const ease = Math.min(1, dt * 2.5)
  for (let i = 0; i < v.count; i++) {
    let s = v.seg[i]!
    let d = v.dir[i]!
    let t = v.t[i]!
    const target = v.cruise[i]! * (drag ? drag[s]! : 1)
    const sp = v.speed[i]! + (target - v.speed[i]!) * ease
    v.speed[i] = sp
    let remain = sp * dt
    for (let guard = 0; guard < 64; guard++) {
      const seg = segs[s]!
      if (t + remain < seg.length) {
        t += remain
        break
      }
      remain -= seg.length - t
      const node = d > 0 ? seg.b : seg.a
      const route = v.routes[i]
      let next = -1
      if (route) {
        next = route[node]!
        if (next < 0) v.routes[i] = null // reached the goal: wander from here on
      }
      if (next < 0) next = chooseTurn(net, s, d, node, rng)
      if (next === s) {
        d = -d // dead end: the only way out is back
      } else {
        d = segs[next]!.a === node ? 1 : -1
      }
      s = next
      t = 0
    }
    v.seg[i] = s
    v.dir[i] = d
    v.t[i] = t
  }
}

/** Picks the segment to leave `node`, having arrived on segment `s` travelling in direction `d`. Allocation-free. */
function chooseTurn(net: Network, s: number, d: number, node: number, rng: Rng): number {
  const seg = net.segments[s]!
  const tx = d * seg.ux
  const tz = d * seg.uz
  let straight = -1
  let turns = 0
  const incident = net.nodes[node]!.segments
  for (const c of incident) {
    if (c === s) continue
    const cs = net.segments[c]!
    const sign = cs.a === node ? 1 : -1
    if (sign * cs.ux * tx + sign * cs.uz * tz > 0.5) straight = c
    else turns++
  }
  if (straight >= 0 && (turns === 0 || rng() < 0.75)) return straight
  if (turns > 0) {
    // Uniform pick among the turns: skip `pick` of them, then take the next.
    let pick = Math.min(turns - 1, Math.floor(rng() * turns))
    for (const c of incident) {
      if (c === s) continue
      const cs = net.segments[c]!
      const sign = cs.a === node ? 1 : -1
      if (sign * cs.ux * tx + sign * cs.uz * tz > 0.5) continue
      if (pick === 0) return c
      pick--
    }
  }
  if (straight >= 0) return straight
  return s // dead end: caller reverses
}

/**
 * World position of a lane point, written into out[o..o+2] as (x, y, z). `dir` +1 measures from the
 * segment's a end, -1 from its b end. Allocation-free, so it can run per vehicle per frame.
 */
export function lanePoint(
  net: Network,
  seg: number,
  dir: number,
  t: number,
  out: Float32Array,
  o: number,
  y: number
): void {
  const s = net.segments[seg]!
  const start = net.nodes[dir > 0 ? s.a : s.b]!
  const tx = dir * s.ux
  const tz = dir * s.uz
  // Each direction sits on its own side of the centre line (right-hand traffic).
  out[o] = start.x + tx * t - tz * LANE_OFFSET
  out[o + 1] = y
  out[o + 2] = start.z + tz * t + tx * LANE_OFFSET
}
