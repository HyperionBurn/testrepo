import { describe, expect, it } from 'vitest'
import { Color } from 'three'
import { LightingTransition, applyLighting, lerpLighting, lightingUniforms, presetLighting, type TimeOfDay } from './lighting'

const ALL: TimeOfDay[] = ['golden', 'blue', 'night', 'dawn']
const elevationDeg = (y: number) => (Math.asin(Math.min(1, Math.max(-1, y))) * 180) / Math.PI

describe('presetLighting', () => {
  it('golden hour is the low warm sun from the west-south-west, with the sun above the horizon', () => {
    const g = presetLighting('golden')
    expect(g.night).toBe(0)
    expect(elevationDeg(g.sunDir.y)).toBeGreaterThanOrEqual(9)
    expect(elevationDeg(g.sunDir.y)).toBeLessThanOrEqual(12)
    expect(g.sunDir.x).toBeLessThan(0) // west
    expect(g.sunDir.z).toBeGreaterThan(0) // south of west
    expect(Math.abs(g.sunDir.x)).toBeGreaterThan(Math.abs(g.sunDir.z)) // more west than south
    expect(g.sunIntensity).toBeCloseTo(3.2, 5)
    // Warm sun, #ffb36b-ish: red well above blue.
    expect(g.sunColor.r).toBeGreaterThan(g.sunColor.b * 2)
    // Cool sky-blue ambient: blue is the dominant channel of the fill.
    expect(g.ambient.b).toBeGreaterThan(g.ambient.r)
  })

  it('dawn has the sun low in the east, lower and warmer than the day sun', () => {
    const d = presetLighting('dawn')
    expect(d.sunDir.x).toBeGreaterThan(0)
    expect(elevationDeg(d.sunDir.y)).toBeGreaterThan(0)
    expect(elevationDeg(d.sunDir.y)).toBeLessThan(10)
    expect(d.sunColor.r).toBeGreaterThan(d.sunColor.g)
    expect(d.sunColor.g).toBeGreaterThan(d.sunColor.b)
  })

  it('blue hour and night keep the sun below the horizon, so no direct light or shadow', () => {
    for (const t of ['blue', 'night'] as const) {
      const s = presetLighting(t)
      expect(s.sunDir.y).toBeLessThan(0)
      expect(s.sunIntensity).toBe(0)
    }
  })

  it('night follows the documented values: blue 0.65, night 1, dawn 0.3, golden 0', () => {
    expect(presetLighting('golden').night).toBe(0)
    expect(presetLighting('blue').night).toBeCloseTo(0.65, 5)
    expect(presetLighting('night').night).toBe(1)
    expect(presetLighting('dawn').night).toBeCloseTo(0.3, 5)
  })

  it('every preset has a unit sun direction and finite, non-negative intensities', () => {
    for (const t of ALL) {
      const s = presetLighting(t)
      expect(s.sunDir.length()).toBeCloseTo(1, 5)
      expect(Number.isFinite(s.sunIntensity)).toBe(true)
      expect(s.sunIntensity).toBeGreaterThanOrEqual(0)
      expect(s.ambientIntensity).toBeGreaterThanOrEqual(0)
      expect(s.emissiveGain).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns fresh objects, so callers cannot change a preset by mutating it', () => {
    const a = presetLighting('golden')
    a.sunDir.set(0, 0, 0)
    a.sunColor.set(0, 0, 0)
    const b = presetLighting('golden')
    expect(b.sunDir.length()).toBeCloseTo(1, 5)
    expect(b.sunColor.r).toBeGreaterThan(0)
  })

  it('the night mix rises monotonically through the cycle golden, blue, night', () => {
    const n = ['golden', 'blue', 'night'].map((t) => presetLighting(t as TimeOfDay).night)
    for (let i = 1; i < n.length; i++) expect(n[i]).toBeGreaterThanOrEqual(n[i - 1])
  })
})

describe('lerpLighting', () => {
  it('returns the end states at t = 0 and t = 1', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const A = presetLighting(a)
        const B = presetLighting(b)
        const at0 = lerpLighting(A, B, 0)
        const at1 = lerpLighting(A, B, 1)
        expect(at0.night).toBeCloseTo(A.night, 6)
        expect(at0.sunIntensity).toBeCloseTo(A.sunIntensity, 6)
        expect(at0.sunDir.distanceTo(A.sunDir)).toBeLessThan(1e-5)
        expect(at1.night).toBeCloseTo(B.night, 6)
        expect(at1.sunIntensity).toBeCloseTo(B.sunIntensity, 6)
        expect(at1.sunDir.distanceTo(B.sunDir)).toBeLessThan(1e-5)
        expect(at1.ambient.getHex()).toBe(B.ambient.getHex())
      }
    }
  })

  it('interpolates scalars monotonically between the two ends', () => {
    const A = presetLighting('golden')
    const B = presetLighting('night')
    let prevNight = -1
    let prevIntensity = Infinity
    for (let i = 0; i <= 20; i++) {
      const s = lerpLighting(A, B, i / 20)
      expect(s.night).toBeGreaterThanOrEqual(prevNight)
      expect(s.sunIntensity).toBeLessThanOrEqual(prevIntensity)
      prevNight = s.night
      prevIntensity = s.sunIntensity
    }
  })

  it('keeps the sun direction at unit length along the way, even between opposite presets', () => {
    const A = presetLighting('golden') // west
    const B = presetLighting('dawn') // east
    for (let i = 0; i <= 10; i++) {
      expect(lerpLighting(A, B, i / 10).sunDir.length()).toBeCloseTo(1, 5)
    }
  })

  it('the midpoint of two presets is the mean of their night values', () => {
    const m = lerpLighting(presetLighting('golden'), presetLighting('night'), 0.5)
    expect(m.night).toBeCloseTo(0.5, 6)
  })

  it('clamps t outside 0..1', () => {
    const A = presetLighting('golden')
    const B = presetLighting('night')
    expect(lerpLighting(A, B, -2).night).toBeCloseTo(0, 6)
    expect(lerpLighting(A, B, 5).night).toBeCloseTo(1, 6)
  })
})

