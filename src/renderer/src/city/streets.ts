// Road network planner (pure, no three.js): rasterises the free space between district plates onto a
// grid of street cells, then autotiles every street cell with the Kenney road piece whose openings match
// its neighbours. Output is plain data; Roads.tsx turns it into instanced meshes.
//
// Orientation conventions. Grid: i grows east (+x), j grows south (+z). Sides: N = -z, E = +x, S = +z,
// W = -x. A rotation k is k quarter turns about +y, the same sense as Object3D.rotation.y = k * PI/2.
// Native openings were measured from the GLB geometry (ground-level surface reaching the cell edge, not the
// kerb lines that run along it):
//   road-straight      E W        road-bend   S W        road-end   E
//   road-intersection  S E W      road-crossroad  N E S W
//   light-square / light-curved arm points N (-z), pole sits at the model's bbox-centre offset below.
import type { CityLayout } from '@shared/types'

export type Side = 'N' | 'E' | 'S' | 'W'
export const SIDES: readonly Side[] = ['N', 'E', 'S', 'W']
export const SIDE_BIT: Readonly<Record<Side, number>> = { N: 1, E: 2, S: 4, W: 8 }
const SIDE_VEC: Readonly<Record<Side, readonly [number, number]>> = {
  N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0]
}

/** Road cell size in world units. */
export const ROAD_CELL = 1
/** Coarser cell used when the fine grid would exceed MAX_TILES. */
export const COARSE_CELL = 2
export const MAX_TILES = 6000
/** Lamps every this many world units along straight streets. */
export const LAMP_SPACING = 6
/** Pole distance from the tile centre toward the kerb, in cells. */
export const LAMP_SETBACK = 0.42
/** Road surface height above the ground plane (Ground sits at y = -0.01). */
export const ROAD_Y = 0.02

const EPS = 1e-9
const QUARTER = Math.PI / 2

/** Rotates a grid vector (x, z) by k quarter turns about +y (three.js convention). */
export function rotateVec(x: number, z: number, k: number): [number, number] {
  switch (((k % 4) + 4) % 4) {
    case 0: return [x, z]
    case 1: return [z, -x]
    case 2: return [-x, -z]
    default: return [-z, x]
  }
}

function sideOfVec(x: number, z: number): Side {
  for (const s of SIDES) {
    const [sx, sz] = SIDE_VEC[s]
    if (sx === x && sz === z) return s
  }
  throw new Error(`no side for vector ${x},${z}`)
}

/** The side a side turns into after k quarter turns. */
export function rotateSide(side: Side, k: number): Side {
  const [x, z] = rotateVec(SIDE_VEC[side][0], SIDE_VEC[side][1], k)
  return sideOfVec(x, z)
}

/** An opening mask (bit per side) after k quarter turns. */
export function rotateMask(mask: number, k: number): number {
  let out = 0
  for (const s of SIDES) if (mask & SIDE_BIT[s]) out |= SIDE_BIT[rotateSide(s, k)]
  return out
}

export function openingMask(sides: readonly Side[]): number {
  let m = 0
  for (const s of sides) m |= SIDE_BIT[s]
  return m
}

export type PieceKind = 'straight' | 'bend' | 'end' | 'tee' | 'cross'

/** Native openings of each road model (measured, see the header). */
export const ROAD_PIECES: Readonly<Record<PieceKind, { model: string; open: readonly Side[] }>> = {
  straight: { model: 'road-straight', open: ['E', 'W'] },
  bend: { model: 'road-bend', open: ['S', 'W'] },
  end: { model: 'road-end', open: ['E'] },
  tee: { model: 'road-intersection', open: ['S', 'E', 'W'] },
  cross: { model: 'road-crossroad', open: ['N', 'E', 'S', 'W'] }
}

export interface PieceChoice {
  kind: PieceKind
  model: string
  /** Quarter turns applied to the native model. */
  k: number
  /** Rotation about +y in radians (k * PI/2). */
  rot: number
}

const PIECE_BY_MASK: (PieceChoice | undefined)[] = Array.from({ length: 16 })
for (const kind of Object.keys(ROAD_PIECES) as PieceKind[]) {
  const { model, open } = ROAD_PIECES[kind]
  const m0 = openingMask(open)
  for (let k = 0; k < 4; k++) {
    const m = rotateMask(m0, k)
    if (!PIECE_BY_MASK[m]) PIECE_BY_MASK[m] = { kind, model, k, rot: k * QUARTER }
  }
}

