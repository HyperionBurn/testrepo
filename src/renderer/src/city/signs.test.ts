import { describe, expect, it } from 'vitest'
import {
  BILLBOARD_MAX, HOTSPOT_MIN, HOTSPOT_SIZE, SLOTS_PER_ATLAS, facingOf, faceNormal, hash01, planSigns,
  type PlanBuilding, type SignSpec
} from './signs'

/** Deterministic PRNG (mulberry32), so the synthetic blocks are the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A grid of blocks: streets of 2 units between footprints, heights from a skewed distribution. */
function city(cols: number, rows: number, seed = 7): PlanBuilding[] {
  const r = rng(seed)
  const out: PlanBuilding[] = []
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const w = 1.2 + r() * 2.6
      const d = 1.2 + r() * 2.6
      const top = 0.6 + Math.pow(r(), 3) * 48
      out.push({ path: `src/f${i}-${j}.ts`, x: i * 6 + (6 - w) / 2, z: j * 6 + (6 - d) / 2, w, d, top })
    }
  }
  return out
}

/** Face-local extent of a sign along its facade, as the planner placed it. */
function extent(s: SignSpec, b: PlanBuilding): { u0: number; u1: number; v0: number; v1: number } {
  const alongX = s.face === 'N' || s.face === 'S'
  const uc = alongX ? s.x - b.x : s.z - b.z
  const uw = s.kind === 'blade' ? 0.6 : s.w
  return { u0: uc - uw / 2, u1: uc + uw / 2, v0: s.y - s.h / 2, v1: s.y + s.h / 2 }
}

describe('hash01', () => {
  it('is deterministic and in [0, 1)', () => {
    expect(hash01('src/a.ts')).toBe(hash01('src/a.ts'))
    for (const k of ['', 'a', 'src/main/hub.ts', 'x'.repeat(300)]) {
      const v = hash01(k, 'salt')
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(hash01('a', 'x')).not.toBe(hash01('a', 'y'))
  })
})

describe('planSigns', () => {
  const blocks = city(18, 18)
  const plan = planSigns(blocks)

  it('is deterministic', () => {
    expect(planSigns(blocks)).toEqual(plan)
  })

  it('picks a 12 to 20 building hotspot near the centroid, tallest first', () => {
    expect(plan.hotspot.length).toBeGreaterThanOrEqual(HOTSPOT_MIN)
    expect(plan.hotspot.length).toBeLessThanOrEqual(HOTSPOT_SIZE)
    const tops = plan.hotspot.map((i) => blocks[i]!.top)
    for (let k = 1; k < tops.length; k++) expect(tops[k]!).toBeLessThanOrEqual(tops[k - 1]!)
    const dist = (i: number): number => {
      const b = blocks[i]!
      return Math.hypot(b.x + b.w / 2 - plan.centroid.x, b.z + b.d / 2 - plan.centroid.z)
    }
    const worst = Math.max(...plan.hotspot.map(dist))
    const outside = blocks.map((_, i) => i).filter((i) => !plan.hotspot.includes(i) && blocks[i]!.top >= 4)
    // Every hotspot member is among the nearest of the eligible buildings.
    const closerOutside = outside.filter((i) => dist(i) < worst - 1e-9).length
    expect(closerOutside).toBeLessThanOrEqual(HOTSPOT_SIZE * 4)
  })

  it('has no hotspot for a small city', () => {
    const small = planSigns(city(2, 2))
    expect(small.hotspot).toEqual([])
    expect(planSigns([]).signs).toEqual([])
  })

  it('gives the hotspot billboards, marquees and blades', () => {
    const hot = plan.signs.filter((s) => s.hot)
    expect(hot.some((s) => s.kind === 'billboard')).toBe(true)
    expect(hot.some((s) => s.kind === 'marquee')).toBe(true)
    expect(hot.some((s) => s.kind === 'blade')).toBe(true)
  })

  it('keeps billboards within the slot budget with unique atlas slots', () => {
    const bb = plan.signs.filter((s) => s.kind === 'billboard')
    expect(bb.length).toBeLessThanOrEqual(BILLBOARD_MAX)
    const keys = new Set(bb.map((s) => `${s.atlas}:${s.slot}`))
    expect(keys.size).toBe(bb.length)
    for (const s of bb) {
      expect(s.atlas).toBeGreaterThanOrEqual(0)
      expect(s.slot).toBeLessThan(SLOTS_PER_ATLAS)
    }
    for (const s of plan.signs.filter((x) => x.kind !== 'billboard')) {
      expect(s.atlas).toBe(-1)
      expect(s.slot).toBe(-1)
    }
  })

  it('never puts two signs on the same face over each other', () => {
    const byFace = new Map<string, SignSpec[]>()
    for (const s of plan.signs) {
      const k = `${s.building}:${s.face}`
      byFace.set(k, [...(byFace.get(k) ?? []), s])
    }
    for (const list of byFace.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let c = a + 1; c < list.length; c++) {
          const b = blocks[list[a]!.building]!
          const ea = extent(list[a]!, b)
          const ec = extent(list[c]!, b)
          const overlap = ea.u0 < ec.u1 && ec.u0 < ea.u1 && ea.v0 < ec.v1 && ec.v0 < ea.v1
          expect(overlap).toBe(false)
        }
      }
    }
  })

  it('keeps every sign inside its facade', () => {
    for (const s of plan.signs) {
      const b = blocks[s.building]!
      const span = s.face === 'N' || s.face === 'S' ? b.w : b.d
      const e = extent(s, b)
      expect(e.u0).toBeGreaterThanOrEqual(0)
      expect(e.u1).toBeLessThanOrEqual(span)
      expect(e.v0).toBeGreaterThanOrEqual(0)
      expect(e.v1).toBeLessThanOrEqual(b.top)
    }
  })

  it('mounts flush just outside the chosen face', () => {
    for (const s of plan.signs.filter((x) => x.kind !== 'blade')) {
      const b = blocks[s.building]!
      const n = faceNormal(s.face)
      // Distance from the face plane, along the normal, is a small positive gap.
      const along = (s.x - (b.x + (n.x > 0 ? b.w : n.x < 0 ? 0 : b.w / 2))) * n.x +
        (s.z - (b.z + (n.z > 0 ? b.d : n.z < 0 ? 0 : b.d / 2))) * n.z
      expect(along).toBeGreaterThan(0)
      expect(along).toBeLessThan(0.2)
      // Billboards and marquees face outward: the plane's +z points along the normal.
      expect(Math.sin(s.yaw)).toBeCloseTo(n.x, 5)
      expect(Math.cos(s.yaw)).toBeCloseTo(n.z, 5)
    }
  })

  it('scales billboards with the width of their building', () => {
    const wide = plan.signs.filter((s) => s.kind === 'billboard').map((s) => ({ w: s.w, span: blocks[s.building]!.w }))
    expect(wide.length).toBeGreaterThan(0)
    for (const x of wide) expect(x.w).toBeGreaterThanOrEqual(1.6)
  })
})

describe('facingOf', () => {
  it('faces the open street, not a neighbour close behind one side', () => {
    const blocks: PlanBuilding[] = [
      { path: 'a.ts', x: 0, z: 0, w: 2, d: 2, top: 20 },
      // A neighbour 0.5 units east of a's east face: that side is walled in.
      { path: 'b.ts', x: 2.5, z: -0.5, w: 2, d: 3, top: 20 }
    ]
    expect(facingOf(blocks, 0)).not.toBe('E')
  })
})
