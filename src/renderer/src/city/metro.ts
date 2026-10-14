// Metropolis plan: the pure geometry of the city that runs out beyond the repo city's square. No three.js in here,
// so the whole plan is deterministic and testable under vitest. The repo name seeds it; the rivers and bridges are
// fixed geography shared with Water, Bridges and Boats.
//
// Layout: a Manhattan-style grid. Avenues run along a v axis rotated GRID_ANGLE from the repo's z axis; cross streets
// run along the perpendicular u axis. Each block is cut into parcels on both frontages. A parcel holds one to four
// buildings (near the plate), some turned a quarter turn, some set back behind a dark alley, a few left vacant. Each
// building takes one of six massings, its own lit share of windows, one of four dark wall palettes and a pitch. Parks
// are the blocks where a noise field runs high: green-dark ground with a few lamps. Light lines (avenues and streets)
// run to the edge of the repo square, so they carry on from the repo's own streets.

/**
 * Angle between the avenues and the repo city's z axis. Zero: the metropolis grid runs on the same axes as the repo
 * city's streets, so an avenue visibly carries on from the repo's own roads. Rotating a box by +GRID_ANGLE lines it up.
 */
export const GRID_ANGLE = 0
const CA = Math.cos(GRID_ANGLE)
const SA = Math.sin(GRID_ANGLE)
/** Unit direction of the u axis (across the avenues, along the cross streets) in the (x, z) plane. */
export const U_X = CA
export const U_Z = -SA
/** Unit direction of the v axis (along the avenues). Perpendicular to u. */
export const V_X = SA
export const V_Z = CA

export const METRO_RADIUS = 1800
export const AVENUE_PITCH = 72
export const AVENUE_WIDTH = 5
export const STREET_PITCH = 22
export const STREET_WIDTH = 3
export const LOT_DEPTH = 9.5
/** Clear ground between the repo square and the first building: the metropolis hugs the plate. */
export const EXCLUSION_MARGIN = 7
export const RIVER_INNER = 250
export const RIVER_OUTER = 700
/** Upper bound for the instanced boxes of one metropolis. */
export const MAX_LOTS = 80000
/** Length of one light-line segment along an avenue or street. */
export const LIGHT_SEG = 36
/** Radial bands (centre distance from the origin). The near band gets the richest massings and spires. */
export const NEAR_RADIUS = 250
export const MID_RADIUS = 700
export const FAR_RADIUS = 1150
/** Facade window grid, in world units: floors of 0.16 (as the repo city) and panes of 0.12 to 0.2 across. */
export const FLOOR_H = 0.16
export const PANE_PITCH_MIN = 0.12
export const PANE_PITCH_MAX = 0.2

export interface Span { x0: number; x1: number; z0: number; z1: number }

export interface RiverBand { side: 'west' | 'east'; x0: number; x1: number }
export const RIVERS: readonly RiverBand[] = [
  { side: 'west', x0: -RIVER_OUTER, x1: -RIVER_INNER },
  { side: 'east', x0: RIVER_INNER, x1: RIVER_OUTER }
]

export interface BridgeSpec {
  id: string
  /** Deck centre line (constant z), from x0 (far bank) to x1 (island). */
  deckZ: number
  x0: number
  x1: number
  /** Tower x positions. The towers stand on piers in the river. */
  towers: readonly [number, number]
  deckY: number
  towerH: number
  /** Half width of the deck. */
  halfW: number
}
/**
 * Two Brooklyn-style suspension bridges. Their deck lines sit 380 to 230 units south of the origin, so the nearest
 * towers stand 450 to 700 units from the framed default view: a landmark on the skyline, not a wall beside the camera.
 */
export const BRIDGES: readonly BridgeSpec[] = [
  { id: 'west', deckZ: -230, x0: -840, x1: -200, towers: [-300, -650], deckY: 26, towerH: 118, halfW: 7 },
  { id: 'east', deckZ: -380, x0: 200, x1: 840, towers: [300, 650], deckY: 26, towerH: 118, halfW: 7 }
]

