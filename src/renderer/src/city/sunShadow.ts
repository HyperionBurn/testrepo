// The region the sun's shadow map covers: the repo district plus a margin, so every shadow cast by the district (and by
// towers just outside it, at low sun) lands in the map. Pure data and maths, so it is tested without a GL context.
// Units are world units (1 unit = 10 m, y up), like the layout.
import { CITY_SIZE } from '../../../shared/layout'
import type { CityLayout } from '../../../shared/types'

/** Margin added on every side of the district, in world units (60 units = 600 m). */
export const SHADOW_MARGIN = 60
/** Headroom above the tallest building, in world units. */
const TOP_HEADROOM = 10

export interface ShadowBox {
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * The box to fit the shadow camera to: the layout square (or the widest building, whichever is larger) plus the margin,
 * from the ground up to the tallest building plus headroom. The building x and z may be a centre or a corner, so both
 * are covered.
 */
export function layoutBounds(layout: CityLayout | null, margin = SHADOW_MARGIN): ShadowBox {
  let half = (layout?.size ?? CITY_SIZE) / 2
  let top = 0
  for (const b of layout?.buildings ?? []) {
    half = Math.max(half, Math.abs(b.x), Math.abs(b.x) + b.w, Math.abs(b.z), Math.abs(b.z) + b.d)
    top = Math.max(top, b.h)
  }
  const r = half + margin
  return { min: [-r, 0, -r], max: [r, top + TOP_HEADROOM, r] }
}

/** The eight corners of a box, in order (min corner first). */
export function boxCorners(box: ShadowBox): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) out.push([x, y, z])
    }
  }
  return out
}
