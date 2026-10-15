import { describe, expect, it } from 'vitest'
import { GRADES, GRADE_LIMITS, MAX_DEGRADE_LEVEL, clampGrade, degradeGrade, type GradeParams } from './gradeParams'
import { TIMES_OF_DAY } from './skyPresets'

const WILD: GradeParams = {
  lift: [0.9, -1, 0.02],
  shadowTint: [5, 0, 1],
  highTint: [NaN, 1, 2],
  split: 9,
  sat: 4,
  warmSat: -2,
  grain: 0.5,
  ca: 0.01,
  vignette: 3,
  curve: 9,
  bloom: { intensity: 10, threshold: 0, radius: 4 },
  halation: { intensity: 2, threshold: 2, radius: 0 },
  ao: { intensity: 9, radius: 0, falloff: 0 }
}

describe('grade parameter clamps', () => {
  it('keeps every value inside the limits, whatever the input', () => {
    const c = clampGrade(WILD)
    expect(c.lift[0]).toBeLessThanOrEqual(GRADE_LIMITS.lift[1])
    expect(c.lift[1]).toBeGreaterThanOrEqual(0)
    expect(c.shadowTint[0]).toBeLessThanOrEqual(1.3)
    expect(c.shadowTint[1]).toBeGreaterThanOrEqual(0.7)
    expect(c.highTint[0]).toBeGreaterThanOrEqual(0.7) // NaN falls back to the lower bound
    expect(c.split).toBeLessThanOrEqual(0.2)
    expect(c.sat).toBeLessThanOrEqual(1.3)
    expect(c.warmSat).toBeGreaterThanOrEqual(0)
    expect(c.grain).toBeLessThanOrEqual(0.03)
    expect(c.ca).toBeLessThanOrEqual(0.0006)
    expect(c.vignette).toBeLessThanOrEqual(0.8)
    expect(c.bloom.intensity).toBeLessThanOrEqual(1.6)
    expect(c.bloom.threshold).toBeGreaterThanOrEqual(0.6)
    expect(c.bloom.radius).toBeLessThanOrEqual(1)
    expect(c.halation.intensity).toBeLessThanOrEqual(0.6)
    expect(c.halation.threshold).toBeGreaterThanOrEqual(0.3)
    expect(c.halation.radius).toBeGreaterThanOrEqual(0.6)
    expect(c.curve).toBeLessThanOrEqual(0.6)
    expect(c.ao.intensity).toBeLessThanOrEqual(3)
    expect(c.ao.radius).toBeGreaterThanOrEqual(1)
    expect(c.ao.falloff).toBeGreaterThanOrEqual(0.2)
  })

  it('does not change the input', () => {
    const copy = JSON.stringify(WILD)
    clampGrade(WILD)
    expect(JSON.stringify(WILD)).toBe(copy)
  })

  it('every time-of-day grade is already inside the limits', () => {
    for (const t of TIMES_OF_DAY) expect(clampGrade(GRADES[t])).toEqual(GRADES[t])
  })

  it('never crushes the blacks: lift is above zero for every preset', () => {
    for (const t of TIMES_OF_DAY) {
      for (const v of GRADES[t].lift) expect(v).toBeGreaterThan(0)
    }
  })

  it('is photographic: no aberration, faint grain, bloom only above a high threshold', () => {
    for (const t of TIMES_OF_DAY) {
      expect(GRADES[t].ca).toBe(0)
      expect(GRADES[t].grain).toBeLessThanOrEqual(0.01)
      expect(GRADES[t].bloom.threshold).toBeGreaterThanOrEqual(0.8)
      expect(GRADES[t].halation.intensity).toBeLessThanOrEqual(0.2)
    }
  })

  it('ambient occlusion is on for every preset, at a city-scale radius', () => {
    for (const t of TIMES_OF_DAY) {
      expect(GRADES[t].ao.intensity).toBeGreaterThan(0)
      expect(GRADES[t].ao.radius).toBeGreaterThanOrEqual(2)
      expect(GRADES[t].ao.radius).toBeLessThanOrEqual(4)
    }
  })
})

describe('degradation steps', () => {
  const full = GRADES.blue

  it('level 0 is the full grade', () => {
    expect(degradeGrade(full, 0)).toEqual(full)
  })

  it('level 1 drops the ambient occlusion first and keeps the rest', () => {
    const d = degradeGrade(full, 1)
    expect(d.ao.intensity).toBe(0)
    expect(d.halation.intensity).toBe(full.halation.intensity)
    expect(d.grain).toBe(full.grain)
    expect(d.bloom.radius).toBe(full.bloom.radius)
  })

  it('level 2 then drops the halation', () => {
    const d = degradeGrade(full, 2)
    expect(d.ao.intensity).toBe(0)
    expect(d.halation.intensity).toBe(0)
    expect(d.grain).toBe(full.grain)
  })

  it('level 3 drops the grain, and level 4 shrinks the bloom radius last', () => {
    const d3 = degradeGrade(full, 3)
    expect(d3.grain).toBe(0)
    expect(d3.bloom.radius).toBe(full.bloom.radius)
    expect(degradeGrade(full, MAX_DEGRADE_LEVEL).bloom.radius).toBeLessThanOrEqual(0.4)
  })

  it('does not mutate the source grade', () => {
    const before = JSON.stringify(full)
    degradeGrade(full, 4)
    expect(JSON.stringify(full)).toBe(before)
  })
})