/** Keep-out corridor of a bridge in world units: the whole deck plus a margin. */
export function bridgeSpan(b: BridgeSpec): Span {
  return { x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1), z0: b.deckZ - b.halfW - 4, z1: b.deckZ + b.halfW + 4 }
}

export function overlaps(a: Span, b: Span): boolean {
  return a.x1 > b.x0 && a.x0 < b.x1 && a.z1 > b.z0 && a.z0 < b.z1
}

/** True when the x range [x0, x1] meets a river. */
export function touchesRiver(x0: number, x1: number): boolean {
  for (const r of RIVERS) if (x1 > r.x0 && x0 < r.x1) return true
  return false
}

// ---- Seeded noise ----------------------------------------------------------------------------------------

/** FNV-1a of the repo name: each repo gets its own skyline. */
export function hashName(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Integer hash to [0, 1). Order independent: the same (a, b, c, seed) always gives the same value. */
export function hash3(a: number, b: number, c: number, seed: number): number {
  let h = seed ^ Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash3(xi, yi, 0, seed)
  const b = hash3(xi + 1, yi, 0, seed)
  const c = hash3(xi, yi + 1, 0, seed)
  const d = hash3(xi + 1, yi + 1, 0, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Three octaves of value noise, roughly in [0, 1]. */
export function fbm2(x: number, y: number, seed: number): number {
  return noise2(x, y, seed) * 0.57 + noise2(x * 2.03, y * 2.03, seed + 11) * 0.29 + noise2(x * 4.1, y * 4.1, seed + 23) * 0.14
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// ---- Downtown cores and heights --------------------------------------------------------------------------

export interface Core { x: number; z: number; r: number; strength: number }

/** 6 to 8 downtown cores with gaussian radius 70 to 130 units, on the island and across the rivers, seeded per repo. */
export function metroCores(seed: number): Core[] {
  const n = 6 + Math.floor(hash3(0, 0, 0, seed) * 3)
  const out: Core[] = []
  for (let k = 0; k < n; k++) {
    const bank = k % 4 === 3
    const x = bank
      ? (hash3(k, 5, 0, seed) < 0.5 ? -1 : 1) * (850 + hash3(k, 6, 0, seed) * 200)
      : (hash3(k, 1, 0, seed) * 2 - 1) * 150
    let z = (hash3(k, 2, 0, seed) * 2 - 1) * 950
    if (Math.hypot(x, z) < 320) z = (z < 0 ? -1 : 1) * 340
    out.push({ x, z, r: 70 + 60 * hash3(k, 4, 0, seed), strength: bank ? 0.8 : 1 })
  }
  return out
}

export interface LotHeight { h: number; spire: boolean; needle: boolean }

/**
 * Height in world units (repo mid-rise is 1.6 to 5.5, its spires 22). Far lots: M = 3 to 6 (per lot), scaled by
 * (1 + Bcore), where Bcore = core mask * (1.2 to 3.0). Cores are gaussian blobs thresholded so about 15 to 20 % of the
 * metropolis is core. About 1 % of core lots are slender needles of 20 to 32 units. The outer belt halves. Each lot
 * varies by +-25 %, so neighbours often differ.
 */
export function lotHeight(x: number, z: number, cores: readonly Core[], seed: number, rnd: number): LotHeight {
  let sum = 0
  for (const c of cores) {
    const d2 = (x - c.x) * (x - c.x) + (z - c.z) * (z - c.z)
    sum += c.strength * Math.exp(-d2 / (2 * c.r * c.r))
  }
  const mask = smooth(0.15, 0.6, sum)
  const r = Math.hypot(x, z)
  // Distance-dependent scale: far towers look as small as near ones, so the repo spire stays the hero.
  const dScale = 1 + 3.5 * smooth(250, 1100, r)
  const n2 = hash3(Math.round(x * 4), Math.round(z * 4), 13, seed)
  const M = 3 + 3 * rnd
  let h = M * (1 + mask * (1.2 + 1.8 * n2) * dScale)
  const needle = mask > 0.3 && hash3(Math.round(x * 4), Math.round(z * 4), 11, seed) < 0.01
  if (needle) h = (12 + 10 * hash3(Math.round(x * 4), Math.round(z * 4), 17, seed)) * dScale
  if (r > 1500) h *= 0.5
  h *= 0.75 + 0.5 * hash3(Math.round(x * 4), Math.round(z * 4), 19, seed)
  return { h: Math.max(1.6, Math.min(h, 400)), spire: needle, needle }
}

/** Height cap next to the repo plate: 6 units at the edge, 12 by 160 units out, then the cores may rise again. */
export function nearCap(gap: number): number {
  return 6 + 6 * smooth(10, 160, gap) + 90 * smooth(160, 420, gap)
}

// ---- The plan --------------------------------------------------------------------------------------------

/** Building massings, in unit space: x and z in -0.5..0.5, y in 0..1 (scaled by the lot's footprint and height). */
export type Massing = 'slab' | 'setback' | 'podium' | 'ell' | 'crown' | 'spire'
export type Band = 'near' | 'mid' | 'far' | 'edge'
/** Triangles per instance of each massing (for the budget). */
export const MASSING_TRIS: Record<Massing, number> = { slab: 12, setback: 24, podium: 24, ell: 24, crown: 36, spire: 48 }

export interface LotSet {
  count: number
  /** Base centre (x, 0, z) per lot, 3 floats each. */
  pos: Float32Array
  /** Footprint along the lot's own x, height, footprint along its own z, per lot, 3 floats each. */
  size: Float32Array
  /** Per-lot seed in [0, 1). */
  seed: Float32Array
  /** 1: the lot is turned a quarter turn (its own x runs across the avenues). */
  rot: Uint8Array
  /** Per lot, 4 floats: lit share of windows, window pitch (0..1), wall palette (0..3), kind (0 plain, 1 office, 3 half-lit). */
  style: Float32Array
}

export interface MetroGroup { band: Band; massing: Massing; set: LotSet }

export interface ParkSet {
  count: number
  /** x0, x1, z0, z1 per park. */
  rects: Float32Array
  /** Lamp points x, z, two floats each (ground height is added by the renderer). */
  lights: Float32Array
}

export interface LineSet {
  quads: number
  /** Four ground (x, z) pairs per quad. */
  xz: Float32Array
  /** -1 .. 1 across the line, per vertex. */
  across: Float32Array
  /** 0 at the start of the segment, 1 at the end. */
  along: Float32Array
  /** Brightness per vertex (avenues brighter than cross streets). */
  bright: Float32Array
  seed: Float32Array
  index: Uint32Array
}

export interface MetroPlan {
  seed: number
  cores: Core[]
  /** Building groups, one per (band, massing). Each is one instanced draw. */
  groups: MetroGroup[]
  parks: ParkSet
  lines: LineSet
  /** Total instanced buildings (all bands). */
  boxCount: number
  /** Triangles of all building instances plus the light lines. */
  triangles: number
}

export interface MetroOptions {
  /** Name of the repo: the seed comes from it. */
  name: string
  /** Half the side of the repo city's square (layoutBounds size / 2). */
  half: number
  /** Tallest building of the repo city (kept for callers; the near cap is set by distance to the plate). */
  repoTop?: number
  radius?: number
  maxLots?: number
}

/** Converts a (u, v) grid point to world (x, z). */
function uvToXZ(u: number, v: number): [number, number] {
  return [u * U_X + v * V_X, u * U_Z + v * V_Z]
}

/** World axis-aligned bounds of a w x d footprint centred at (x, z), turned by rot quarter turns on top of the grid. */
export function footprintBox(x: number, z: number, w: number, d: number, rot: number): Span {
  const t = GRID_ANGLE + (rot ? Math.PI / 2 : 0)
  const c = Math.cos(t)
  const s = Math.sin(t)
  const ex = Math.abs((w / 2) * c) + Math.abs((d / 2) * s)
  const ez = Math.abs((w / 2) * s) + Math.abs((d / 2) * c)
  return { x0: x - ex, x1: x + ex, z0: z - ez, z1: z + ez }
}

/** Parks: block centres where a noise field runs high are left open as green ground. */
function isPark(uc: number, vc: number, seed: number): boolean {
  return fbm2(uc / 170, vc / 170, seed ^ 0x3b) > 0.8
}

interface Cand {
  i: number
  j: number
  /** Unique key within the (i, j) block, for hashing. */
  key: number
  x: number
  z: number
  w: number
  d: number
  rot: number
  r: number
  lowRise: boolean
}

/**
 * Walks every parcel of the grid, in order, and reports each building that passes the keep-out test `ok`. Parks go to
 * `park`. Called twice per plan: once to count, once to emit, so the plan never holds more than it keeps.
 */
function visitParcels(R: number, seed: number, ok: (b: Span) => boolean, visit: (c: Cand) => void, park: (b: Span) => void): void {
  const iMin = Math.floor(-R / AVENUE_PITCH) - 1
  const iMax = Math.ceil(R / AVENUE_PITCH) + 1
  const jMin = Math.floor(-R / STREET_PITCH) - 1
  const jMax = Math.ceil(R / STREET_PITCH) + 1
  for (let i = iMin; i < iMax; i++) {
    for (let j = jMin; j < jMax; j++) {
      const u0 = i * AVENUE_PITCH + AVENUE_WIDTH / 2
      const u1 = (i + 1) * AVENUE_PITCH - AVENUE_WIDTH / 2
      const v0 = j * STREET_PITCH + STREET_WIDTH / 2
      const v1 = (j + 1) * STREET_PITCH - STREET_WIDTH / 2
      const [bx, bz] = uvToXZ((u0 + u1) / 2, (v0 + v1) / 2)
      if (Math.hypot(bx, bz) > R + 120) continue
      if (isPark((u0 + u1) / 2, (v0 + v1) / 2, seed)) {
        const corners = [uvToXZ(u0 + 1.5, v0 + 1.5), uvToXZ(u1 - 1.5, v0 + 1.5), uvToXZ(u1 - 1.5, v1 - 1.5), uvToXZ(u0 + 1.5, v1 - 1.5)]
        const pb: Span = {
          x0: Math.min(...corners.map((p) => p[0])), x1: Math.max(...corners.map((p) => p[0])),
          z0: Math.min(...corners.map((p) => p[1])), z1: Math.max(...corners.map((p) => p[1]))
        }
        if (ok(pb)) park(pb)
        continue
      }
      // Short blocks: about a third are cut by a dark alley across the avenue direction.
      const near = Math.hypot(bx, bz) < MID_RADIUS
      const segs: Array<[number, number]> = [[u0, u1]]
      if (hash3(i, j, 0, seed) < 0.35) {
        const ua = u0 + 14 + hash3(i, j, 1, seed) * (u1 - u0 - 28)
        segs.length = 0
        segs.push([u0, ua - 1.5], [ua + 1.5, u1])
      }
      // Low-rise blocks: about one in eight keeps to walk-ups.
      const lowRise = hash3(i, j, 2, seed) < 0.12
      for (let si = 0; si < segs.length; si++) {
        const [sa, sb] = segs[si]!
        for (let row = 0; row < 2; row++) {
          const frontV = row === 0 ? v0 : v1
          const sgn = row === 0 ? 1 : -1
          let u = sa
          for (let k = 0; sb - u > 3.9; k++) {
            const slot = ((row * 64 + k) * 2 + si) * 4
            const us0 = u
            // Near the plate: narrow parcels, fine grain. Beyond the mid band: wider lots, fewer buildings.
            const ws = Math.min((near ? 6 : 9) + (near ? 3.5 : 4) * hash3(i, j, slot, seed), sb - u)
            u += ws
            if (hash3(i, j, slot + 1, seed) < 0.05) continue // a vacant parcel
            const dpt = LOT_DEPTH * (0.9 + 0.1 * hash3(i, j, slot + 2, seed))
            // A turned building runs across the parcel: its depth becomes the footprint along the avenue, so it fits.
            const rotated = near && ws <= LOT_DEPTH && hash3(i, j, slot + 3, seed) < 0.2
            // One to four buildings per parcel, by width (near the plate only).
            const nSub = !near ? 1 : Math.max(1, Math.min(Math.floor(ws / 3), 1 + Math.floor(hash3(i, j, slot + 4, seed) * 4)))
            const wSub = ws / nSub
            for (let sub = 0; sub < nSub; sub++) {
              const uc = us0 + (sub + 0.5) * wSub
              const bw = wSub - 0.3
              const bd = rotated ? Math.min(dpt, ws) : dpt
              const [cx, cz] = rotated ? uvToXZ(uc, frontV + sgn * (ws / 2)) : uvToXZ(uc, frontV + sgn * (bd / 2))
              const rot = rotated ? 1 : 0
              const fb = footprintBox(cx, cz, rot ? ws - 0.3 : bw, bd, rot)
              if (!ok(fb)) continue
              const r = Math.hypot(cx, cz)
              if (r > R) continue
              visit({ i, j, key: slot * 4 + sub, x: cx, z: cz, w: rot ? ws - 0.3 : bw, d: bd, rot, r, lowRise })
            }
          }
        }
      }
    }
  }
}

function bandOf(r: number): Band {
  return r < NEAR_RADIUS ? 'near' : r < MID_RADIUS ? 'mid' : r < FAR_RADIUS ? 'far' : 'edge'
}

function massingFor(band: Band, u: number, needle: boolean): Massing {
  if (band === 'near') {
    if (needle) return 'spire'
    return u < 0.3 ? 'crown' : u < 0.5 ? 'setback' : u < 0.7 ? 'podium' : u < 0.86 ? 'ell' : 'slab'
  }
  if (band === 'mid') return u < 0.3 ? 'slab' : u < 0.55 ? 'setback' : u < 0.8 ? 'podium' : 'ell'
  if (band === 'far') return u < 0.55 ? 'slab' : 'setback'
  return 'slab'
}

const GROUP_ORDER: Array<[Band, Massing]> = [
  ['near', 'crown'], ['near', 'setback'], ['near', 'podium'], ['near', 'ell'], ['near', 'slab'], ['near', 'spire'],
  ['mid', 'slab'], ['mid', 'setback'], ['mid', 'podium'], ['mid', 'ell'],
  ['far', 'slab'], ['far', 'setback'],
  ['edge', 'slab']
]

/** Lit share, pitch, wall palette and kind of one building. Some blocks are dark, a few are bright office towers. */
function styleFor(c: Cand, h: number, seed: number): [number, number, number, number] {
  const a = hash3(c.i, c.j, c.key, seed ^ 0x51)
  const pitch = hash3(c.i, c.j, c.key, seed ^ 0x52)
  const pal = Math.floor(hash3(c.i, c.j, c.key, seed ^ 0x53) * 4)
  const kindU = hash3(c.i, c.j, c.key, seed ^ 0x54)
  let density = 0.12 + 0.5 * a
  if (a < 0.12) density = 0.03
  let kind = 0
  if (h > 14 && kindU < 0.06) {
    kind = 1
    density = 0.8
  } else if (kindU > 0.92) {
    kind = 3
  }
  return [density, pitch, pal, kind]
}

interface Rec { x: number; z: number; w: number; d: number; rot: number; h: number; seed: number; style: [number, number, number, number] }

function toSet(list: readonly Rec[]): LotSet {
  const n = list.length
  const pos = new Float32Array(n * 3)
  const size = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const rot = new Uint8Array(n)
  const style = new Float32Array(n * 4)
  list.forEach((r, q) => {
    pos[q * 3] = r.x
    pos[q * 3 + 2] = r.z
    size[q * 3] = r.w
    size[q * 3 + 1] = r.h
    size[q * 3 + 2] = r.d
    seed[q] = r.seed
    rot[q] = r.rot
    style.set(r.style, q * 4)
  })
  return { count: n, pos, size, seed, rot, style }
}

export function buildMetro(opts: MetroOptions): MetroPlan {
  const seed = hashName(opts.name)
  const R = opts.radius ?? METRO_RADIUS
  const maxLots = opts.maxLots ?? MAX_LOTS
  const half = opts.half
  const E = half + EXCLUSION_MARGIN
  const cores = metroCores(seed)
  const keepOut = BRIDGES.map(bridgeSpan)
  const ok = (b: Span): boolean => {
    if (b.x1 > -E && b.x0 < E && b.z1 > -E && b.z0 < E) return false
    if (touchesRiver(b.x0, b.x1)) return false
    return !keepOut.some((s) => overlaps(s, b))
  }

  // Pass 1: how many buildings the grid offers. Pass 2 keeps a deterministic share that lands under the budget.
  let nearMid = 0
  let far = 0
  visitParcels(R, seed, ok, (c) => { if (c.r < MID_RADIUS) nearMid++; else far++ }, () => {})
  const budget = maxLots * 0.97
  const keepNearMid = Math.min(1, budget / Math.max(1, nearMid))
  const keepFar = Math.min(1, Math.max(0, budget - nearMid) / Math.max(1, far))

  const lists = new Map<string, Rec[]>()
  for (const [b, m] of GROUP_ORDER) lists.set(b + ':' + m, [])
  const parkRects: number[] = []
  const parkLights: number[] = []
  let kept = 0
  visitParcels(R, seed, ok, (c) => {
    if (kept >= maxLots) return
    const keep = c.r < MID_RADIUS ? keepNearMid : keepFar
    if (hash3(c.i, c.j, c.key, seed ^ 0x77) >= keep) return
    const lh = lotHeight(c.x, c.z, cores, seed, hash3(c.i, c.j, c.key, seed ^ 0x13))
    let h = lh.h
    if (c.lowRise) h = Math.min(h, 3 + 3 * hash3(c.i, c.j, c.key, seed ^ 0x21))
    const gap = Math.hypot(Math.max(0, Math.abs(c.x) - half), Math.max(0, Math.abs(c.z) - half))
    h = Math.min(h, nearCap(gap))
    const band = bandOf(c.r)
    const massing = massingFor(band, hash3(c.i, c.j, c.key, seed ^ 0x31), lh.needle)
    const rec: Rec = {
      x: c.x, z: c.z, w: c.w, d: c.d, rot: c.rot, h: Math.max(1.6, h),
      seed: hash3(c.i, c.j, c.key, seed ^ 0x2f), style: styleFor(c, h, seed)
    }
    lists.get(band + ':' + massing)!.push(rec)
    kept++
  }, (pb) => {
    parkRects.push(pb.x0, pb.x1, pb.z0, pb.z1)
    for (let k = 0; k < 4; k++) {
      const a = hash3(Math.round(pb.x0 * 4), Math.round(pb.z0 * 4), k, seed ^ 0x88)
      const b = hash3(Math.round(pb.x0 * 4), Math.round(pb.z0 * 4), k + 9, seed ^ 0x88)
      parkLights.push(pb.x0 + (pb.x1 - pb.x0) * a, pb.z0 + (pb.z1 - pb.z0) * b)
    }
  })

  const groups: MetroGroup[] = []
  let boxCount = 0
  let triangles = 0
  for (const [band, massing] of GROUP_ORDER) {
    const list = lists.get(band + ':' + massing)!
    if (list.length === 0) continue
    const set = toSet(list)
    groups.push({ band, massing, set })
    boxCount += set.count
    triangles += set.count * MASSING_TRIS[massing]
  }
  const lines = buildLines(R, half, seed)
  triangles += lines.quads * 2
  return {
    seed,
    cores,
    groups,
    parks: { count: parkRects.length / 4, rects: new Float32Array(parkRects), lights: new Float32Array(parkLights) },
    lines,
    boxCount,
    triangles
  }
}

/** Splits [lo, hi] into the pieces that the blocked intervals leave free. */
function freePieces(lo: number, hi: number, blocked: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const cut = blocked
    .map(([a, b]): [number, number] => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0])
  const out: Array<[number, number]> = []
  let cur = lo
  for (const [a, b] of cut) {
    if (a > cur) out.push([cur, a])
    cur = Math.max(cur, b)
  }
  if (cur < hi) out.push([cur, hi])
  return out
}

/**
 * Avenue and cross-street light lines as ground quads. Each line runs to the repo square's edge (never into it), stops
 * at the rivers, and is cut into short segments.
 */
function buildLines(R: number, half: number, seed: number): LineSet {
  const xz: number[] = []
  const across: number[] = []
  const along: number[] = []
  const bright: number[] = []
  const seedOut: number[] = []
  const index: number[] = []
  let quads = 0

  const quad = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number, hw: number, b: number, s: number) => {
    const base = quads * 4
    xz.push(ax - nx * hw, az - nz * hw, ax + nx * hw, az + nz * hw, bx + nx * hw, bz + nz * hw, bx - nx * hw, bz - nz * hw)
    across.push(-1, 1, 1, -1)
    along.push(0, 0, 1, 1)
    bright.push(b, b, b, b)
    seedOut.push(s, s, s, s)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    quads++
  }

  /** Avenues: constant u (x), running along v (z). Streets: constant v (z), running along u (x). */
  const emit = (fixed: number, avenue: boolean) => {
    if (Math.abs(fixed) >= R) return
    const reach = Math.sqrt(R * R - fixed * fixed)
    const [nx, nz] = avenue ? [U_X, U_Z] : [V_X, V_Z]
    // Thin, continuous lines (a 2 unit avenue, a 1 unit street), flush with the ground.
    const hw = avenue ? 1.0 : 0.55
    const b = avenue ? 1 : 0.75
    const lineSeed = hash3(Math.round(fixed * 10), avenue ? 1 : 2, 0, seed ^ 0x5eed)
    const blocked: Array<[number, number]> = []
    if (avenue) {
      if (touchesRiver(fixed - 3, fixed + 3)) return
    } else {
      for (const r of RIVERS) blocked.push([r.x0, r.x1])
    }
    if (Math.abs(fixed) < half) blocked.push([-half, half])
    for (const [s0, s1] of freePieces(-reach, reach, blocked)) {
      for (let s = s0; s < s1; s += LIGHT_SEG) {
        const e = Math.min(s + LIGHT_SEG, s1)
        if (e - s < 1) continue
        const [ax, az] = avenue ? uvToXZ(fixed, s) : uvToXZ(s, fixed)
        const [bx, bz] = avenue ? uvToXZ(fixed, e) : uvToXZ(e, fixed)
        quad(ax, az, bx, bz, nx, nz, hw, b, lineSeed)
      }
    }
  }
  for (let i = Math.floor(-R / AVENUE_PITCH) - 1; i <= Math.ceil(R / AVENUE_PITCH) + 1; i++) emit(i * AVENUE_PITCH, true)
  for (let j = Math.floor(-R / STREET_PITCH) - 1; j <= Math.ceil(R / STREET_PITCH) + 1; j++) emit(j * STREET_PITCH, false)

  return {
    quads,
    xz: new Float32Array(xz),
    across: new Float32Array(across),
    along: new Float32Array(along),
    bright: new Float32Array(bright),
    seed: new Float32Array(seedOut),
    index: new Uint32Array(index)
  }
}

/** Haze density for the far city: about a third of the scene fog, so towers fade out over the last ~1000 units. */
export const HAZE_DENSITY = 0.00126
