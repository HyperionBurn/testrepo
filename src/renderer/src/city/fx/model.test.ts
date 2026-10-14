import { describe, expect, it } from 'vitest'
import {
  DISMANTLE_S, LINGER_S, MAX_POPUPS, MAX_SITES, bankTarget, burstCount, canAdmitSite, classifyCommand,
  formatCost, formatTokens, formationOffset, headingOf, makeRng, newSite, perimeterAt, perimeterLength,
  pickPopupSlot, popupText, sinkOf, stepSite, tokenTotal, touchSite, trailOn, unitHash
} from './model'

describe('construction site lifecycle', () => {
  it('stays active for the linger window after an edit', () => {
    const s0 = newSite(100)
    expect(stepSite(s0, 100 + LINGER_S - 0.1).stage).toBe('active')
    expect(sinkOf(s0, 100 + LINGER_S - 0.1)).toBe(0)
  })

  it('dismantles after the linger, then is gone after the sink', () => {
    const s0 = newSite(100)
    const dis = stepSite(s0, 100 + LINGER_S + 0.5)
    expect(dis.stage).toBe('dismantle')
    expect(dis.dismantleAt).toBe(100 + LINGER_S)
    expect(sinkOf(dis, 100 + LINGER_S + 0.5)).toBeGreaterThan(0)
    expect(sinkOf(dis, 100 + LINGER_S + 0.5)).toBeLessThan(1)
    expect(stepSite(s0, 100 + LINGER_S + DISMANTLE_S + 0.01).stage).toBe('gone')
  })

  it('a jump past the whole lifecycle lands on gone in one step', () => {
    expect(stepSite(newSite(0), 1000).stage).toBe('gone')
  })

  it('an edit during the sink brings the site back to active', () => {
    const dis = stepSite(newSite(0), LINGER_S + 1)
    const back = touchSite(dis, LINGER_S + 1.5)
    expect(back.stage).toBe('active')
    expect(stepSite(back, LINGER_S + 1.5 + 1).stage).toBe('active')
  })

  it('caps concurrent sites', () => {
    expect(canAdmitSite(MAX_SITES - 1)).toBe(true)
    expect(canAdmitSite(MAX_SITES)).toBe(false)
  })
})

describe('perimeter placement', () => {
  it('keeps every point on the inset rectangle', () => {
    const out = { x: 0, z: 0, yaw: 0 }
    const w = 3, d = 2, m = 0.5
    const P = perimeterLength(w, d, m)
    for (let i = 0; i <= 40; i++) {
      perimeterAt(w, d, m, (P * i) / 40, out)
      const onX = Math.abs(out.x - -m) < 1e-9 || Math.abs(out.x - (w + m)) < 1e-9
      const onZ = Math.abs(out.z - -m) < 1e-9 || Math.abs(out.z - (d + m)) < 1e-9
      expect(onX || onZ).toBe(true)
      expect(out.x).toBeGreaterThanOrEqual(-m - 1e-9)
      expect(out.x).toBeLessThanOrEqual(w + m + 1e-9)
    }
  })

  it('wraps arc length', () => {
    const a = { x: 0, z: 0, yaw: 0 }
    const b = { x: 0, z: 0, yaw: 0 }
    const P = perimeterLength(2, 2, 0.4)
    perimeterAt(2, 2, 0.4, 1.3, a)
    perimeterAt(2, 2, 0.4, 1.3 + P, b)
    expect(b.x).toBeCloseTo(a.x)
    expect(b.z).toBeCloseTo(a.z)
  })
})

