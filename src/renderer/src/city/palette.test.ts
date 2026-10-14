import { describe, expect, it } from 'vitest'
import * as P from './palette'
import { contrastRatio, hexToRgb, relativeLuminance } from './palette'

describe('palette helpers', () => {
  it('parses hex to sRGB 0..1', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb('#fff')).toEqual([1, 1, 1])
  })

  it('relative luminance runs from black to white', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6)
  })

  it('contrast ratio is symmetric and reaches 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6)
    expect(contrastRatio('#1d3a6b', '#f08a5d')).toBeCloseTo(contrastRatio('#f08a5d', '#1d3a6b'), 9)
  })
})

describe('palette contrast sanity', () => {
  it('lit windows and lamps stand out against the dark walls and the zenith', () => {
    expect(contrastRatio(P.WINDOW_WARM, '#1a1a22')).toBeGreaterThan(4.5)
    expect(contrastRatio(P.SODIUM, P.ZENITH)).toBeGreaterThan(4.5)
    expect(contrastRatio(P.WINDOW_COOL, P.ZENITH)).toBeGreaterThan(4.5)
  })

  it('the horizon is brighter than the zenith in every time of day', () => {
    expect(relativeLuminance(P.HORIZON)).toBeGreaterThan(relativeLuminance(P.ZENITH) * 3)
    expect(relativeLuminance(P.NIGHT_GLOW)).toBeGreaterThan(relativeLuminance(P.NIGHT_ZENITH) * 3)
    expect(relativeLuminance(P.DAWN_PEACH)).toBeGreaterThan(relativeLuminance(P.DAWN_LILAC))
  })

  it('signal red and green are distinguishable from each other', () => {
    expect(contrastRatio(P.SIGNAL_RED, P.SIGNAL_GREEN)).toBeGreaterThan(1.5)
  })

  it('every shared colour is a 6-digit hex', () => {
    for (const v of Object.values(P)) {
      if (typeof v === 'string') expect(v).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
