// Camera framing: where the camera sits so the whole city, with margin, fits the part of the window the HUD
// leaves free. Pure math on plain numbers (no three.js objects), so it is unit-tested without a GL context.
// The camera looks at the framed target; the view offset then moves that target to the centre of the free region.
import { CITY_SIZE } from '../../../shared/layout'
import type { CityLayout } from '../../../shared/types'
import { visHeight } from './geom'

/** Elevation and azimuth of the framed three-quarter view, in degrees. */
export const FRAME_ELEVATION_DEG = 35
export const FRAME_AZIMUTH_DEG = 45
/** Must match the field of view of the city camera (CityCanvas). */
export const CAMERA_FOV_DEG = 36
/** Height used before a layout exists (Welcome screen): a typical mid-sized city. */
export const DEFAULT_MAX_HEIGHT = 24
/** Share of the free region the city may fill. The rest is breathing room. */
const FILL = 0.94
const RADIUS_MIN = 20
const RADIUS_MAX = 2000

// HUD geometry, in CSS px. Keep in step with hud.css (.titlebar, .dock, .inspector, .timeline-wrap).
const TITLEBAR_H = 44
const DOCK_LEFT = 12
const DOCK_W = 300
const DOCK_W_COLLAPSED = 60
const INSPECTOR_RIGHT = 12
const INSPECTOR_W = 340
const BAND_H = 132
const GAP = 16

export interface ViewSize { width: number; height: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Vec3 { x: number; y: number; z: number }
export interface FramePose { radius: number; phi: number; theta: number; target: Vec3 }
/** 'ui' is the normal window; 'snapshot' leaves room for the stats card; 'flyover' is the bare canvas. */
export type FrameMode = 'ui' | 'snapshot' | 'flyover'

export interface UiState { repo: boolean; dockCollapsed: boolean; inspector: boolean }

/** The part of the canvas the city may occupy in this mode. */
export function visibleRegion(size: ViewSize, mode: FrameMode, ui: UiState): Rect {
  const w = size.width
  const h = size.height
  if (mode === 'flyover') return { left: 40, top: 40, right: w - 40, bottom: h - 40 }
  if (mode === 'snapshot') return { left: 48, top: 48, right: w - 48, bottom: h - Math.max(150, h * 0.2) }

  const left = (ui.repo ? DOCK_LEFT + (ui.dockCollapsed ? DOCK_W_COLLAPSED : DOCK_W) : 0) + GAP
  const right = w - ((ui.inspector ? INSPECTOR_RIGHT + INSPECTOR_W : 0) + GAP)
  const top = TITLEBAR_H + GAP
  const bottom = h - ((ui.repo ? BAND_H : 0) + GAP)
  // A window too small for the reserved panels falls back to the whole canvas rather than a sliver.
  if (right - left < 200 || bottom - top < 200) return { left: GAP, top: GAP, right: w - GAP, bottom: h - GAP }
  return { left, top, right, bottom }
}

/** Shift of the view so the orbit target (the screen centre, unshifted) lands on the centre of the region. */
export function viewOffset(size: ViewSize, region: Rect): { x: number; y: number } {
  return {
    x: size.width / 2 - (region.left + region.right) / 2,
    y: size.height / 2 - (region.top + region.bottom) / 2
  }
}

const towerCache = new WeakMap<CityLayout, number>()

/** Tallest rendered building (world units). The framing box stands this high. */
export function maxBuildingHeight(layout: CityLayout): number {
  const cached = towerCache.get(layout)
  if (cached !== undefined) return cached
  let max = 0
  for (const b of layout.buildings) max = Math.max(max, visHeight(b))
  const value = max > 0 ? max : DEFAULT_MAX_HEIGHT
  towerCache.set(layout, value)
  return value
}

interface Extents { w: number; h: number; cx: number; cy: number }
type V3 = [number, number, number]

/** View basis of an orbit camera: forward (towards the target), right and up. */
function viewBasis(phi: number, theta: number): { fwd: V3; right: V3; up: V3 } {
  const sp = Math.sin(phi)
  const cp = Math.cos(phi)
  // The camera sits on the orbit, so its direction from the target is (sin phi sin theta, cos phi, sin phi cos theta).
  const fwd: V3 = [-sp * Math.sin(theta), -cp, -sp * Math.cos(theta)]
  const rl = Math.hypot(fwd[2], fwd[0]) || 1
  const right: V3 = [-fwd[2] / rl, 0, fwd[0] / rl]
  const up: V3 = [-right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1]]
  return { fwd, right, up }
}

