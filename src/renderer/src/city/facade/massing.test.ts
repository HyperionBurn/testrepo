import { describe, expect, it } from 'vitest'
import { FACADE_SETS } from './photo/sets'
import { facadeSetFor, facadeSetIndex, litFor, MASSING_UV_GLSL, massingUv, METRES_PER_UNIT, METRO_TIERS, REPO_TIERS } from './massing'
import { buildMassingMesh, TEMPLATES } from './templates'

describe('massingUv: the photo facade UVs in metres', () => {
  // A 4 x 6 x 10 unit building (x 4 units wide, 6 tall, 10 deep) at the origin: 40 m wide, 60 m tall, 100 m deep.
  const size: [number, number, number] = [4, 6, 10]

  it('measures the front and back walls along x from the left corner, and the sides along z', () => {
    expect(massingUv([-0.5, 0.5, 0.5], [0, 0, 1], size)[0]).toBeCloseTo(0)
    expect(massingUv([0.5, 0.5, 0.5], [0, 0, 1], size)[0]).toBeCloseTo(40)
    expect(massingUv([0.5, 0.5, -0.5], [0, 0, -1], size)[0]).toBeCloseTo(40)
    expect(massingUv([0.5, 0.5, -0.5], [1, 0, 0], size)[0]).toBeCloseTo(0)
    expect(massingUv([0.5, 0.5, 0.5], [1, 0, 0], size)[0]).toBeCloseTo(100)
  })

  it('measures height in metres up from grade, whatever the face', () => {
    expect(massingUv([0.2, 0, 0.5], [0, 0, 1], size)[1]).toBeCloseTo(0)
    expect(massingUv([0.2, 1, 0.5], [0, 0, 1], size)[1]).toBeCloseTo(60)
    expect(massingUv([0.5, 0.5, 0.5], [1, 0, 0], size)[1]).toBeCloseTo(30)
  })

  it('gives the same metres to a point on a setback tier as on the wall below it (the windows line up across tiers)', () => {
    // A tier inset by 0.2 units on the front: its wall point at x = -0.3 (unit space) is at the same metres as the base's.
    const base = massingUv([-0.3, 0.2, 0.5], [0, 0, 1], size)[0]
    const tier = massingUv([-0.3, 0.8, 0.3], [0, 0, 1], size)[0]
    expect(tier).toBeCloseTo(base)
  })

  it('scales with the instance size, so a wall keeps its metre scale at any footprint', () => {
    const a = massingUv([0.5, 0.5, 0.5], [0, 0, 1], [2, 1, 1])[0]
    const b = massingUv([0.5, 0.5, 0.5], [0, 0, 1], [8, 1, 1])[0]
    expect(b).toBeCloseTo(a * 4)
    expect(a).toBeCloseTo(20 * 1)
  })

  it('uses 10 m per unit (the world frame)', () => {
    expect(METRES_PER_UNIT).toBe(10)
    expect(massingUv([0.5, 1, 0.5], [0, 1, 0], [1, 1, 1])[1]).toBeCloseTo(10)
  })

  it('the GLSL in the photo vertex stage mirrors the same rule (metres from the instance scale)', () => {
    expect(MASSING_UV_GLSL).toContain('vFUV = abs(normal.x) > 0.5 ? vec2(mP.z, mP.y) : vec2(mP.x, mP.y);')
    expect(MASSING_UV_GLSL).toContain('* 10.0')
    expect(MASSING_UV_GLSL).toContain('instanceMatrix')
  })

  it('every template vertex maps to finite metres on a 1 x 1 x 1 instance', () => {
    for (const t of TEMPLATES) {
      const m = buildMassingMesh(t)
      for (let i = 0; i < m.position.length; i += 3) {
        const p = [m.position[i]!, m.position[i + 1]!, m.position[i + 2]!] as [number, number, number]
        const n = [m.normal[i]!, m.normal[i + 1]!, m.normal[i + 2]!] as [number, number, number]
        const [u, v] = massingUv(p, n, [1, 1, 1])
        expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true)
        expect(u).toBeGreaterThanOrEqual(-1e-6)
        expect(v).toBeGreaterThanOrEqual(-1e-6)
      }
    }
  })
})

describe('facade sets and lit share', () => {
  it('every set id resolves to its atlas index', () => {
    FACADE_SETS.forEach((s, i) => expect(facadeSetIndex(s.id)).toBe(i))
    expect(facadeSetIndex('nope')).toBe(-1)
  })

  it('towers take the night office and glass sets, low-rise the brick and grids', () => {
    const towerIds = new Set(['glass-001', 'glass-006', 'night-007', 'night-008', 'night-009', 'night-011'])
    const lowIds = new Set(['brick-018', 'brick-020', 'stone-019', 'grid-015', 'grid-012', 'night-016'])
    for (let k = 0; k < 40; k++) {
      const h = 7 + k * 0.3
      expect(towerIds.has(FACADE_SETS[facadeSetFor(h, k / 40, REPO_TIERS)]!.id)).toBe(true)
      expect(lowIds.has(FACADE_SETS[facadeSetFor(1, k / 40, REPO_TIERS)]!.id)).toBe(true)
    }
  })

  it('the metropolis tiers put the night offices on its tall lots', () => {
    const id = FACADE_SETS[facadeSetFor(30, 0.5, METRO_TIERS)]!
    expect(id.tone === 'office-night' || id.tone === 'glass').toBe(true)
  })

  it('lit share stays in its range per tone, and differs across the hash', () => {
    const office = FACADE_SETS.find((s) => s.tone === 'office-night')!
    const brick = FACADE_SETS.find((s) => s.tone === 'brick')!
    expect(litFor(office, 0)).toBeGreaterThanOrEqual(0.3)
    expect(litFor(office, 1)).toBeLessThanOrEqual(0.75)
    expect(litFor(brick, 0)).toBeLessThan(litFor(office, 0.9))
    expect(litFor(brick, 0.2)).not.toBe(litFor(brick, 0.8))
  })
})
