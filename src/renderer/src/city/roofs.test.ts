import { describe, expect, it } from 'vitest'
import { ROAD_PIECES } from './streets'
import {
  HELIPAD_MAX, ROOF_BUDGET, STEAM_ROOF, STEAM_SPACING, STEAM_STREET, planRooftops, planSteam, rooftopCount,
  type RoadTileLike, type RoofItem
} from './roofs'
import type { PlanBuilding } from './signs'

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

/** A square grid of blocks with skewed heights, so a few are towers and most are low-rise. */
function city(count: number, seed = 11): PlanBuilding[] {
  const r = rng(seed)
  const side = Math.ceil(Math.sqrt(count))
  const out: PlanBuilding[] = []
  for (let k = 0; k < count; k++) {
    const i = k % side
    const j = Math.floor(k / side)
    const w = 1.2 + r() * 2.6
    const d = 1.2 + r() * 2.6
    const top = 0.6 + Math.pow(r(), 2.6) * 55
    out.push({ path: `src/f${k}.ts`, x: i * 6 + (6 - w) / 2, z: j * 6 + (6 - d) / 2, w, d, top })
  }
  return out
}

function inFootprint(item: RoofItem, b: PlanBuilding): boolean {
  const eps = 0.2
  return item.x >= b.x - eps && item.x <= b.x + b.w + eps && item.z >= b.z - eps && item.z <= b.z + b.d + eps
}

describe('planRooftops', () => {
  const blocks = city(900)
  const plan = planRooftops(blocks)

  it('is deterministic', () => {
    expect(planRooftops(blocks)).toEqual(plan)
  })

  it('keeps 20 k files under the instance budget', () => {
    const big = planRooftops(city(20_000))
    expect(rooftopCount(big)).toBeLessThanOrEqual(ROOF_BUDGET)
    expect(rooftopCount(big)).toBeGreaterThan(1000)
  }, 60_000)

  it('skips tiny buildings and buildings shorter than 3', () => {
    const tiny: PlanBuilding[] = [{ path: 'tiny.ts', x: 0, z: 0, w: 0.5, d: 0.5, top: 30 }, { path: 'low.ts', x: 9, z: 0, w: 4, d: 4, top: 2 }]
    const p = planRooftops(tiny)
    expect(rooftopCount(p)).toBe(0)
  })

  it('puts every item on its own roof, at the rendered height', () => {
    const roofItems = [...plan.tanks, ...plan.boxes, ...plan.vents, ...plan.masts, ...plan.dishes, ...plan.gardens]
    for (const it2 of roofItems) {
      const b = blocks[it2.building]!
      // The parapet lip sits 2 cm under the roof edge on purpose; everything else is at the top.
      expect(Math.abs(it2.y - b.top)).toBeLessThanOrEqual(0.05)
      expect(inFootprint(it2, b)).toBe(true)
    }
    for (const t of plan.tanks) expect(t.sy).toBeGreaterThan(0.8)
  })

  it('puts spires on about the top 1.5 % with a red beacon at each tip', () => {
    const want = Math.round(blocks.length * 0.015)
    expect(plan.spires.length).toBe(want)
    const red = plan.beacons.filter((b) => b.color === 'red')
    expect(red.length).toBe(plan.spires.length)
    for (const s of plan.spires) {
      const b = blocks[s.building]!
      expect(s.y).toBeCloseTo(b.top, 5)
      // The beacon sits above the spire's top.
      const beacon = red.find((x) => x.building === s.building)!
      expect(beacon.y).toBeGreaterThan(s.y + s.sy)
    }
    // Spires go to the tallest buildings.
    const minSpire = Math.min(...plan.spires.map((s) => blocks[s.building]!.top))
    const above = blocks.filter((b) => b.top > minSpire).length
    expect(above).toBeLessThanOrEqual(plan.spires.length)
  })

  it('puts helipad edge lights only on helipads, and caps them', () => {
    expect(plan.helipads.length).toBeLessThanOrEqual(HELIPAD_MAX)
    const edge = plan.beacons.filter((b) => b.helipad)
    expect(edge.length).toBe(plan.helipads.length * 8)
    for (const h of plan.helipads) {
      const b = blocks[h.building]!
      expect(b.top).toBeGreaterThanOrEqual(22)
    }
  })

  it('gives mid-rise roofs clutter and bare low-rise roofs little', () => {
    const lowRoofs = blocks.filter((b) => b.top < 4).length
    const withTank = new Set(plan.tanks.map((t) => t.building))
    const midTank = blocks.map((b, i) => (b.top >= 6 ? i : -1)).filter((i) => i >= 0)
    const midWithTank = midTank.filter((i) => withTank.has(i)).length
    expect(midWithTank / midTank.length).toBeGreaterThan(0.1)
    expect(lowRoofs).toBeGreaterThan(0)
    for (const b of plan.boxes.filter((x) => x.kind === 'ac')) expect(blocks[b.building]!.top).toBeGreaterThanOrEqual(4)
  })
})

describe('planSteam', () => {
  it('samples about 120 emitters and keeps street ones apart', () => {
    const blocks = city(900)
    const plan = planRooftops(blocks)
    // A grid of straight avenue tiles, every 2 units.
    const roads: RoadTileLike[] = []
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        roads.push({ model: ROAD_PIECES.straight.model, x: i * 2 + 0.5, z: j * 2 + 0.5 })
      }
    }
    const steam = planSteam(plan.vents, roads)
    const roof = steam.filter((s) => s.kind === 'roof')
    const street = steam.filter((s) => s.kind === 'street')
    expect(roof.length).toBeLessThanOrEqual(STEAM_ROOF)
    expect(street.length).toBeLessThanOrEqual(STEAM_STREET)
    expect(steam.length).toBeGreaterThan(60)
    for (let a = 0; a < street.length; a++) {
      for (let c = a + 1; c < street.length; c++) {
        const d = Math.hypot(street[a]!.x - street[c]!.x, street[a]!.z - street[c]!.z)
        expect(d).toBeGreaterThanOrEqual(STEAM_SPACING)
      }
    }
    // Roof emitters sit at the top of their vent.
    for (const r of roof) expect(r.y).toBeGreaterThan(0)
  })

  it('makes no street emitters without straight tiles', () => {
    const steam = planSteam([], [{ model: 'road-bend', x: 1, z: 1 }])
    expect(steam).toEqual([])
  })
})
