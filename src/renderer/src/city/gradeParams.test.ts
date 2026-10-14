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
  bloom: { intensity: 10, threshold: 0, radius: 4 },
  halation: { intensity: 2, threshold: 2, radius: 0 }
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

  it('keeps the grain at or under 3 percent and the aberration at or under 0.0006', () => {
    for (const t of TIMES_OF_DAY) {
      expect(GRADES[t].grain).toBeLessThanOrEqual(0.03)
      expect(GRADES[t].ca).toBeLessThanOrEqual(0.0006)
    }
  })
})

describe('degradation steps', () => {
  const full = GRADES.blue

  it('level 0 is the full grade', () => {
    expect(degradeGrade(full, 0)).toEqual(full)
  })

  it('level 1 drops the halation first and keeps grain and aberration', () => {
    const d = degradeGrade(full, 1)
    expect(d.halation.intensity).toBe(0)
    expect(d.grain).toBe(full.grain)
    expect(d.ca).toBe(full.ca)
    expect(d.bloom.radius).toBe(full.bloom.radius)
  })

  it('level 2 then drops grain and aberration', () => {
    const d = degradeGrade(full, 2)
    expect(d.grain).toBe(0)
    expect(d.ca).toBe(0)
    expect(d.bloom.radius).toBe(full.bloom.radius)
  })

  it('level 3 shrinks the bloom radius last', () => {
    expect(degradeGrade(full, MAX_DEGRADE_LEVEL).bloom.radius).toBeLessThanOrEqual(0.4)
  })

  it('does not mutate the source grade', () => {
    const before = JSON.stringify(full)
    degradeGrade(full, 3)
    expect(JSON.stringify(full)).toBe(before)
  })
})
