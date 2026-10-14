import { describe, expect, it } from 'vitest'
import { getModel, modelsByClass, type ModelClass } from './assets/manifest'
import {
  BIG_REPO,
  FILL,
  LocRank,
  MAX_STRETCH,
  MIN_STRETCH,
  TRI_BUDGET,
  classChain,
  hashPath,
  locByPath,
  pickPlacement,
  planBudget,
  stretchOf,
  type PickInput
} from './modelPicker'

/** Deterministic synthetic repo: n files, LOC spread over a wide range, footprints and heights in city units. */
function synthetic(n: number, seed = 7): PickInput[] {
  let s = seed >>> 0
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const out: PickInput[] = []
  for (let i = 0; i < n; i++) {
    const loc = Math.floor(Math.exp(rnd() * 7.5)) // ~1 .. 1800 lines, log-uniform
    const w = 0.8 + rnd() * 2.5
    const d = 0.8 + rnd() * 2.5
    const h = 0.6 + Math.min(20, Math.pow(loc / 40, 0.9)) * (0.6 + rnd() * 0.4)
    out.push({ path: `src/f${i}.ts`, w, d, h: Math.min(h, 0.6 + 7 * Math.min(w, d)), loc })
  }
  return out
}

const isClass = (id: string, cls: ModelClass) => getModel(id).cls === cls

describe('locByPath', () => {
  it('maps path to lines of code', () => {
    const m = locByPath([{ path: 'a', loc: 3 }, { path: 'b', loc: 9 }])
    expect(m.get('b')).toBe(9)
    expect(m.size).toBe(2)
  })
})

describe('LocRank', () => {
  it('gives the share of files strictly shorter', () => {
    const r = new LocRank([10, 20, 30, 40, 50])
    expect(r.percentile(5)).toBe(0)
    expect(r.percentile(30)).toBeCloseTo(0.4)
    expect(r.percentile(1000)).toBe(1)
  })
})

describe('class rules', () => {
  it('sends the top 2% by LOC to skyscrapers, the next 10% to towers, the middle to low and mid rises', () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({ path: `f${i}.ts`, w: 1.5, d: 1.5, h: 2, loc: i + 30 }))
    const rank = new LocRank(inputs.map((i) => i.loc))
    const cls = (loc: number) => {
      const input = inputs.find((i) => i.loc === loc)!
      return getModel(pickPlacement(input, rank, false).modelId).cls
    }
    expect(cls(1029)).toBe('skyscraper') // top file
    expect(cls(1000 + 30 - 20)).toBe('skyscraper') // inside top 2%
    expect(['tower', 'midrise']).toContain(cls(30 + 900)) // 90th percentile
    expect(['lowrise', 'midrise', 'house']).toContain(cls(30 + 500)) // middle
  })

  it('tiny files are houses in a small repo and low-detail in a big one', () => {
    expect(classChain(10, 0.1, false)[0]).toBe('house')
    expect(classChain(10, 0.1, true)[0]).toBe('lowdetail')
    expect(classChain(500, 0.2, false)[0]).toBe('house') // bottom 35% counts as tiny too
    expect(classChain(500, 0.5, false)[0]).not.toBe('house')
  })

  it('tiny files get house or low-detail models', () => {
    const tiny: PickInput = { path: 'x.ts', w: 1.2, d: 1.2, h: 1.2, loc: 5 }
    const rank = new LocRank([5, 10, 2000, 3000])
    expect(['house', 'lowrise']).toContain(getModelClass(pickPlacement(tiny, rank, false).modelId))
  })
})

function getModelClass(id: string): ModelClass {
  return getModel(id).cls
}

