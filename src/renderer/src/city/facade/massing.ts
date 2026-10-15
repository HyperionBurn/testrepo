// Massing helpers for the photographic facades (City v4 / I1). Pure: no three.js, so the rules are testable.
//
// The photo material reads aFacadeUV in metres (x along the wall, y up from grade). Massing instances are unit boxes
// scaled by their footprint and height, so the metres come from the instance scale in the vertex shader: one template
// serves every building, and a wall's texture is never stretched by its size. METRES_PER_UNIT is the world frame (1 unit =
// 10 m, see docs/REAL_NYC.md).
import { FACADE_SETS, type FacadeSet } from './photo/sets'

export const METRES_PER_UNIT = 10

/**
 * Metres along the wall and up from grade for one vertex of a unit massing, scaled by the instance size (world units).
 * pos: unit-space position (x and z in [-0.5, 0.5], y in [0, 1]); normal: object-space normal; size: instance scale.
 * Walls facing +-x run along z; all others run along x. Roofs get their plane position (unused by the walls).
 * Tiers of one building share the footprint's corners, so their windows line up with the walls below.
 */
export function massingUv(pos: readonly [number, number, number], normal: readonly [number, number, number], size: readonly [number, number, number]): [number, number] {
  const mx = (pos[0] + 0.5) * size[0] * METRES_PER_UNIT
  const my = pos[1] * size[1] * METRES_PER_UNIT
  const mz = (pos[2] + 0.5) * size[2] * METRES_PER_UNIT
  return Math.abs(normal[0]) > 0.5 ? [mz, my] : [mx, my]
}

/**
 * The GLSL that replaces `vFUV = aFacadeUV;` in the photo material's vertex stage (the instance scale and object-space
 * position give the metres). Needs `instanceMatrix`, `position` and `normal`, all in scope there.
 */
export const MASSING_UV_GLSL = /* glsl */ `
{
  vec3 mS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)) * ${METRES_PER_UNIT.toFixed(1)};
  vec3 mP = vec3((position.x + 0.5) * mS.x, position.y * mS.y, (position.z + 0.5) * mS.z);
  vFUV = abs(normal.x) > 0.5 ? vec2(mP.z, mP.y) : vec2(mP.x, mP.y);
}`

/** Index of a facade set by its id (the atlas cell index), or -1. */
export function facadeSetIndex(id: string): number {
  return FACADE_SETS.findIndex((s) => s.id === id)
}

/** Facade set ids a height tier draws from. Repeats weight a set. */
export interface FacadeTiers {
  /** Heights (world units) below this use the low tier: brick, stone, grid. */
  low: number
  /** Heights below this use the mid tier; the rest are towers (night offices and glass). */
  mid: number
}

/** The repo city's tiers: most of its files are 1.6 to 5.5 units, its spires up to 22. */
export const REPO_TIERS: FacadeTiers = { low: 3, mid: 5.2 }
/** The metropolis: 3 to 22 units for most lots, cores much taller. */
export const METRO_TIERS: FacadeTiers = { low: 6, mid: 14 }

const LOW_SETS = ['brick-018', 'brick-020', 'stone-019', 'grid-015', 'grid-012', 'night-016']
const MID_SETS = ['brick-018', 'brick-020', 'stone-019', 'grid-013', 'grid-014', 'glass-006', 'night-016']
const TOWER_SETS = ['glass-001', 'glass-006', 'night-007', 'night-008', 'night-009', 'night-011', 'night-007', 'night-009']

/**
 * Facade set (index into FACADE_SETS) for a building of height h (world units), from a hash in [0, 1). Towers take the
 * dark office photographs with lit windows most of the time; mid-rise takes brick and stone; low-rise the plain grids.
 */
export function facadeSetFor(h: number, hash: number, tiers: FacadeTiers = REPO_TIERS): number {
  const pool = h < tiers.low ? LOW_SETS : h < tiers.mid ? MID_SETS : TOWER_SETS
  const id = pool[Math.min(pool.length - 1, Math.floor(hash * pool.length))]!
  const i = facadeSetIndex(id)
  if (i < 0) throw new Error(`facade set ${id} missing`)
  return i
}

/**
 * Lit share of the windows (0..1) of a building: office sets are brighter than brick and glass. The hash spreads
 * buildings across the range, so neighbours differ.
 */
export function litFor(set: FacadeSet, hash: number): number {
  const [lo, hi] = set.tone === 'office-night' ? [0.32, 0.72] : set.tone === 'glass' ? [0.16, 0.42] : [0.1, 0.34]
  return lo + (hi - lo) * hash
}
