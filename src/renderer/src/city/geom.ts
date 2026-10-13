// Visual geometry shared by the city's components. The layout's heights are compressed (log scale),
// so the city stretches them here: big files become towers and small ones stay low.
import type { CityBuilding } from '@shared/types'

const MAX_VISUAL_H = 60

/** Rendered height for a layout height. Monotonic; 0.6 (the smallest layout height) maps to 0.6. */
export function towerHeight(h: number): number {
  const k = Math.max(0, h - 0.6)
  return Math.min(MAX_VISUAL_H, 0.6 + 2.4 * Math.pow(k, 1.15))
}

/** Rendered height of a building. */
export function visHeight(b: CityBuilding): number {
  return towerHeight(b.h)
}

/** Footprint center and vertical midpoint of the rendered building. */
export function visCenter(b: CityBuilding): { x: number; y: number; z: number } {
  return { x: b.x + b.w / 2, y: visHeight(b) / 2, z: b.z + b.d / 2 }
}