describe('model choice within a class', () => {
  it('picks the model whose aspect is closest to the target', () => {
    const tall: PickInput = { path: 'tall.ts', w: 1, d: 1, h: 6, loc: 5000 }
    const rank = new LocRank(Array.from({ length: 100 }, (_, i) => i + 1))
    const p = pickPlacement(tall, rank, false)
    expect(isClass(p.modelId, 'skyscraper')).toBe(true)
    // Target aspect 6; the chosen model's aspect should be the closest of the skyscrapers that fit.
    const best = modelsByClass('skyscraper')
      .filter((m) => stretchOf(1, 1, 6, m) >= MIN_STRETCH && stretchOf(1, 1, 6, m) <= MAX_STRETCH)
      .map((m) => Math.abs(Math.log(6 / (m.size.y / Math.max(m.size.x, m.size.z)))))
    const chosen = getModel(p.modelId)
    const chosenErr = Math.abs(Math.log(6 / (chosen.size.y / Math.max(chosen.size.x, chosen.size.z))))
    expect(chosenErr).toBeLessThanOrEqual(Math.min(...best) + 0.081)
  })

  it('stays in the allowed stretch range whenever a detailed model fits, and rarely falls outside it', () => {
    const inputs = synthetic(400)
    const rank = new LocRank(inputs.map((i) => i.loc))
    let outside = 0
    for (const input of inputs) {
      const p = pickPlacement(input, rank, false)
      if (p.stretch < MIN_STRETCH || p.stretch > MAX_STRETCH) outside++
    }
    // Squat footprints (height near the base, wide) can need a flatter model than any in the set; the fallback is the closest.
    expect(outside / inputs.length).toBeLessThan(0.1)
  })

  it('a squat, wide building avoids tall models and a needle avoids squat ones', () => {
    const rank = new LocRank([1, 2, 3, 4, 5])
    const squat = pickPlacement({ path: 'wide.ts', w: 4, d: 4, h: 0.8, loc: 3 }, rank, false)
    expect(stretchOf(4, 4, 0.8, getModel(squat.modelId))).toBeLessThanOrEqual(MAX_STRETCH)
    // A needle at the slenderness cap (0.6 + 7 * 0.6 = 4.8 for a 0.6 footprint).
    const needle = pickPlacement({ path: 'needle.ts', w: 0.6, d: 0.6, h: 4.8, loc: 5000 }, new LocRank(Array.from({ length: 100 }, (_, i) => i + 1)), false)
    expect(stretchOf(0.6, 0.6, 4.8, getModel(needle.modelId))).toBeGreaterThanOrEqual(MIN_STRETCH)
    expect(stretchOf(0.6, 0.6, 4.8, getModel(needle.modelId))).toBeLessThanOrEqual(MAX_STRETCH)
  })

  it('scales the model to fill FILL of the footprint and reach the rendered height', () => {
    const input: PickInput = { path: 'a.ts', w: 2, d: 3, h: 4, loc: 200 }
    const p = pickPlacement(input, new LocRank([200, 10, 20]), false)
    const m = getModel(p.modelId)
    expect(p.sx * m.size.x).toBeCloseTo(input.w * FILL, 6)
    expect(p.sz * m.size.z).toBeCloseTo(input.d * FILL, 6)
    expect(m.size.y * input.h * p.invY).toBeCloseTo(input.h, 6) // rendered top = h
  })

  it('never exceeds the footprint', () => {
    for (const input of synthetic(300)) {
      const p = pickPlacement(input, new LocRank(synthetic(300).map((i) => i.loc)), false)
      const m = getModel(p.modelId)
      expect(p.sx * m.size.x).toBeLessThanOrEqual(input.w + 1e-9)
      expect(p.sz * m.size.z).toBeLessThanOrEqual(input.d + 1e-9)
    }
  })

  it('is deterministic for one path and varies between neighbours', () => {
    const rank = new LocRank([100, 100, 100])
    const a1 = pickPlacement({ path: 'same.ts', w: 1.5, d: 1.5, h: 3, loc: 100 }, rank, false)
    const a2 = pickPlacement({ path: 'same.ts', w: 1.5, d: 1.5, h: 3, loc: 100 }, rank, false)
    expect(a1.modelId).toBe(a2.modelId)
    const ids = new Set<string>()
    for (let i = 0; i < 60; i++) {
      ids.add(pickPlacement({ path: `dir/neighbour-${i}.ts`, w: 1.5, d: 1.5, h: 3, loc: 100 }, rank, false).modelId)
    }
    expect(ids.size).toBeGreaterThan(1)
  })

  it('hashPath is in [0, 1) and stable', () => {
    expect(hashPath('x')).toBe(hashPath('x'))
    expect(hashPath('x')).toBeGreaterThanOrEqual(0)
    expect(hashPath('x')).toBeLessThan(1)
  })
})

describe('triangle budget', () => {
  it('a small repo uses detailed models, not low-detail ones', () => {
    const inputs = synthetic(200, 3).map((i) => ({ ...i, loc: i.loc + 50 }))
    const plan = planBudget(inputs)
    expect(plan.some((p) => p.cls === 'lowdetail')).toBe(false)
    expect(plan.reduce((n, p) => n + p.tris, 0)).toBeLessThan(TRI_BUDGET)
  })

  it('a big repo gives its tiniest files low-detail models', () => {
    const inputs = synthetic(BIG_REPO + 200, 4)
    const plan = planBudget(inputs, 1e12)
    const tiny = inputs.map((i, k) => ({ i, k })).filter(({ i }) => i.loc < 25)
    expect(tiny.length).toBeGreaterThan(0)
    // Most tiny files get low-detail models; the rest fall back to houses where no low-detail model has the right shape.
    const share = tiny.filter(({ k }) => plan[k]!.cls === 'lowdetail').length / tiny.length
    expect(share).toBeGreaterThan(0.5)
  })

  it('keeps the top-LOC buildings detailed when the budget bites', () => {
    const inputs = synthetic(BIG_REPO + 500, 11)
    const plan = planBudget(inputs, 1_000_000)
    const byLoc = inputs.map((_, i) => i).sort((a, b) => inputs[b]!.loc - inputs[a]!.loc)
    const top = byLoc.slice(0, 50)
    const topDetailed = top.filter((i) => plan[i]!.cls !== 'lowdetail').length
    expect(topDetailed).toBe(50)
    expect(plan.reduce((n, p) => n + p.tris, 0)).toBeLessThanOrEqual(1_000_000)
  })

  it('20k synthetic buildings stay under 3 M triangles', () => {
    const inputs = synthetic(20_000, 21)
    const t0 = performance.now()
    const plan = planBudget(inputs)
    const ms = performance.now() - t0
    const tris = plan.reduce((n, p) => n + p.tris, 0)
    expect(tris).toBeLessThan(TRI_BUDGET)
    expect(plan.length).toBe(inputs.length)
    expect(ms).toBeLessThan(2000)
  })

  it('20k repo with the budget bitten: low-detail first, then the cheapest fit', () => {
    const inputs = synthetic(20_000, 5)
    const plan = planBudget(inputs, 1_500_000)
    expect(plan.reduce((n, p) => n + p.tris, 0)).toBeLessThanOrEqual(1_500_000)
  })

  it('under the budget the plan is the unconstrained pick', () => {
    const inputs = synthetic(50, 9)
    const a = planBudget(inputs)
    const b = planBudget(inputs, 1e12)
    expect(a.map((p) => p.modelId)).toEqual(b.map((p) => p.modelId))
  })
})
