// Visual geometry shared by the city's components. Every consumer (buildings, drones, cages, spotlight, arcs, camera
// framing) goes through visHeight and visCenter, so they agree on one height per building.
//
// The height is the 'real' style's New York distribution (facade/skyline.ts): most files are mid-rise, the top 1.5 % by
// LOC are spires, and a cluster noise lifts whole neighbourhoods together. The layout's own height (log scale) only
// sets each file's rank, so the rank is computed once per layout and cached.
import type { CityBuilding, CityLayout } from '@shared/types'
import { clusterAt, HeightRank, realHeight } from './facade/skyline'

const ranks = new WeakMap<CityLayout, HeightRank>()

function rankOf(layout: CityLayout): HeightRank {
  let r = ranks.get(layout)
  if (!r) {
    r = new HeightRank(layout.buildings.map((b) => b.h))
    ranks.set(layout, r)
  }
  return r
}

/** Rendered height of a building in the city it belongs to, world units. Pure for a given layout. */
export function visHeight(b: CityBuilding, layout: CityLayout): number {
  const pct = rankOf(layout).percentile(b.h)
  return realHeight(pct, clusterAt(b.x + b.w / 2, b.z + b.d / 2), b.w, b.d)
}

/** Footprint center and vertical midpoint of the rendered building. */
export function visCenter(b: CityBuilding, layout: CityLayout): { x: number; y: number; z: number } {
  return { x: b.x + b.w / 2, y: visHeight(b, layout) / 2, z: b.z + b.d / 2 }
}
