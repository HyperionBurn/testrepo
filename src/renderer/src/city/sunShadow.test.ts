import { describe, expect, it } from 'vitest'
import { boxCorners, layoutBounds, SHADOW_MARGIN } from './sunShadow'
import type { CityLayout } from '@shared/types'

const layout = (size: number, buildings: CityLayout['buildings'] = []): CityLayout => ({ buildings, districts: [], size })

describe('layoutBounds', () => {
  it('covers the repo district plus the margin on every side', () => {
    const b = layoutBounds(layout(120))
    expect(b.min[0]).toBe(-60 - SHADOW_MARGIN)
    expect(b.max[0]).toBe(60 + SHADOW_MARGIN)
    expect(b.min[2]).toBe(-60 - SHADOW_MARGIN)
    expect(b.max[2]).toBe(60 + SHADOW_MARGIN)
    expect(b.min[1]).toBe(0)
  })

  it('grows to fit a building that reaches past the square', () => {
    const b = layoutBounds(layout(120, [{ path: 'a', x: 70, z: 0, w: 10, d: 10, h: 30, lang: 'ts', color: '#fff', district: '' }]))
    expect(b.max[0]).toBeGreaterThanOrEqual(75 + SHADOW_MARGIN)
  })

  it('goes up to the tallest building plus headroom', () => {
    const b = layoutBounds(layout(120, [{ path: 'a', x: 0, z: 0, w: 4, d: 4, h: 54, lang: 'ts', color: '#fff', district: '' }]))
    expect(b.max[1]).toBeGreaterThanOrEqual(54)
  })

  it('falls back to the default square without a layout', () => {
    expect(layoutBounds(null).max[0]).toBe(60 + SHADOW_MARGIN)
  })
})

describe('boxCorners', () => {
  it('returns the eight corners of the box', () => {
    const c = boxCorners({ min: [0, 0, 0], max: [1, 2, 3] })
    expect(c).toHaveLength(8)
    expect(new Set(c.map((p) => p.join(','))).size).toBe(8)
  })
})
