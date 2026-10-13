import { describe, expect, it } from 'vitest'
import { labelHeightFor, LABEL_MAX_COUNT, LABEL_MIN_HEIGHT, placeLabels, type LabelCandidate } from './labelLayout'

function plate(key: string, x: number, z: number, w: number, d: number, aspect = 6): LabelCandidate {
  return { key, x, z, w, d, aspect }
}

describe('labelHeightFor', () => {
  it('grows with the square root of the area, within bounds', () => {
    expect(labelHeightFor(0)).toBe(1.4)
    expect(labelHeightFor(2500)).toBeGreaterThan(labelHeightFor(900))
    expect(labelHeightFor(1e9)).toBe(8)
  })
})

describe('placeLabels', () => {
  it('centres a label on its plate and sizes it by the plate area', () => {
    const [l] = placeLabels([plate('src/main', 10, 20, 40, 30)])
    expect(l).toBeDefined()
    expect(l?.cx).toBe(30)
    expect(l?.cz).toBe(35)
    expect(l?.h).toBeCloseTo(labelHeightFor(1200))
    expect(l?.w).toBeCloseTo((l?.h ?? 0) * 6)
  })

  it('skips a plate too small for a legible label', () => {
    expect(placeLabels([plate('tiny', 0, 0, 1.2, 1.2)])).toEqual([])
  })

  it('shrinks a name to fit a narrow plate', () => {
    const [l] = placeLabels([plate('src/main', 0, 0, 12, 60, 6)])
    expect(l).toBeDefined()
    expect(l?.w ?? 0).toBeLessThanOrEqual(0.8 * 12 + 1e-9)
    expect(l?.h ?? 0).toBeCloseTo(1.6)
  })

  it('skips a name that would have to shrink below the minimum height', () => {
    expect(placeLabels([plate('a/very/long/name', 0, 0, 12, 60, 14)])).toEqual([])
  })

  it('keeps the larger of two overlapping labels', () => {
    const big = plate('big', 0, 0, 60, 60)
    const small = plate('small', 17, 16, 30, 30) // its label, centred at (32, 31), sits on the big one's
    const placed = placeLabels([small, big])
    expect(placed.map((p) => p.key)).toEqual(['big'])
  })

  it('places non-overlapping labels side by side', () => {
    const placed = placeLabels([plate('a', 0, 0, 40, 40), plate('b', 60, 0, 40, 40)])
    expect(placed.map((p) => p.key).sort()).toEqual(['a', 'b'])
  })

  it('skips a parent whose plate contains other neighborhoods', () => {
    const placed = placeLabels([plate('src', 0, 0, 80, 80), plate('src/main', 0, 0, 40, 80), plate('src/renderer', 40, 0, 40, 80)])
    expect(placed.map((p) => p.key)).not.toContain('src')
  })

  it('caps the number of labels', () => {
    const many = Array.from({ length: 80 }, (_, i) => plate(`n${i}`, (i % 10) * 40, Math.floor(i / 10) * 40, 30, 30))
    expect(placeLabels(many).length).toBeLessThanOrEqual(LABEL_MAX_COUNT)
  })
})
