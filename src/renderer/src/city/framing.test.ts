import { describe, expect, it } from 'vitest'
import { CITY_SIZE } from '../../../shared/layout'
import type { CityLayout } from '../../../shared/types'
import {
  DEFAULT_MAX_HEIGHT,
  framePose,
  maxBuildingHeight,
  projectedExtents,
  viewOffset,
  visibleRegion
} from './framing'

const size = { width: 1440, height: 900 }
const NO_UI = { repo: false, dockCollapsed: false, inspector: false }
const REPO_UI = { repo: true, dockCollapsed: false, inspector: false }

describe('visibleRegion', () => {
  it('uses the whole canvas before a repo is open', () => {
    const r = visibleRegion(size, 'ui', NO_UI)
    expect(r.left).toBeLessThan(40)
    expect(r.right).toBeGreaterThan(size.width - 40)
  })

  it('reserves the dock on the left and the timeline band at the bottom', () => {
    const open = visibleRegion(size, 'ui', REPO_UI)
    const none = visibleRegion(size, 'ui', NO_UI)
    expect(open.left).toBeGreaterThanOrEqual(300)
    expect(open.bottom).toBeLessThanOrEqual(size.height - 132)
    expect(open.left).toBeGreaterThan(none.left)
  })

  it('gives back dock width when the dock is collapsed and takes inspector width when it is open', () => {
    const collapsed = visibleRegion(size, 'ui', { ...REPO_UI, dockCollapsed: true })
    const expanded = visibleRegion(size, 'ui', REPO_UI)
    expect(collapsed.left).toBeLessThan(expanded.left)
    const withInspector = visibleRegion(size, 'ui', { ...REPO_UI, inspector: true })
    expect(withInspector.right).toBeLessThan(expanded.right)
    expect(withInspector.right).toBeLessThanOrEqual(size.width - 352)
  })

  it('falls back to the full canvas in a window too small for the panels', () => {
    const r = visibleRegion({ width: 600, height: 500 }, 'ui', { ...REPO_UI, inspector: true })
    expect(r.left).toBe(16)
    expect(r.right).toBe(584)
  })

  it('leaves room at the bottom of the snapshot for the stats card', () => {
    const r = visibleRegion(size, 'snapshot', NO_UI)
    expect(r.bottom).toBeLessThanOrEqual(size.height - 150)
  })
})

describe('framePose', () => {
  const region = visibleRegion(size, 'ui', REPO_UI)
  const pose = framePose(size, region, 30)

  it('sits at 35 degrees of elevation and 45 degrees of azimuth', () => {
    expect(pose.phi).toBeCloseTo(((90 - 35) * Math.PI) / 180, 10)
    expect(pose.theta).toBeCloseTo(Math.PI / 4, 10)
  })

  it('centres the city box on the view, even though perspective pushes the near side down', () => {
    const e = projectedExtents(size, pose.phi, pose.theta, pose.radius, pose.target, 30)
    expect(Math.abs(e!.cx)).toBeLessThan(1e-3)
    expect(Math.abs(e!.cy)).toBeLessThan(1e-3)
  })

  it('fits the whole city box inside the free region', () => {
    const e = projectedExtents(size, pose.phi, pose.theta, pose.radius, pose.target, 30)
    expect(e).not.toBeNull()
    expect(e!.w).toBeLessThanOrEqual((region.right - region.left) * 0.94 + 1e-6)
    expect(e!.h).toBeLessThanOrEqual((region.bottom - region.top) * 0.94 + 1e-6)
  })

  it('is tight: a noticeably closer camera would overflow', () => {
    const closer = projectedExtents(size, pose.phi, pose.theta, pose.radius * 0.85, pose.target, 30)
    expect(closer === null || closer.w > (region.right - region.left) || closer.h > (region.bottom - region.top)).toBe(true)
  })

  it('backs off for a taller city and for a smaller region', () => {
    const tall = framePose(size, region, 60)
    expect(tall.radius).toBeGreaterThan(pose.radius)
    const small = framePose(size, { left: 200, top: 200, right: 800, bottom: 600 }, 30)
    expect(small.radius).toBeGreaterThan(pose.radius)
  })

  it('keeps a pleasing distance for a real window', () => {
    expect(pose.radius).toBeGreaterThan(120)
    expect(pose.radius).toBeLessThan(420)
  })

})

describe('viewOffset', () => {
  it('is zero when the region is centred on the canvas', () => {
    expect(viewOffset(size, { left: 0, top: 0, right: size.width, bottom: size.height })).toEqual({ x: 0, y: 0 })
  })

  it('moves the orbit target (screen centre) onto the region centre', () => {
    const region = visibleRegion(size, 'ui', REPO_UI)
    const off = viewOffset(size, region)
    // Content at unshifted pixel (W/2, H/2) appears at (W/2 - offset.x, H/2 - offset.y).
    expect(size.width / 2 - off.x).toBeCloseTo((region.left + region.right) / 2, 10)
    expect(size.height / 2 - off.y).toBeCloseTo((region.top + region.bottom) / 2, 10)
  })
})

describe('maxBuildingHeight', () => {
  it('uses the tallest rendered building and falls back for empty layouts', () => {
    const layout: CityLayout = {
      size: CITY_SIZE,
      districts: [],
      buildings: [
        { path: 'a.ts', x: 0, z: 0, w: 2, d: 2, h: 0.6, lang: 'ts', color: '#fff', district: '' },
        { path: 'b.ts', x: 4, z: 0, w: 2, d: 2, h: 10, lang: 'ts', color: '#fff', district: '' }
      ]
    }
    expect(maxBuildingHeight(layout)).toBeGreaterThan(10)
    expect(maxBuildingHeight({ ...layout, buildings: [] })).toBe(DEFAULT_MAX_HEIGHT)
  })
})
