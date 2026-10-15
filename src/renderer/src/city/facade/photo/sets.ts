/**
 * Photographic facade sets (City v4 / REAL_NYC T1). The index of a set is its atlas cell index
 * (see textures/facade-layout.json) and the value of the per-vertex `aFacade` attribute.
 *
 * Source: ambientCG (CC0) Facade001-020, 1K JPG. Crops and measurements are produced by
 * scripts/facades/build_atlas.py; tests/layout checks keep the two in step.
 */
export type FacadeTone = 'brick' | 'stone' | 'glass' | 'concrete' | 'office-night'

export interface FacadeSet {
  /** Stable id, matches the layout JSON. */
  id: string
  /** Metres covered by one tile across the wall (bays x bay width). */
  tileWidthM: number
  /** Metres covered by one tile up the wall (floors x 3.5 m). */
  tileHeightM: number
  /** Storeys per tile. */
  floors: number
  /** Window bays per tile across. */
  bays: number
  tone: FacadeTone
}

/** Storey height the tiles are measured against (metres). */
export const FLOOR_HEIGHT_M = 3.5

export const FACADE_SETS: FacadeSet[] = [
  { id: 'brick-018', tileWidthM: 21, tileHeightM: 21, floors: 6, bays: 6, tone: 'brick' },
  { id: 'brick-020', tileWidthM: 21, tileHeightM: 21, floors: 6, bays: 6, tone: 'brick' },
  { id: 'stone-019', tileWidthM: 21, tileHeightM: 21, floors: 6, bays: 6, tone: 'stone' },
  { id: 'glass-001', tileWidthM: 35, tileHeightM: 35, floors: 10, bays: 16, tone: 'glass' },
  { id: 'glass-006', tileWidthM: 28, tileHeightM: 28, floors: 8, bays: 14, tone: 'glass' },
  { id: 'night-007', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'office-night' },
  { id: 'night-008', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'office-night' },
  { id: 'night-009', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'office-night' },
  { id: 'night-011', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'office-night' },
  { id: 'night-016', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'brick' },
  { id: 'grid-012', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'brick' },
  { id: 'grid-013', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'brick' },
  { id: 'grid-014', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'brick' },
  { id: 'grid-015', tileWidthM: 42, tileHeightM: 42, floors: 12, bays: 12, tone: 'concrete' },
]

/** Width of one window bay in metres for a set. */
export function bayWidthM(set: FacadeSet): number {
  return set.tileWidthM / set.bays
}
