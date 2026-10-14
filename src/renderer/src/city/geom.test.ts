import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../shared/layout'
import { langFromPath } from '../../../shared/lang'
import type { CityLayout, FileNode, RepoSnapshot } from '../../../shared/types'
import { clusterAt, MID_MAX, MID_MIN, SPIRE_MAX, SUPER_PCT } from './facade/skyline'
import { visCenter, visHeight } from './geom'

const BASE = 0.6

/** Deterministic PRNG (mulberry32), so the synthetic repos are the same on every run. */
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

/** Log-normal line counts with a median near 60 lines and a long tail of big files, in a few folders. */
function syntheticRepo(count: number, seed: number): RepoSnapshot {
  const rand = rng(seed)
  const files: FileNode[] = []
  for (let i = 0; i < count; i++) {
    const u1 = Math.max(rand(), 1e-9)
    const u2 = rand()
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const loc = Math.max(1, Math.round(Math.exp(4.1 + 1.1 * gauss)))
    const path = `pkg${i % 7}/file${i}.${i % 3 === 0 ? 'ts' : 'md'}`
    files.push({ path, lang: langFromPath(path), loc, bytes: loc * 40, mtime: 0, imports: [] })
  }
  return { root: '/synthetic', name: 'synthetic', files, scannedAt: 0 }
}

function layoutOf(repo: RepoSnapshot): CityLayout {
  return buildLayout(repo)
}

describe('visHeight', () => {
  const layout = layoutOf(syntheticRepo(3000, 7))

  it('is never below the mid-rise floor, and never above the largest spire', () => {
    for (const b of layout.buildings) {
      const h = visHeight(b, layout)
      expect(h).toBeGreaterThanOrEqual(MID_MIN - 1e-9)
      expect(h).toBeLessThanOrEqual(SPIRE_MAX + 1e-9)
    }
  })

  it('caps slenderness: height is at most BASE + 7 times the narrower footprint side (floored at the mid-rise minimum)', () => {
    for (const b of layout.buildings) {
      const cap = Math.max(MID_MIN, BASE + 7 * Math.min(b.w, b.d))
      expect(visHeight(b, layout)).toBeLessThanOrEqual(cap + 1e-9)
    }
  })

  it('is deterministic for one layout', () => {
    const b = layout.buildings[10]!
    expect(visHeight(b, layout)).toBe(visHeight(b, layout))
  })

  it('visCenter is the footprint centre at half the rendered height', () => {
    for (const b of layout.buildings.slice(0, 50)) {
      const c = visCenter(b, layout)
      expect(c.x).toBeCloseTo(b.x + b.w / 2, 12)
      expect(c.z).toBeCloseTo(b.z + b.d / 2, 12)
      expect(c.y).toBeCloseTo(visHeight(b, layout) / 2, 12)
    }
  })
})

describe('height distribution (New York)', () => {
  const layout = layoutOf(syntheticRepo(5000, 11))
  const heights = layout.buildings.map((b) => visHeight(b, layout))
  const sorted = [...heights].sort((a, b) => a - b)

  it('most buildings are mid-rise, between MID_MIN and MID_MAX', () => {
    const mid = heights.filter((h) => h >= MID_MIN - 1e-9 && h <= MID_MAX + 1e-9).length
    expect(mid / heights.length).toBeGreaterThanOrEqual(0.7)
  })

  it('a few supertall spires: the top ~1.5 % by LOC stand above MID_MAX, and the top 1 % is above the mid band', () => {
    const tall = heights.filter((h) => h > MID_MAX + 1e-9).length / heights.length
    expect(tall).toBeGreaterThan(0)
    expect(tall).toBeLessThanOrEqual(1 - SUPER_PCT + 0.01)
    expect(sorted[sorted.length - 1]!).toBeGreaterThan(MID_MAX)
  })

  it('clusters: the cluster field is smooth, so close neighbours agree more than distant ones', () => {
    const near = Math.abs(clusterAt(10, 10) - clusterAt(10.3, 10.2))
    expect(near).toBeLessThan(0.15)
    expect(clusterAt(3.3, 9.1)).toBeGreaterThanOrEqual(0)
    expect(clusterAt(3.3, 9.1)).toBeLessThanOrEqual(1)
  })
})
