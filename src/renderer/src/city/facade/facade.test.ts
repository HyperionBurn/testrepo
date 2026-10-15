import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../../shared/layout'
import { langFromPath } from '../../../../shared/lang'
import type { CityLayout, FileNode, RepoSnapshot } from '../../../../shared/types'
import { facadePlacement, hashPath, LocRank, planReal, type PickInput } from '../modelPicker'
import { visHeight } from '../geom'
import { buildMassingMesh, TEMPLATES, templateTris, templatesWith } from './templates'
import { HeightRank, MID_MAX, MID_MIN, realHeight, SPIRE_MAX } from './skyline'

/** Deterministic PRNG (mulberry32). */
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

function syntheticRepo(count: number, seed: number): RepoSnapshot {
  const rand = rng(seed)
  const files: FileNode[] = []
  for (let i = 0; i < count; i++) {
    const u1 = Math.max(rand(), 1e-9)
    const u2 = rand()
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const loc = Math.max(1, Math.round(Math.exp(4.1 + 1.1 * gauss)))
    const path = `src/pkg${i % 23}/file${i}.${i % 3 === 0 ? 'ts' : 'md'}`
    files.push({ path, lang: langFromPath(path), loc, bytes: loc * 40, mtime: 0, imports: [] })
  }
  return { root: '/synthetic', name: 'synthetic', files, scannedAt: 0 }
}

function inputsOf(layout: CityLayout, locOf: Map<string, number>): PickInput[] {
  return layout.buildings.map((b) => ({ path: b.path, w: b.w, d: b.d, h: visHeight(b, layout), loc: locOf.get(b.path) ?? 100 }))
}

describe('facade templates', () => {
  it('has about two dozen unit building templates with unique ids', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(24)
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
  })

  it('every template has the base at y = 0, reaches y = 1, and stays inside the unit footprint', () => {
    for (const t of TEMPLATES) {
      const m = buildMassingMesh(t)
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < m.position.length; i += 3) {
        const x = m.position[i]!
        const y = m.position[i + 1]!
        const z = m.position[i + 2]!
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-6)
        expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-6)
      }
      expect(minY).toBeCloseTo(0, 9)
      expect(maxY).toBeCloseTo(1, 9)
      expect(m.index.length % 3).toBe(0)
      for (const k of m.index) expect(k).toBeLessThan(m.position.length / 3)
    }
  })

  it('every face is wound counter-clockwise seen from outside, along its stated normal', () => {
    for (const t of TEMPLATES) {
      const m = buildMassingMesh(t)
      for (let i = 0; i < m.index.length; i += 3) {
        const a = m.index[i]!
        const b = m.index[i + 1]!
        const c = m.index[i + 2]!
        const P = (k: number) => [m.position[k * 3]!, m.position[k * 3 + 1]!, m.position[k * 3 + 2]!]
        const [pa, pb, pc] = [P(a), P(b), P(c)]
        const e1 = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!]
        const e2 = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!]
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
        const sn = [m.normal[a * 3]!, m.normal[a * 3 + 1]!, m.normal[a * 3 + 2]!]
        expect(n[0]! * sn[0]! + n[1]! * sn[1]! + n[2]! * sn[2]!).toBeGreaterThan(0)
      }
    }
  })

  it('the triangle count matches the template budget', () => {
    for (const t of TEMPLATES) expect(buildMassingMesh(t).index.length / 3).toBe(templateTris(t))
  })

  it('every placement tag has at least one template', () => {
    for (const tag of ['spire', 'tower', 'mid', 'plate', 'complex'] as const) expect(templatesWith(tag).length).toBeGreaterThan(0)
  })
})