/**
 * Pixel size, and the centre in NDC, of the city box as seen from a camera on the orbit (phi, theta, radius)
 * looking at target. The box spans the city square and stands maxHeight tall. Null when a corner is behind the camera.
 */
export function projectedExtents(size: ViewSize, phi: number, theta: number, radius: number, target: Vec3, maxHeight: number): Extents | null {
  const { fwd, right, up } = viewBasis(phi, theta)
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360)
  const aspect = size.width / Math.max(1, size.height)
  const half = CITY_SIZE / 2

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const x of [-half, half]) {
    for (const y of [0, maxHeight]) {
      for (const z of [-half, half]) {
        const rx = x - target.x
        const ry = y - target.y
        const rz = z - target.z
        const depth = rx * fwd[0] + ry * fwd[1] + rz * fwd[2] + radius
        if (depth <= 0.5) return null
        const xc = rx * right[0] + ry * right[1] + rz * right[2]
        const yc = rx * up[0] + ry * up[1] + rz * up[2]
        const nx = xc / (depth * tanHalf * aspect)
        const ny = yc / (depth * tanHalf)
        minX = Math.min(minX, nx)
        maxX = Math.max(maxX, nx)
        minY = Math.min(minY, ny)
        maxY = Math.max(maxY, ny)
      }
    }
  }
  // NDC spans 2 units across the canvas, so a span of d NDC is d/2 of the canvas size.
  return {
    w: ((maxX - minX) / 2) * size.width,
    h: ((maxY - minY) / 2) * size.height,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  }
}

/**
 * The framed pose: 35 degrees up, 45 degrees around, at the smallest distance where the city box fits the region.
 * The target is the box centre, so the orbit pivots on the middle of the city.
 */
export function framePose(size: ViewSize, region: Rect, maxHeight: number): FramePose {
  const h = Math.max(1, maxHeight)
  const target = { x: 0, y: h / 2, z: 0 }
  const phi = ((90 - FRAME_ELEVATION_DEG) * Math.PI) / 180
  const theta = (FRAME_AZIMUTH_DEG * Math.PI) / 180
  const availW = (region.right - region.left) * FILL
  const availH = (region.bottom - region.top) * FILL
  const fits = (r: number): boolean => {
    const e = projectedExtents(size, phi, theta, r, target, h)
    return e !== null && e.w <= availW && e.h <= availH
  }
  // The projected size falls as the radius grows, so bisect for the smallest radius that still fits.
  let lo = RADIUS_MIN
  let hi = RADIUS_MAX
  if (fits(lo)) {
    hi = lo
  } else {
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) hi = mid
      else lo = mid
    }
  }

  // Perspective pushes the near side of the box down the screen, so the box centre does not project onto the
  // target. Slide the target until the box is centred on the view (the view offset then centres the target).
  const { right, up } = viewBasis(phi, theta)
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360)
  const aspect = size.width / Math.max(1, size.height)
  let t: Vec3 = { ...target }
  for (let i = 0; i < 3; i++) {
    const e = projectedExtents(size, phi, theta, hi, t, h)
    if (!e) break
    // At depth ~radius, an NDC offset of c is a camera-plane offset of c * radius * tan(fov/2) (times aspect in x).
    const ax = e.cx * hi * tanHalf * aspect
    const ay = e.cy * hi * tanHalf
    t = {
      x: t.x + right[0] * ax + up[0] * ay,
      y: t.y + right[1] * ax + up[1] * ay,
      z: t.z + right[2] * ax + up[2] * ay
    }
  }
  return { radius: hi, phi, theta, target: t }
}
