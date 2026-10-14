import { describe, expect, it } from 'vitest'
import {
  BRIDGES, MAX_LOTS, METRO_RADIUS, RIVERS, bridgeSpan, buildMetro, hashName, lotHeight, metroCores, overlaps, type LotSet,
  type MetroPlan, touchesRiver
} from './metro'

const HALF = 60 // half the repo city square (CITY_SIZE 120)
const NAME = 'skyline'

function allLots(plan: MetroPlan): Array<{ x: number; z: number; w: number; h: number; d: number; set: string }> {
  const out: Array<{ x: number; z: number; w: number; h: number; d: number; set: string }> = []
  for (const key of ['tiered', 'spired', 'mid', 'far', 'edge'] as const) {
    const s: LotSet = plan[key]
    for (let i = 0; i < s.count; i++) {
      out.push({ x: s.pos[i * 3]!, z: s.pos[i * 3 + 2]!, w: s.size[i * 3]!, h: s.size[i * 3 + 1]!, d: s.size[i * 3 + 2]!, set: key })
    }
  }
  return out
}

/** Axis-aligned bounds of a lot in world space, from its footprint and the grid rotation. */
function lotBounds(l: { x: number; z: number; w: number; d: number }): { x0: number; x1: number; z0: number; z1: number } {
  const c = Math.cos(Math.PI * 29 / 180)
  const s = Math.sin(Math.PI * 29 / 180)
  // Local x runs along U (c, -s), local z along V (s, c).
  const ex = Math.abs(l.w / 2 * c) + Math.abs(l.d / 2 * s)
  const ez = Math.abs(l.w / 2 * s) + Math.abs(l.d / 2 * c)
  return { x0: l.x - ex, x1: l.x + ex, z0: l.z - ez, z1: l.z + ez }
}

describe('metro plan', () => {
  const plan = buildMetro({ name: NAME, half: HALF })

  it('is deterministic per repo name', () => {
    const again = buildMetro({ name: NAME, half: HALF })
    expect(again.boxCount).toBe(plan.boxCount)
    expect(again.tiered.pos).toEqual(plan.tiered.pos)
    expect(again.far.size).toEqual(plan.far.size)
    expect(again.lines.xz).toEqual(plan.lines.xz)
  })

  it('gives each repo its own skyline', () => {
    const other = buildMetro({ name: 'another-repo', half: HALF })
    expect(other.seed).not.toBe(plan.seed)
    expect(other.mid.pos.slice(0, 60)).not.toEqual(plan.mid.pos.slice(0, 60))
    expect(hashName('a')).not.toBe(hashName('b'))
  })

  it('keeps every building out of the repo city square with its margin', () => {
    let worst = Infinity
    for (const l of allLots(plan)) {
      const b = lotBounds(l)
      const inside = b.x1 > -HALF && b.x0 < HALF && b.z1 > -HALF && b.z0 < HALF
      expect(inside).toBe(false)
      worst = Math.min(worst, Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.z0), Math.abs(b.z1)) - HALF)
    }
    // Lots stop short of the square's edge by at least the margin.
    expect(worst).toBeGreaterThanOrEqual(0)
  })

  it('keeps lots off the rivers and the bridge corridors', () => {
    for (const l of allLots(plan)) {
      const b = lotBounds(l)
      expect(touchesRiver(b.x0, b.x1)).toBe(false)
      for (const br of BRIDGES) expect(overlaps(bridgeSpan(br), b)).toBe(false)
    }
  })

  it('keeps every lot inside the metro radius', () => {
    for (const l of allLots(plan)) expect(Math.hypot(l.x, l.z)).toBeLessThanOrEqual(METRO_RADIUS + 60)
  })

  it('stays within the instance budget', () => {
    expect(plan.boxCount).toBeLessThanOrEqual(MAX_LOTS)
    expect(plan.boxCount).toBeGreaterThanOrEqual(40000)
    // Triangle budget: boxes are 12 triangles each (stepped near towers about 3x), light quads 2 each.
    const tris = (plan.tiered.count + plan.spired.count) * 40 + (plan.mid.count + plan.far.count + plan.edge.count) * 12 + plan.lines.quads * 2
    expect(tris).toBeLessThanOrEqual(1_200_000)
  })

  it('uses the stepped-tier bands only in the near ring', () => {
    for (const key of ['tiered', 'spired'] as const) {
      const s = plan[key]
      for (let i = 0; i < s.count; i++) expect(Math.hypot(s.pos[i * 3]!, s.pos[i * 3 + 2]!)).toBeLessThan(250)
    }
  })

  it('has spiky downtown cores and low edges', () => {
    const all = allLots(plan)
    const heightsWhere = (f: (r: number) => boolean) => all.filter((l) => f(Math.hypot(l.x, l.z))).map((l) => l.h)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const core = heightsWhere((r) => r < 900)
    const edge = heightsWhere((r) => r > 1400)
    expect(Math.max(...core)).toBeGreaterThan(160)
    expect(mean(core)).toBeGreaterThan(mean(edge) * 2)
    expect(mean(edge)).toBeLessThan(40)
  })

  it('places cores on the island and clusters across the rivers', () => {
    const cores = metroCores(hashName(NAME))
    expect(cores).toHaveLength(5)
    for (const c of cores.slice(0, 3)) expect(Math.abs(c.x)).toBeLessThan(250)
    for (const c of cores.slice(3)) expect(Math.abs(c.x)).toBeGreaterThan(700)
  })

  it('lotHeight tops out in the cores and stays low at the rim', () => {
    const cores = metroCores(hashName(NAME))
    const core = cores[0]!
    const inCore = lotHeight(core.x, core.z, cores, hashName(NAME), 0.99).h
    const rim = lotHeight(1500, 1500, cores, hashName(NAME), 0.99).h
    expect(inCore).toBeGreaterThan(rim * 4)
    expect(rim).toBeLessThan(60)
  })

  it('keeps the light lines on land and out of the square', () => {
    const { lines } = plan
    expect(lines.quads).toBeGreaterThan(5000)
    for (let q = 0; q < lines.quads; q++) {
      const mx = (lines.xz[q * 8]! + lines.xz[q * 8 + 4]!) / 2
      const mz = (lines.xz[q * 8 + 1]! + lines.xz[q * 8 + 5]!) / 2
      expect(touchesRiver(mx - 3, mx + 3)).toBe(false)
      expect(Math.abs(mx) < HALF && Math.abs(mz) < HALF).toBe(false)
    }
  })

  it('exposes the rivers as the strips the buildings avoid', () => {
    expect(RIVERS.map((r) => r.side).sort()).toEqual(['east', 'west'])
    expect(RIVERS[0]!.x1).toBeLessThan(-200)
    expect(RIVERS[1]!.x0).toBeGreaterThan(200)
  })
})
