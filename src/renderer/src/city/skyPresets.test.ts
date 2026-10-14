import { describe, expect, it } from 'vitest'
import {
  COLOR_KEYS, LEVEL_KEYS, PRESETS, PresetTransition, TIMES_OF_DAY, blendInto, easeInOut, emptyResolved,
  isTimeOfDay, nextTimeOfDay, resolvePreset
} from './skyPresets'
import { contrastRatio, relativeLuminance } from './palette'

describe('time of day', () => {
  it('cycles blue, night, dawn and back', () => {
    expect(nextTimeOfDay('blue')).toBe('night')
    expect(nextTimeOfDay('night')).toBe('dawn')
    expect(nextTimeOfDay('dawn')).toBe('blue')
  })

  it('accepts only the known presets', () => {
    for (const t of TIMES_OF_DAY) expect(isTimeOfDay(t)).toBe(true)
    expect(isTimeOfDay('noon')).toBe(false)
    expect(isTimeOfDay(null)).toBe(false)
  })
})

describe('preset data', () => {
  it('every preset sets every colour and level', () => {
    for (const t of TIMES_OF_DAY) {
      for (const k of COLOR_KEYS) expect(PRESETS[t].colors[k]).toMatch(/^#[0-9a-f]{6}$/i)
      for (const k of LEVEL_KEYS) expect(Number.isFinite(PRESETS[t].levels[k])).toBe(true)
    }
  })

  it('the blue hour horizon is warm and the zenith is deep blue (after the NYC reference)', () => {
    const p = PRESETS.blue.colors
    const [r, , b] = resolvePreset(PRESETS.blue).colors.horizon
    expect(r).toBeGreaterThan(b)
    expect(resolvePreset(PRESETS.blue).colors.zenith[2]).toBeGreaterThan(resolvePreset(PRESETS.blue).colors.zenith[0])
    expect(p.zenith).toBe('#0b1636')
  })

  it('night is much darker than blue hour overhead, with the horizon band still lit', () => {
    expect(relativeLuminance(PRESETS.night.colors.zenith)).toBeLessThan(relativeLuminance(PRESETS.blue.colors.zenith) / 2)
    expect(contrastRatio(PRESETS.night.colors.horizon, PRESETS.night.colors.zenith)).toBeGreaterThan(3)
  })

  it('stars and the moon are sparse at night', () => {
    expect(PRESETS.night.levels.star).toBeLessThan(PRESETS.blue.levels.star)
    expect(PRESETS.night.levels.moon).toBeLessThanOrEqual(PRESETS.blue.levels.moon)
  })
})

describe('preset interpolation', () => {
  it('ease in and out is 0 at the start, 1 at the end and monotone', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(-3)).toBe(0)
    expect(easeInOut(4)).toBe(1)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const v = easeInOut(i / 20)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('blendInto gives the endpoints at t = 0 and t = 1, and the midpoint in between', () => {
    const a = resolvePreset(PRESETS.blue)
    const b = resolvePreset(PRESETS.night)
    const out = emptyResolved()
    blendInto(out, a, b, 0)
    expect(out.colors.horizon).toEqual(a.colors.horizon)
    expect(out.levels.band).toBeCloseTo(a.levels.band)
    blendInto(out, a, b, 1)
    expect(out.colors.horizon[0]).toBeCloseTo(b.colors.horizon[0], 9)
    expect(out.levels.keyI).toBeCloseTo(b.levels.keyI, 9)
    blendInto(out, a, b, 0.5)
    expect(out.colors.zenith[2]).toBeCloseTo((a.colors.zenith[2] + b.colors.zenith[2]) / 2, 9)
    expect(out.levels.hemi).toBeCloseTo((a.levels.hemi + b.levels.hemi) / 2, 9)
  })

  it('blendInto clamps t outside 0..1', () => {
    const a = resolvePreset(PRESETS.blue)
    const b = resolvePreset(PRESETS.dawn)
    const out = emptyResolved()
    blendInto(out, a, b, 3)
    expect(out.levels.keyI).toBeCloseTo(b.levels.keyI, 9)
    blendInto(out, a, b, -3)
    expect(out.levels.keyI).toBeCloseTo(a.levels.keyI, 9)
  })
})

describe('PresetTransition', () => {
  it('starts on the initial preset and settles on a target after about two seconds', () => {
    const tr = new PresetTransition('blue')
    expect(tr.current.levels.star).toBeCloseTo(PRESETS.blue.levels.star, 9)
    tr.setTarget('night', true)
    expect(tr.step(0.5)).toBe(true)
    expect(tr.current.levels.keyI).toBeLessThan(PRESETS.blue.levels.keyI)
    expect(tr.current.levels.keyI).toBeGreaterThan(PRESETS.night.levels.keyI)
    for (let i = 0; i < 40; i++) tr.step(0.05)
    expect(tr.step(0.05)).toBe(false)
    expect(tr.current.levels.keyI).toBeCloseTo(PRESETS.night.levels.keyI, 9)
  })

  it('takes about 2 s: halfway through at 1 s (steps are capped at 0.1 s, so 10 steps)', () => {
    const tr = new PresetTransition('blue', 2)
    tr.setTarget('dawn', true)
    for (let i = 0; i < 10; i++) tr.step(0.1)
    expect(tr.current.levels.hemi).toBeCloseTo((PRESETS.blue.levels.hemi + PRESETS.dawn.levels.hemi) / 2, 6)
  })

  it('lands in one frame without animation (reduced motion)', () => {
    const tr = new PresetTransition('blue')
    tr.setTarget('night', false)
    expect(tr.step(0.016)).toBe(true)
    expect(tr.current.levels.keyI).toBeCloseTo(PRESETS.night.levels.keyI, 9)
    expect(tr.step(0.016)).toBe(false)
  })

  it('a new target mid-transition starts from where the sky is now', () => {
    const tr = new PresetTransition('blue', 2)
    tr.setTarget('night', true)
    for (let i = 0; i < 10; i++) tr.step(0.1)
    const mid = tr.current.levels.keyI
    tr.setTarget('dawn', true)
    tr.step(0.0001)
    expect(tr.current.levels.keyI).toBeCloseTo(mid, 3)
  })

  it('ignores a target equal to the current one', () => {
    const tr = new PresetTransition('night')
    tr.setTarget('night', true)
    expect(tr.step(0.5)).toBe(false)
  })
})
