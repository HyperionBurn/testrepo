// Visual geometry shared by the city's components. The layout's heights are compressed (log scale),
// so the city stretches them here: big files become towers and small ones stay low.
//
// Every consumer (buildings, drones, cages, spotlight, arcs, camera framing) goes through visHeight and
// visCenter, so they agree on one height per building. Two limits keep big repos readable:
//  - slenderness: a building is at most MAX_SLENDERNESS times its narrower footprint side (plus BASE_H),
//    so a thin file stays a pillar instead of a needle;
//  - stretch: the global stretch falls off with sqrt(count) above STRETCH_REF_COUNT buildings.
import type { CityBuilding, CityLayout } from '@shared/types'

const MAX_VISUAL_H = 60
const BASE_H = 0.6
/** Largest height-to-narrow-side ratio, before the base is added back. */
export const MAX_SLENDERNESS = 7
/**
 * Building count up to which the height stretch is full (1). Above it the stretch is sqrt(REF / count), so a
 * 20k-file repo stays a dense, low-rise city with a few towers instead of a field of needles.
 */
export const STRETCH_REF_COUNT = 3000

/** Global height stretch for a city of `count` buildings: 1 up to STRETCH_REF_COUNT, then sqrt-falling. */
export function heightStretch(count: number): number {
  if (!(count > STRETCH_REF_COUNT)) return 1
  return Math.sqrt(STRETCH_REF_COUNT / count)
}

/**
 * Rendered height of one building: the log-scale layout height stretched by `stretch`, capped by the footprint
 * (slenderness). Pure. Monotonic in h for a fixed footprint and stretch.
 */
export function towerHeight(h: number, w: number, d: number, stretch: number): number {
  const k = Math.max(0, h - BASE_H)
  const natural = Math.min(MAX_VISUAL_H, BASE_H + 2.4 * Math.pow(k, 1.15))
  const stretched = BASE_H + stretch * (natural - BASE_H)
  const cap = BASE_H + MAX_SLENDERNESS * Math.min(w, d)
  return Math.min(stretched, cap)
}

/** Rendered height of a building in the city it belongs to. */
export function visHeight(b: CityBuilding, layout: CityLayout): number {
  return towerHeight(b.h, b.w, b.d, heightStretch(layout.buildings.length))
}

/** Footprint center and vertical midpoint of the rendered building. */
export function visCenter(b: CityBuilding, layout: CityLayout): { x: number; y: number; z: number } {
  return { x: b.x + b.w / 2, y: visHeight(b, layout) / 2, z: b.z + b.d / 2 }
}
