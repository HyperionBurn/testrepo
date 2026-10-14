import { describe, expect, it } from 'vitest'
import { BuildingPicker, throttle, type PickBox } from './picking'

/** Brute-force reference: nearest box hit, same slab rules. */
function bruteNearest(boxes: PickBox[], tops: number[], o: number[], d: number[]): { i: number; t: number } {
  let best = Infinity
  let bi = -1
  boxes.forEach((b, i) => {
    const top = tops[i]!
    if (top < 1e-3) return
    let tmin = -Infinity
    let tmax = Infinity
    const lo = [b.x, 0, b.z]
    const hi = [b.x + b.w, top, b.z + b.d]
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]!) < 1e-9) {
        if (o[k]! < lo[k]! || o[k]! > hi[k]!) return
      } else {
        let a = (lo[k]! - o[k]!) / d[k]!
        let c = (hi[k]! - o[k]!) / d[k]!
        if (a > c) [a, c] = [c, a]
        tmin = Math.max(tmin, a)
        tmax = Math.min(tmax, c)
      }
    }
    if (tmin > tmax || tmax < 0) return
    const t = Math.max(tmin, 0)
    if (t < best) {
      best = t
      bi = i
    }
  })
  return { i: bi, t: best }
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('BuildingPicker', () => {
  // A 3 x 3 grid of towers, 2 units wide, 1 unit apart. Tower (r,c) is at x = 3c, z = 3r.
  const boxes: PickBox[] = []
  const tops: number[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      boxes.push({ x: 3 * c, z: 3 * r, w: 2, d: 2 })
      tops.push(1 + r + c)
    }
  }
  const live = boxes.map(() => true)
  const picker = new BuildingPicker(boxes, live, tops)

  it('hits the right box from above and from the side', () => {
    // Centre of tower (1,2): x 6..8, z 3..5 → centre (7, 4). Top 1+1+2 = 4.
    const i = picker.pick(7, 50, 4, 0, -1, 0)
    expect(i).toBe(1 * 3 + 2)
    expect(picker.lastT).toBeCloseTo(50 - 4, 6)
    // Side view along +x at height 0.5 (below the first tower's top of 1) hits the first tower in row 0.
    expect(picker.pick(-5, 0.5, 0.5, 1, 0, 0)).toBe(0)
    // At height 2 it flies over that tower and into the next one, whose top is 2.
    expect(picker.pick(-5, 1.5, 0.5, 1, 0, 0)).toBe(1)
  })

  it('misses in a gap, above the tops, and outside the grid', () => {
    expect(picker.pick(2.5, 50, 1, 0, -1, 0)).toBe(-1) // between tower 0 and tower 1
    expect(picker.lastT).toBe(Infinity)
    expect(picker.pick(0.5, 50, 0.5, 0, -1, 0)).toBe(0) // above tower 0 (top 1): hits
    expect(picker.pick(2.5, 0.5, -10, 0, 0, 1)).toBe(-1) // down the gap between columns 0 and 1: nothing to hit
    expect(picker.pick(0.5, 0.5, -10, 0, 0, 1)).toBe(0) // down column 0 under tower 0's top: hits it
  })

  it('nearest wins when two boxes are on the ray', () => {
    const b2 = [{ x: 0, z: 0, w: 2, d: 2 }, { x: 0, z: 6, w: 2, d: 2 }]
    const p2 = new BuildingPicker(b2, [true, true], [3, 5])
    // Ray along +z from z=-4 at height 2: hits box 0 first (z 0), not box 1 (z 6), though box 1 is taller.
    expect(p2.pick(1, 2, -4, 0, 0, 1)).toBe(0)
    // Ray from the other side hits box 1 first.
    expect(p2.pick(1, 2, 14, 0, 0, -1)).toBe(1)
  })

  it('ignores ghosts and zero-height boxes, and gives the height as a live update', () => {
    const b = [{ x: 0, z: 0, w: 2, d: 2 }, { x: 5, z: 0, w: 2, d: 2 }]
    const p = new BuildingPicker(b, [true, false], [4, 4])
    expect(p.pick(1, 50, 1, 0, -1, 0)).toBe(0)
    expect(p.pick(6, 50, 1, 0, -1, 0)).toBe(-1) // the ghost is not in the grid
    p.setTop(0, 0)
    expect(p.pick(1, 50, 1, 0, -1, 0)).toBe(-1) // sunk to nothing
    p.setTop(0, 10)
    expect(p.pick(1, 50, 1, 0, -1, 0)).toBe(0) // grew back
  })

  it('agrees with a brute-force search on random rays and boxes', () => {
    const r = rng(42)
    const n = 800
    const bx: PickBox[] = []
    const tp: number[] = []
    for (let i = 0; i < n; i++) {
      bx.push({ x: r() * 200, z: r() * 200, w: 0.5 + r() * 3, d: 0.5 + r() * 3 })
      tp.push(0.5 + r() * 12)
    }
    const pk = new BuildingPicker(bx, bx.map(() => true), tp)
    let checked = 0
    for (let q = 0; q < 3000; q++) {
      const o = [r() * 260 - 30, 20 + r() * 80, r() * 260 - 30]
      const dir = [r() * 2 - 1, -(0.1 + r()), r() * 2 - 1]
      const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
      const d = dir.map((v) => v / len)
      const got = pk.pick(o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!)
      const want = bruteNearest(bx, tp, o, d)
      expect(got).toBe(want.i)
      if (want.i >= 0) expect(pk.lastT).toBeCloseTo(want.t, 4) // tops are float32
      checked++
    }
    expect(checked).toBe(3000)
  })

  it('a query against 20k boxes takes well under 0.5 ms', () => {
    const r = rng(9)
    const n = 20_000
    const bx: PickBox[] = []
    const tp: number[] = []
    for (let i = 0; i < n; i++) {
      bx.push({ x: r() * 400, z: r() * 400, w: 0.8 + r() * 2, d: 0.8 + r() * 2 })
      tp.push(0.6 + r() * 10)
    }
    const pk = new BuildingPicker(bx, bx.map(() => true), tp)
    const queries: number[][] = []
    for (let q = 0; q < 2000; q++) {
      const ox = r() * 400, oz = r() * 400
      queries.push([ox, 300, oz, (r() - 0.5) * 0.3, -1, (r() - 0.5) * 0.3])
    }
    // Warm up, then time.
    for (let q = 0; q < 200; q++) pk.pick(...(queries[q] as [number, number, number, number, number, number]))
    const t0 = performance.now()
    for (const q of queries) pk.pick(...(q as [number, number, number, number, number, number]))
    const perQuery = (performance.now() - t0) / queries.length
    expect(perQuery).toBeLessThan(0.5)
  })
})

describe('throttle', () => {
  it('runs the first call at once, drops bursts, and runs the latest argument at the end of the window', async () => {
    const calls: number[] = []
    let clock = 0
    const t = throttle((v: number) => calls.push(v), 40, () => clock)
    t(1)
    expect(calls).toEqual([1])
    clock = 10
    t(2)
    clock = 20
    t(3)
    expect(calls).toEqual([1])
    await new Promise((res) => setTimeout(res, 60))
    expect(calls).toEqual([1, 3])
  })

  it('cancel drops the pending call', async () => {
    const calls: number[] = []
    let clock = 0
    const t = throttle((v: number) => calls.push(v), 30, () => clock)
    t(1)
    clock = 5
    t(2)
    t.cancel()
    await new Promise((res) => setTimeout(res, 50))
    expect(calls).toEqual([1])
  })
})
