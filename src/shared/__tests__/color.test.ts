import { describe, expect, it } from 'vitest'
import { agentColor, hexToRgb } from '../color'

/** HSL (h in degrees, s and l in 0..1) of a #rrggbb color. */
function hsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex)
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: ((h * 60) + 360) % 360, s, l }
}

describe('hexToRgb', () => {
  it('parses six-digit and three-digit hex, with or without #', () => {
    expect(hexToRgb('#3B82F6')).toEqual({ r: 59, g: 130, b: 246 })
    expect(hexToRgb('3b82f6')).toEqual({ r: 59, g: 130, b: 246 })
    expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('throws on malformed input', () => {
    expect(() => hexToRgb('#12')).toThrow(RangeError)
    expect(() => hexToRgb('#GGGGGG')).toThrow(RangeError)
    expect(() => hexToRgb('')).toThrow(RangeError)
  })
})

describe('agentColor', () => {
  it('returns a lowercase-or-uppercase six-digit hex string', () => {
    expect(agentColor('session-a')).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('is stable for the same id', () => {
    const first = agentColor('a81457-session')
    for (let i = 0; i < 5; i++) expect(agentColor('a81457-session')).toBe(first)
  })

  it('pins known values so the hash cannot drift silently', () => {
    expect(agentColor('claude-1')).toBe('#854bf1')
    expect(agentColor('a81457-session')).toBe('#f55b5b')
    expect(agentColor('codex-7')).toBe('#8147f5')
  })

  it('gives different ids mostly different colors', () => {
    const colors = new Set<string>()
    for (let i = 0; i < 200; i++) colors.add(agentColor(`agent-${i}`))
    expect(colors.size).toBeGreaterThan(150)
  })

  it('produces saturated, luminous colors (no muddy greys)', () => {
    for (let i = 0; i < 300; i++) {
      const c = hsl(agentColor(`id-${i}-${i * 31}`))
      expect(c.s).toBeGreaterThanOrEqual(0.8)
      expect(c.l).toBeGreaterThanOrEqual(0.58)
      expect(c.l).toBeLessThanOrEqual(0.7)
    }
  })

  it('spreads hues across the wheel', () => {
    const buckets = new Set<number>()
    for (let i = 0; i < 100; i++) buckets.add(Math.floor(hsl(agentColor(`spread-${i}`)).h / 30))
    expect(buckets.size).toBeGreaterThanOrEqual(10)
  })
})