/** The piece and rotation whose openings are exactly `mask` (bit per side). Undefined for 0 (no links). */
export function pieceForMask(mask: number): PieceChoice | undefined {
  return PIECE_BY_MASK[mask & 15]
}

// ---------------------------------------------------------------------------------------------
// Lamps. Both light models have their arm toward -z (N) and their pole offset from the bbox centre.

export interface LampModel {
  /** Pole position in model space (origin = bbox centre, base at y = 0). */
  pole: { x: number; z: number }
  /** Lamp head relative to the pole, in model space. */
  bulb: { x: number; y: number; z: number }
}

export const LAMP_ARM: Side = 'N'
export const LAMP_MODELS: Readonly<Record<'light-square' | 'light-curved', LampModel>> = {
  'light-square': { pole: { x: 0, z: 0.094 }, bulb: { x: 0, y: 0.586, z: -0.099 } },
  'light-curved': { pole: { x: 0, z: 0.0875 }, bulb: { x: 0, y: 0.646, z: -0.08 } }
}

/** Quarter turns that turn the lamp arm (native N) to point toward `side`. */
export function lampTurnFor(side: Side): number {
  for (let k = 0; k < 4; k++) if (rotateSide(LAMP_ARM, k) === side) return k
  return 0
}

/**
 * Where a lamp's model origin and bulb go, given its pole position (world x/z) and rotation (radians).
 * The bulb y is above the road surface base (ROAD_Y is added by the caller to the model origin only).
 */
export function lampTransform(model: keyof typeof LAMP_MODELS, poleX: number, poleZ: number, rot: number): {
  origin: { x: number; z: number }
  bulb: { x: number; y: number; z: number }
} {
  const lm = LAMP_MODELS[model]
  const k = Math.round(rot / QUARTER)
  const [px, pz] = rotateVec(lm.pole.x, lm.pole.z, k)
  const [bx, bz] = rotateVec(lm.bulb.x, lm.bulb.z, k)
  return {
    origin: { x: poleX - px, z: poleZ - pz },
    bulb: { x: poleX + bx, y: lm.bulb.y, z: poleZ + bz }
  }
}

// ---------------------------------------------------------------------------------------------
// Output

export interface RoadTile { model: string; x: number; z: number; rot: number; scale: number }
export interface RoadLight { x: number; z: number; rot: number; model: string }
export interface RoadPlan { tiles: RoadTile[]; lights: RoadLight[] }

interface Grid {
  n: number
  cell: number
  origin: number
  /** 1 = street, row-major (index = j * n + i). */
  street: Uint8Array
}

/** Inclusive index range of cells whose centre lies in [lo, hi] along one axis (may be empty). */
function cellRange(lo: number, hi: number, origin: number, cell: number, n: number): [number, number] {
  const i0 = Math.max(0, Math.ceil((lo - origin) / cell - 0.5 - EPS))
  const i1 = Math.min(n - 1, Math.floor((hi - origin) / cell - 0.5 + EPS))
  return [i0, i1]
}

/** Streets are free space: outside every LEAF plate and every building footprint (plus a small margin). */
const BUILDING_MARGIN = 0.2

function rasterise(layout: CityLayout, cell: number): Grid {
  const n = Math.max(1, Math.round(layout.size / cell))
  const origin = -layout.size / 2
  const blocked = new Uint8Array(n * n)
  const fill = (x0: number, x1: number, z0: number, z1: number) => {
    const [i0, i1] = cellRange(x0, x1, origin, cell, n)
    const [j0, j1] = cellRange(z0, z1, origin, cell, n)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * n + i] = 1
  }

  // A plate is a leaf when no other plate sits inside it. Non-leaf plates are fully covered by their children
  // plus the streets between them, so only leaves block.
  const parents = new Set<string>()
  for (const d of layout.districts) {
    const parts = d.name.split('/')
    for (let k = 1; k < parts.length; k++) parents.add(parts.slice(0, k).join('/'))
  }
  for (const d of layout.districts) {
    if (!parents.has(d.name)) fill(d.x, d.x + d.w, d.z, d.z + d.d)
  }
  for (const b of layout.buildings) {
    fill(b.x - BUILDING_MARGIN, b.x + b.w + BUILDING_MARGIN, b.z - BUILDING_MARGIN, b.z + b.d + BUILDING_MARGIN)
  }

  const street = new Uint8Array(n * n)
  for (let k = 0; k < street.length; k++) street[k] = blocked[k] ? 0 : 1

  // Remove isolated single cells (no street neighbour). Removing one can isolate another, so repeat.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        if (!street[k]) continue
        const has = (ii: number, jj: number) => ii >= 0 && jj >= 0 && ii < n && jj < n && street[jj * n + ii] === 1
        if (!has(i - 1, j) && !has(i + 1, j) && !has(i, j - 1) && !has(i, j + 1)) {
          street[k] = 0
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return { n, cell, origin, street }
}