describe('formation', () => {
  it('spreads n escorts evenly around the parent at a bounded radius', () => {
    const out = { x: 0, y: 0, z: 0 }
    const n = 4
    const radii: number[] = []
    for (let k = 0; k < n; k++) {
      formationOffset(k, n, 0, 0, out)
      radii.push(Math.hypot(out.x, out.z))
      expect(out.y).toBeGreaterThan(0.5)
      expect(out.y).toBeLessThan(2.5)
    }
    for (const r of radii) expect(r).toBeCloseTo(radii[0] ?? 0, 6)
    // Adjacent escorts are a quarter turn apart for n=4.
    formationOffset(0, n, 0, 0, out)
    const a0 = Math.atan2(out.z, out.x)
    formationOffset(1, n, 0, 0, out)
    const a1 = Math.atan2(out.z, out.x)
    expect(Math.abs(((a1 - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI / 2)).toBeLessThan(1e-6)
  })

  it('handles a lone escort without dividing by zero', () => {
    const out = { x: 0, y: 0, z: 0 }
    formationOffset(0, 0, 1, 0.5, out)
    expect(Number.isFinite(out.x) && Number.isFinite(out.z)).toBe(true)
  })
})

describe('formatting', () => {
  it('formats cost with precision that matches its size', () => {
    expect(formatCost(0.03)).toBe('$0.03')
    expect(formatCost(0.0042)).toBe('$0.004')
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(NaN)).toBe('$0.00')
  })

  it('formats tokens with k and M suffixes', () => {
    expect(formatTokens(12400)).toBe('12.4k tok')
    expect(formatTokens(950)).toBe('950 tok')
    expect(formatTokens(2_500_000)).toBe('2.5M tok')
  })

  it('popup text carries a plus sign', () => {
    expect(popupText('cost', 0.03)).toBe('+$0.03')
    expect(popupText('tok', 1200)).toBe('+1.2k tok')
  })

  it('counts new tokens without cache reads', () => {
    expect(tokenTotal({ input: 1000, output: 200, cacheRead: 99999, cacheWrite: 300 })).toBe(1500)
  })
})

describe('command classification', () => {
  it('detects commits and pushes', () => {
    expect(classifyCommand('git commit -m "x"').kind).toBe('commit')
    expect(classifyCommand('git push origin main').kind).toBe('commit')
  })

  it('detects tests and reads a known result', () => {
    expect(classifyCommand('npx vitest run')).toEqual({ kind: 'test', result: 'unknown' })
    expect(classifyCommand('pytest -q  12 passed').result).toBe('pass')
    expect(classifyCommand('jest: 2 failed').result).toBe('fail')
  })

  it('leaves other commands alone', () => {
    expect(classifyCommand('ls -la').kind).toBe('other')
    expect(classifyCommand(undefined).kind).toBe('other')
  })
})

describe('bursts and popups', () => {
  it('scales particle counts with lines added within bounds', () => {
    expect(burstCount(0)).toBe(10)
    expect(burstCount(16)).toBeGreaterThan(burstCount(4))
    expect(burstCount(100000)).toBe(60)
  })

  it('reuses free popup slots, then recycles the oldest, never exceeding the pool', () => {
    const slots = Array.from({ length: MAX_POPUPS }, () => ({ active: false, age: 0 }))
    expect(pickPopupSlot(slots)).toBe(0)
    slots.forEach((s, i) => {
      s.active = true
      s.age = i * 0.1
    })
    expect(pickPopupSlot(slots)).toBe(MAX_POPUPS - 1)
    slots[0]!.age = 9
    expect(pickPopupSlot(slots)).toBe(0)
    slots[0]!.age = 0.0
    slots[5]!.age = 9
    expect(pickPopupSlot(slots)).toBe(5)
  })
})

describe('ship motion helpers', () => {
  it('points the nose along the velocity', () => {
    expect(headingOf(0, -1)).toBeCloseTo(0)
    expect(headingOf(1, 0)).toBeCloseTo(-Math.PI / 2)
  })

  it('banks into a turn and caps the roll', () => {
    expect(bankTarget(0)).toBe(0)
    expect(bankTarget(1)).toBeLessThan(0)
    expect(bankTarget(100)).toBe(-0.6)
  })

  it('trails only near the target, with hysteresis', () => {
    expect(trailOn(20, false)).toBe(false)
    expect(trailOn(5, false)).toBe(true)
    expect(trailOn(20, true)).toBe(true)
    expect(trailOn(30, true)).toBe(false)
  })

  it('is deterministic per id and seed', () => {
    expect(unitHash('a', 1)).toBe(unitHash('a', 1))
    expect(unitHash('a', 1)).not.toBe(unitHash('b', 1))
    const r1 = makeRng(7)
    const r2 = makeRng(7)
    expect(r1()).toBe(r2())
  })
})