describe('applyLighting', () => {
  it('writes the shared uniforms, with sun and ambient colours premultiplied by their intensities', () => {
    const g = presetLighting('golden')
    applyLighting(g)
    const u = lightingUniforms
    expect(u.uNight.value).toBe(0)
    expect(u.uEmissiveGain.value).toBeCloseTo(g.emissiveGain, 6)
    expect(u.uSunDir.value.distanceTo(g.sunDir)).toBeLessThan(1e-6)
    expect(u.uSunColor.value.r).toBeCloseTo(g.sunColor.r * g.sunIntensity, 6)
    expect(u.uSunColor.value.g).toBeCloseTo(g.sunColor.g * g.sunIntensity, 6)
    expect(u.uAmbient.value.b).toBeCloseTo(g.ambient.b * g.ambientIntensity, 6)
    expect(u.uSunColor.value).toBeInstanceOf(Color)
  })

  it('keeps the same uniform objects, so materials that hold references see every write', () => {
    const ref = lightingUniforms.uSunDir
    applyLighting(presetLighting('dawn'))
    expect(lightingUniforms.uSunDir).toBe(ref)
    expect(lightingUniforms.uSunDir.value.x).toBeGreaterThan(0)
  })
})

describe('LightingTransition', () => {
  it('starts on the initial preset and holds it', () => {
    const t = new LightingTransition('golden')
    expect(t.step(0.1)).toBe(false)
    expect(t.current.sunIntensity).toBeCloseTo(3.2, 5)
  })

  it('blends over about two seconds and lands on the target', () => {
    const t = new LightingTransition('golden')
    t.setTarget('night', true)
    expect(t.step(0.5)).toBe(true)
    expect(t.current.night).toBeGreaterThan(0)
    expect(t.current.night).toBeLessThan(1)
    let moving = true
    for (let i = 0; i < 100 && moving; i++) moving = t.step(0.05)
    expect(moving).toBe(false)
    expect(t.current.night).toBeCloseTo(1, 5)
    expect(t.current.sunIntensity).toBeCloseTo(0, 5)
  })

  it('moves the night value monotonically through a golden to night change', () => {
    const t = new LightingTransition('golden')
    t.setTarget('night', true)
    let prev = t.current.night
    for (let i = 0; i < 60; i++) {
      t.step(1 / 30)
      expect(t.current.night).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = t.current.night
    }
  })

  it('lands in one step when animation is off (reduced motion)', () => {
    const t = new LightingTransition('golden')
    t.setTarget('dawn', false)
    t.step(0.016)
    expect(t.current.night).toBeCloseTo(presetLighting('dawn').night, 6)
    expect(t.step(0.016)).toBe(false)
  })
})
