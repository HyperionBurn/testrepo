// Metropolis plan: the pure geometry of the city that runs out beyond the repo city's square. No three.js in here,
// so the whole plan is deterministic and testable under vitest. The repo name seeds it; the rivers and bridges are
// fixed geography shared with Water, Bridges and Boats.
//
// Layout: a Manhattan-style grid. Avenues run along a v axis rotated GRID_ANGLE from the repo's z axis; cross streets
// run along the perpendicular u axis. Blocks are long along u and narrow along v, and each holds two rows of lots, one
// on each frontage. Heights come from a few seeded downtown cores (spiky towers) over mid-rise fabric that falls to
// low-rise toward the edge. The rivers, the repo city's square (plus a margin), the bridge corridors and a few parks
// carry no lots.

/** Angle between the avenues and the repo city's z axis. Rotating a box by +GRID_ANGLE about y lines it up to the grid. */
export const GRID_ANGLE = (29 * Math.PI) / 180
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
export const AVENUE_WIDTH = 9
export const STREET_PITCH = 22
export const STREET_WIDTH = 5
export const LOT_DEPTH = 8
export const EXCLUSION_MARGIN = 25
export const RIVER_INNER = 250
export const RIVER_OUTER = 700
/** Upper bound for the instanced boxes of one metropolis. */
export const MAX_LOTS = 60000
/** Length of one light-line segment along an avenue or street. */
export const LIGHT_SEG = 36
/** Radial LOD bands (centre distance from the origin). The near band gets the stepped-tier geometry. */
export const NEAR_RADIUS = 250
export const MID_RADIUS = 700
export const FAR_RADIUS = 1150

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
export const BRIDGES: readonly BridgeSpec[] = [
  { id: 'west', deckZ: -420, x0: -840, x1: -200, towers: [-300, -650], deckY: 26, towerH: 124, halfW: 7 },
  { id: 'east', deckZ: 560, x0: 200, x1: 840, towers: [300, 650], deckY: 26, towerH: 124, halfW: 7 }
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

// ---- Downtown cores and heights --------------------------------------------------------------------------

export interface Core { x: number; z: number; r: number; strength: number }

/** Three seeded downtown cores on the island and two lower clusters across the rivers. */
export function metroCores(seed: number): Core[] {
  const out: Core[] = []
  for (let k = 0; k < 3; k++) {
    const x = (hash3(k, 1, 0, seed) * 2 - 1) * 150
    const z = (hash3(k, 3, 0, seed) < 0.5 ? -1 : 1) * (300 + hash3(k, 2, 0, seed) * 480)
    out.push({ x, z, r: 150 + 60 * hash3(k, 4, 0, seed), strength: 1 })
  }
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1
    out.push({
      x: side * (960 + hash3(k, 5, 0, seed) * 180),
      z: (hash3(k, 6, 0, seed) * 2 - 1) * 700,
      r: 170,
      strength: 0.55
    })
  }
  return out
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Height and spire flag of a lot centred at (x, z). rnd is the lot's own random draw in [0, 1). */
export function lotHeight(x: number, z: number, cores: readonly Core[], seed: number, rnd: number): { h: number; spire: boolean } {
  let coreI = 0
  for (const c of cores) {
    const d2 = (x - c.x) * (x - c.x) + (z - c.z) * (z - c.z)
    coreI += c.strength * Math.exp(-d2 / (c.r * c.r))
  }
  coreI = Math.min(coreI, 1.6)
  const r = Math.hypot(x, z)
  const n = fbm2(x / 150, z / 150, seed ^ 0x51)
  const edge = 1 - 0.78 * smooth(650, 1650, r)
  const mid = (8 + 36 * n * n * 1.2) * edge
  // Cores add the spiky towers: most lots stay mid-rise, a few reach the top of the range.
  let h = mid * (1 - 0.45 * Math.min(coreI, 1)) + coreI * (55 + 210 * Math.pow(rnd, 2.2))
  const spire = coreI > 0.5 && hash3(Math.round(x * 4), Math.round(z * 4), 9, seed) < 0.4
  if (spire) h *= 1.12
  return { h: Math.max(3, h), spire }
}

// ---- The plan --------------------------------------------------------------------------------------------

export interface LotSet {
  count: number
  /** Base centre (x, 0, z) per lot, 3 floats each. */
  pos: Float32Array
  /** Footprint width (along u), height, footprint depth (along v) per lot, 3 floats each. */
  size: Float32Array
  /** Per-lot seed in [0, 1). */
  seed: Float32Array
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
  /** Near-band towers in the stepped-tier geometry, without a spire. */
  tiered: LotSet
  /** Near-band towers that carry a spire. */
  spired: LotSet
  mid: LotSet
  far: LotSet
  edge: LotSet
  lines: LineSet
  /** Total instanced boxes (all bands). */
  boxCount: number
}

export interface MetroOptions {
  /** Name of the repo: the seed comes from it. */
  name: string
  /** Half the side of the repo city's square (layoutBounds size / 2). */
  half: number
  /** Tallest building of the repo city: near the plate the metropolis stays under 40 % of it. */
  repoTop?: number
  radius?: number
  maxLots?: number
}

interface Cand { cu: number; cv: number; w: number; i: number; j: number; k: number }
type Rec = { x: number; z: number; w: number; h: number; seed: number }

function toSet(list: readonly Rec[]): LotSet {
  const n = list.length
  const pos = new Float32Array(n * 3)
  const size = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  list.forEach((r, q) => {
    pos[q * 3] = r.x
    pos[q * 3 + 2] = r.z
    size[q * 3] = r.w
    size[q * 3 + 1] = r.h
    size[q * 3 + 2] = LOT_DEPTH
    seed[q] = r.seed
  })
  return { count: n, pos, size, seed }
}

/** Parks: block centres where a noise field runs high are left open. */
function isPark(uc: number, vc: number, seed: number): boolean {
  return fbm2(uc / 170, vc / 170, seed ^ 0x3b) > 0.84
}

/** Converts a (u, v) grid point to world (x, z). */
function uvToXZ(u: number, v: number): [number, number] {
  return [u * U_X + v * V_X, u * U_Z + v * V_Z]
}

export function buildMetro(opts: MetroOptions): MetroPlan {
  const seed = hashName(opts.name)
  const R = opts.radius ?? METRO_RADIUS
  const maxLots = opts.maxLots ?? MAX_LOTS
  const repoTop = Math.max(10, opts.repoTop ?? 40)
  const E = opts.half + EXCLUSION_MARGIN
  const cores = metroCores(seed)
  const keepOut = BRIDGES.map(bridgeSpan)
  const iMin = Math.floor(-R / AVENUE_PITCH) - 1
  const iMax = Math.ceil(R / AVENUE_PITCH) + 1
  const jMin = Math.floor(-R / STREET_PITCH) - 1
  const jMax = Math.ceil(R / STREET_PITCH) + 1

  // Pass 1: every candidate lot that survives the hard exclusions.
  const cands: Cand[] = []
  for (let i = iMin; i < iMax; i++) {
    for (let j = jMin; j < jMax; j++) {
      const u0 = i * AVENUE_PITCH + AVENUE_WIDTH / 2
      const u1 = (i + 1) * AVENUE_PITCH - AVENUE_WIDTH / 2
      const v0 = j * STREET_PITCH + STREET_WIDTH / 2
      const v1 = (j + 1) * STREET_PITCH - STREET_WIDTH / 2
      const [bx, bz] = uvToXZ((u0 + u1) / 2, (v0 + v1) / 2)
      if (Math.hypot(bx, bz) > R + 120) continue
      if (isPark((u0 + u1) / 2, (v0 + v1) / 2, seed)) continue
      for (let row = 0; row < 2; row++) {
        const va = row === 0 ? v0 : v1 - LOT_DEPTH
        const vb = row === 0 ? v0 + LOT_DEPTH : v1
        const cv = (va + vb) / 2
        let u = u0
        for (let k = 0; u < u1 - 3.9; k++) {
          const w = Math.min(6 + 3.5 * hash3(i, j, row * 97 + k, seed), u1 - u)
          const cu = u + w / 2
          u += w
          // Conservative footprint: the axis-aligned bounds of the lot's four corners.
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
          for (const [px, pz] of [uvToXZ(cu - w / 2, va), uvToXZ(cu + w / 2, va), uvToXZ(cu + w / 2, vb), uvToXZ(cu - w / 2, vb)]) {
            x0 = Math.min(x0, px); x1 = Math.max(x1, px)
            z0 = Math.min(z0, pz); z1 = Math.max(z1, pz)
          }
          if (x1 > -E && x0 < E && z1 > -E && z0 < E) continue
          if (touchesRiver(x0, x1)) continue
          const box: Span = { x0, x1, z0, z1 }
          if (keepOut.some((s) => overlaps(s, box))) continue
          const [cx, cz] = uvToXZ(cu, cv)
          if (Math.hypot(cx, cz) > R) continue
          cands.push({ cu, cv, w, i, j, k: k * 2 + row })
        }
      }
    }
  }

  // Pass 2: keep a deterministic share so the count lands under the budget.
  const keepP = Math.min(1, (maxLots * 0.98) / Math.max(1, cands.length))
  const bands: Record<'tiered' | 'spired' | 'mid' | 'far' | 'edge', Rec[]> = { tiered: [], spired: [], mid: [], far: [], edge: [] }
  let kept = 0
  for (const c of cands) {
    if (kept >= maxLots) break
    if (hash3(c.i, c.j, c.k, seed ^ 0x77) >= keepP) continue
    const [x, z] = uvToXZ(c.cu, c.cv)
    const { h: raw, spire } = lotHeight(x, z, cores, seed, hash3(c.i, c.j, c.k, seed ^ 0x13))
    // Moat: low next to the repo plate, ramping to full downtown height by ~600 units out.
    const gap = Math.hypot(Math.max(0, Math.abs(x) - opts.half), Math.max(0, Math.abs(z) - opts.half))
    const ramp = smooth(150, 600, gap)
    const cap = 0.4 * repoTop + (1e4 - 0.4 * repoTop) * ramp
    const h = Math.min(raw, cap)
    const r = Math.hypot(x, z)
    const rec: Rec = { x, z, w: c.w, h, seed: hash3(c.i, c.j, c.k, seed ^ 0x2f) }
    const band = r < NEAR_RADIUS ? (spire ? 'spired' : 'tiered') : r < MID_RADIUS ? 'mid' : r < FAR_RADIUS ? 'far' : 'edge'
    bands[band].push(rec)
    kept++
  }

  const sets = {
    tiered: toSet(bands.tiered),
    spired: toSet(bands.spired),
    mid: toSet(bands.mid),
    far: toSet(bands.far),
    edge: toSet(bands.edge)
  }
  return {
    seed,
    cores,
    ...sets,
    lines: buildLines(R, E, seed),
    boxCount: sets.tiered.count + sets.spired.count + sets.mid.count + sets.far.count + sets.edge.count
  }
}

/** Avenue and cross-street light lines as ground quads, cut into short segments and kept off rivers and the square. */
function buildLines(R: number, E: number, seed: number): LineSet {
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

  /** One full line: an avenue at constant u (runs along v) or a cross street at constant v (runs along u). */
  const emitLine = (fixed: number, avenue: boolean) => {
    const [nx, nz] = avenue ? [U_X, U_Z] : [V_X, V_Z]
    const hw = avenue ? 2.2 : 1.4
    const b = avenue ? 1 : 0.9
    const lineSeed = hash3(Math.round(fixed * 10), avenue ? 1 : 2, 0, seed ^ 0x5eed)
    for (let s = -R; s < R; s += LIGHT_SEG) {
      const s1 = Math.min(s + LIGHT_SEG, R)
      const mid = (s + s1) / 2
      const [mx, mz] = avenue ? uvToXZ(fixed, mid) : uvToXZ(mid, fixed)
      if (Math.hypot(mx, mz) > R) continue
      if (Math.abs(mx) < E && Math.abs(mz) < E) continue
      if (touchesRiver(mx - 3, mx + 3)) continue
      const [ax, az] = avenue ? uvToXZ(fixed, s) : uvToXZ(s, fixed)
      const [bx, bz] = avenue ? uvToXZ(fixed, s1) : uvToXZ(s1, fixed)
      quad(ax, az, bx, bz, nx, nz, hw, b, lineSeed)
    }
  }
  for (let i = Math.floor(-R / AVENUE_PITCH) - 1; i <= Math.ceil(R / AVENUE_PITCH) + 1; i++) emitLine(i * AVENUE_PITCH, true)
  for (let j = Math.floor(-R / STREET_PITCH) - 1; j <= Math.ceil(R / STREET_PITCH) + 1; j++) emitLine(j * STREET_PITCH, false)

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