const LANE_NONE = 0
const LANE_H = 1 // lower row of a 2-wide east-west street: a parallel straight, E-W
const LANE_V = 2 // east column of a 2-wide north-south street: a parallel straight, N-S

/**
 * Autotiles one grid. Wide streets are reduced to a centre line plus parallel lanes: the upper row of an
 * east-west 2-wide street (or the west column of a north-south one) carries the junctions, and the other row
 * is a straight that only links to the centre line. This avoids a T at every cell of a 2-wide street.
 */
function planOnGrid(layout: CityLayout, cell: number): RoadPlan {
  const g = rasterise(layout, cell)
  const { n, street, origin } = g
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && street[j * n + i] === 1

  const lane = new Uint8Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!at(i, j)) continue
      const sN = at(i, j - 1), sS = at(i, j + 1), sE = at(i + 1, j), sW = at(i - 1, j)
      if (sN && !sS && sE && sW) lane[j * n + i] = LANE_H
      else if (sW && !sE && sN && sS) lane[j * n + i] = LANE_V
    }
  }
  const isLane = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && lane[j * n + i] !== LANE_NONE

  const tiles: RoadTile[] = []
  const lights: RoadLight[] = []
  const every = Math.max(1, Math.round(LAMP_SPACING / cell))
  const setback = LAMP_SETBACK * cell

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!at(i, j)) continue
      const x = origin + (i + 0.5) * cell
      const z = origin + (j + 0.5) * cell
      const kind = lane[j * n + i]
      let model: string
      let rot: number
      let horizontal: boolean
      if (kind === LANE_H || kind === LANE_V) {
        model = ROAD_PIECES.straight.model
        horizontal = kind === LANE_H
        rot = horizontal ? 0 : QUARTER
      } else {
        let mask = 0
        for (const s of SIDES) {
          const [di, dj] = SIDE_VEC[s]
          if (at(i + di, j + dj) && !isLane(i + di, j + dj)) mask |= SIDE_BIT[s]
        }
        const piece = pieceForMask(mask)
        if (piece) {
          model = piece.model
          rot = piece.rot
          horizontal = piece.kind === 'straight' && piece.k % 2 === 0
        } else {
          // Only lane neighbours (a 2x2 pocket): run the straight along the street that touches it.
          horizontal = at(i - 1, j) || at(i + 1, j)
          model = ROAD_PIECES.straight.model
          rot = horizontal ? 0 : QUARTER
        }
      }
      tiles.push({ model, x, z, rot, scale: cell })

      const isStraight = model === ROAD_PIECES.straight.model
      if (!isStraight) continue
      // Lamps on straights, on a kerb side that has no street. Alternate sides when both are kerbs.
      const sides: Side[] = horizontal ? ['N', 'S'] : ['E', 'W']
      const blocked = sides.filter((s) => {
        const [di, dj] = SIDE_VEC[s]
        return !at(i + di, j + dj)
      })
      const index = horizontal ? i : j
      if (blocked.length === 0 || index % every !== 0) continue
      const side = blocked[(i + j) % blocked.length] as Side
      const [vx, vz] = SIDE_VEC[side]
      const arm = (Object.keys(SIDE_VEC) as Side[]).find((s) => SIDE_VEC[s][0] === -vx && SIDE_VEC[s][1] === -vz) as Side
      const lampRot = lampTurnFor(arm) * QUARTER
      lights.push({
        x: x + vx * setback,
        z: z + vz * setback,
        rot: lampRot,
        model: (i + j) % 3 === 0 ? 'light-curved' : 'light-square'
      })
    }
  }
  return { tiles, lights }
}

/**
 * The road network for a layout: deterministic, pure. Falls back to a 2-unit grid (scaled tiles) when the
 * fine grid would exceed MAX_TILES.
 */
export function buildRoadPlan(layout: CityLayout): RoadPlan {
  const fine = planOnGrid(layout, ROAD_CELL)
  if (fine.tiles.length <= MAX_TILES) return fine
  return planOnGrid(layout, COARSE_CELL)
}
