// The 'real' style's height field, pure (no three.js, no assets). Heights follow New York's distribution:
//  - most files are mid-rise, from MID_MIN to MID_MAX world units, rising with their LOC percentile;
//  - the top SUPER_SHARE of files by LOC are supertall spires, above MID_MAX;
//  - a low-frequency 2D noise over the layout (clusterAt) lifts or lowers whole neighbourhoods together, so
//    "downtown" rises as a block instead of a random sprinkle;
//  - the slenderness cap keeps a thin file a pillar, and the floor keeps a tiny file a small building.
// geom.visHeight is the one caller that turns this into the rendered height, so every consumer agrees on the top.

export const MID_MIN = 0.9
export const MID_MAX = 3.2
/** LOC percentile where the supertalls start: the top 1.5 % of files. */
export const SUPER_PCT = 0.985
/** Slenderness: height above the base is at most this many times the narrower footprint side. */
export const MAX_SLENDER = 7
const BASE = 0.6
/** Largest spire, world units: about four times the mid-rise top, as the tallest of New York's towers stand over its roofs. */
export const SPIRE_MAX = 12

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Integer lattice hash in [0, 1). */
export function lattice(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth 2D value noise in [0, 1]. Deterministic. */
export function valueNoise2(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = lattice(ix, iz)
  const b = lattice(ix + 1, iz)
  const c = lattice(ix, iz + 1)
  const d = lattice(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

/** Cluster field over the layout, in [0, 1]: two octaves over ~14 and ~5 world units. */
export function clusterAt(x: number, z: number): number {
  const big = valueNoise2(x / 14 + 17.3, z / 14 - 4.1)
  const small = valueNoise2(x / 5 + 3.7, z / 5 + 9.2)
  return clamp01(0.7 * big + 0.3 * small)
}

/**
 * Rendered height of one file in the 'real' style.
 * pct: its LOC percentile in [0, 1). cluster: clusterAt at its position. w, d: footprint, world units.
 */
export function realHeight(pct: number, cluster: number, w: number, d: number): number {
  const p = clamp01(pct)
  let h: number
  if (p < SUPER_PCT) {
    const t = p / SUPER_PCT
    const base = MID_MIN + (MID_MAX - MID_MIN) * t * t * (0.6 + 0.4 * t)
    h = Math.min(MID_MAX, Math.max(MID_MIN, base * (0.82 + 0.36 * cluster)))
  } else {
    const t = (p - SUPER_PCT) / (1 - SUPER_PCT)
    h = MID_MAX + (SPIRE_MAX - MID_MAX) * Math.pow(clamp01(t), 0.8) * (0.8 + 0.4 * cluster)
    h = Math.min(SPIRE_MAX, h)
  }
  const cap = Math.max(MID_MIN, BASE + MAX_SLENDER * Math.min(Math.max(w, 0), Math.max(d, 0)))
  return Math.min(h, cap)
}

/** Sorted heights of a layout, for percentile lookups. Built once per layout (see geom.ts). */
export class HeightRank {
  private readonly sorted: Float64Array

  constructor(values: ArrayLike<number>) {
    this.sorted = Float64Array.from(values).sort()
  }

  get size(): number {
    return this.sorted.length
  }

  /**
   * Rank of v among the values, in [0, 1]: the share strictly below it, over the n - 1 gaps, so the tallest value in any
   * layout is 1 (the landmark) and the shortest is 0. A single value is 0.
   */
  percentile(v: number): number {
    const n = this.sorted.length
    if (n <= 1) return 0
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.sorted[mid]! < v) lo = mid + 1
      else hi = mid
    }
    return Math.min(1, lo / (n - 1))
  }
}