describe('facade placement', () => {
  const repo = syntheticRepo(20000, 3)
  const layout = buildLayout(repo)
  const locOf = new Map(repo.files.map((f) => [f.path, f.loc]))
  const inputs = inputsOf(layout, locOf)
  const plan = planReal(inputs).map((r) => r.massing)
  const heights = inputs.map((i) => i.h)

  it('most files are mid-rise (rendered heights between MID_MIN and MID_MAX), at least 70 %', () => {
    const mid = heights.filter((h) => h >= MID_MIN - 1e-9 && h <= MID_MAX + 1e-9).length
    expect(mid / heights.length).toBeGreaterThanOrEqual(0.7)
  })

  it('the top ~1.5 % by LOC are the supertall, spire-class massings, and only those', () => {
    const rank = new LocRank(inputs.map((i) => i.loc))
    const top = inputs.filter((i) => rank.percentile(i.loc) >= 0.985).length
    const skyscrapers = plan.filter((p) => p.cls === 'skyscraper')
    expect(skyscrapers.length).toBe(top)
    expect(skyscrapers.length / inputs.length).toBeGreaterThan(0)
    expect(skyscrapers.length / inputs.length).toBeLessThanOrEqual(0.02)
    const spireIds = new Set(templatesWith('spire').map((t) => t.id))
    for (const p of skyscrapers) expect(spireIds.has(p.modelId)).toBe(true)
  })

  it('the tallest buildings are the spires, and nothing exceeds SPIRE_MAX', () => {
    const maxH = Math.max(...heights)
    expect(maxH).toBeLessThanOrEqual(SPIRE_MAX + 1e-9)
    expect(maxH).toBeGreaterThan(MID_MAX)
  })

  it('is deterministic: the same inputs give the same templates', () => {
    const again = planReal(inputs).map((r) => r.massing)
    expect(again.map((p) => p.modelId)).toEqual(plan.map((p) => p.modelId))
  })

  it('fills FILL of the footprint, and keeps a minimum drawn footprint for tiny files', () => {
    const tiny: PickInput = { path: 'tiny.ts', w: 0.02, d: 0.02, h: 0.9, loc: 3 }
    const p = facadePlacement(tiny, 0.1)
    expect(p.sx).toBeGreaterThanOrEqual(0.22 - 1e-9)
    expect(p.sz).toBeGreaterThanOrEqual(0.22 - 1e-9)
    const big: PickInput = { path: 'big.ts', w: 2, d: 1, h: 2, loc: 800 }
    const q = facadePlacement(big, 0.5)
    expect(q.sx).toBeCloseTo(2 * 0.97, 9)
    expect(q.sz).toBeCloseTo(0.97, 9)
    expect(q.invY).toBe(1)
  })

  it('the drawn height is the rendered height: the y scale is 1 on a unit template', () => {
    for (const p of plan.slice(0, 200)) expect(p.invY).toBe(1)
  })

  it('20k buildings stay under 2 M triangles', () => {
    const total = plan.reduce((n, p) => n + p.tris, 0)
    expect(total).toBeLessThanOrEqual(2_000_000)
    expect(total).toBeGreaterThan(0)
  })

  it('uses a variety of templates, not one shape', () => {
    expect(new Set(plan.map((p) => p.modelId)).size).toBeGreaterThanOrEqual(15)
  })

  it('a path hash is stable and in [0, 1)', () => {
    expect(hashPath('a/b.ts')).toBe(hashPath('a/b.ts'))
    expect(hashPath('a/b.ts')).toBeGreaterThanOrEqual(0)
    expect(hashPath('a/b.ts')).toBeLessThan(1)
  })
})

describe('height model', () => {
  it('is bounded by the mid-rise band below the spire cut, and tops out at SPIRE_MAX', () => {
    for (let p = 0; p < 0.985; p += 0.05) {
      for (const c of [0, 0.5, 1]) {
        const h = realHeight(p, c, 5, 5)
        expect(h).toBeGreaterThanOrEqual(MID_MIN - 1e-9)
        expect(h).toBeLessThanOrEqual(MID_MAX + 1e-9)
      }
    }
    expect(realHeight(1, 1, 50, 50)).toBeLessThanOrEqual(SPIRE_MAX + 1e-9)
  })

  it('HeightRank ranks a value among the others, the tallest at 1', () => {
    const r = new HeightRank([1, 2, 3, 4])
    expect(r.percentile(0)).toBe(0)
    expect(r.percentile(3)).toBeCloseTo(2 / 3, 12)
    expect(r.percentile(4)).toBe(1)
    expect(r.percentile(10)).toBe(1)
    expect(new HeightRank([5]).percentile(5)).toBe(0)
  })
})
