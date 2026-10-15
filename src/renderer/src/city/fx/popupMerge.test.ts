import { describe, expect, it } from 'vitest'
import { MAX_VISIBLE_POPUPS, POPUP_LIFE_S, POPUP_MERGE_S, popupAlpha, popupDue, popupLine, popupToRetire } from './model'

describe('popupLine', () => {
  it('merges cost and tokens into one line', () => {
    expect(popupLine(0.0123, 1500)).toBe('+$0.01 · 1.5k tok')
  })

  it('shows only the part that moved', () => {
    expect(popupLine(0, 1500)).toBe('+1.5k tok')
    expect(popupLine(0.05, 10)).toBe('+$0.05')
  })

  it('is empty below the thresholds', () => {
    expect(popupLine(0.0005, 20)).toBe('')
  })
})

describe('popupDue', () => {
  it('waits for the merge window before an agent earns a popup again', () => {
    expect(POPUP_MERGE_S).toBe(2)
    expect(popupDue(1.5, 0, 0.02, 0)).toBe(false)
    expect(popupDue(2, 0, 0.02, 0)).toBe(true)
  })

  it('needs something pending', () => {
    expect(popupDue(5, 0, 0, 0)).toBe(false)
  })
})

describe('merging a burst of spend', () => {
  it('emits one merged popup per window, not one per update', () => {
    // An agent spends a little every 0.25 s for 10 s: cost and tokens accumulate and are emitted per window.
    let lastPop = -10
    let pendCost = 0
    let pendTok = 0
    const lines: string[] = []
    for (let k = 1; k <= 40; k++) {
      const t = k * 0.25
      pendCost += 0.002
      pendTok += 120
      if (popupDue(t, lastPop, pendCost, pendTok)) {
        lines.push(popupLine(pendCost, pendTok))
        pendCost = 0
        pendTok = 0
        lastPop = t
      }
    }
    expect(lines.length).toBe(5) // 10 s / 2 s windows
    for (const l of lines) expect(l).toMatch(/^\+\$0\.0\d+ · \d+(\.\d)?k tok$|^\+\$0\.0\d+ · \d+ tok$/)
  })

  it('never has two popups of one agent alive at the same time', () => {
    expect(POPUP_MERGE_S).toBeGreaterThan(POPUP_LIFE_S)
  })
})

describe('popup cap', () => {
  it('retires the oldest once MAX_VISIBLE_POPUPS are on screen', () => {
    const slots = [
      { active: true, age: 0.2 },
      { active: true, age: 0.9 },
      { active: true, age: 0.5 },
      { active: false, age: 0 }
    ]
    expect(MAX_VISIBLE_POPUPS).toBe(3)
    expect(popupToRetire(slots)).toBe(1)
  })

  it('retires nothing under the cap', () => {
    const slots = [{ active: true, age: 0.2 }, { active: true, age: 0.9 }, { active: false, age: 0 }]
    expect(popupToRetire(slots)).toBe(-1)
  })
})

describe('popupAlpha', () => {
  it('holds full opacity and then fades quickly to nothing', () => {
    expect(popupAlpha(0)).toBe(1)
    expect(popupAlpha(0.6)).toBe(1)
    expect(popupAlpha(0.8)).toBeCloseTo(0.5)
    expect(popupAlpha(1)).toBe(0)
  })
})
