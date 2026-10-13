import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../shared/layout'
import { langFromPath } from '../../../shared/lang'
import type { CityLayout, FileNode, RepoSnapshot } from '../../../shared/types'
import {
  heightStretch,
  MAX_SLENDERNESS,
  STRETCH_REF_COUNT,
  towerHeight,
  visCenter,
  visHeight
} from './geom'

const BASE = 0.6

/** The height rule before the slenderness cap and the count stretch existed. Small repos must stay within 5% of it. */
function legacyHeight(h: number): number {
  return Math.min(60, BASE + 2.4 * Math.pow(Math.max(0, h - BASE), 1.15))
}

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

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

describe('heightStretch', () => {
  it('is full up to the reference count, so small and mid-sized repos are not stretched down', () => {
    expect(heightStretch(1)).toBe(1)
    expect(heightStretch(300)).toBe(1)
    expect(heightStretch(STRETCH_REF_COUNT)).toBe(1)
  })

  it('falls with the square root of the building count above the reference', () => {
    expect(heightStretch(4 * STRETCH_REF_COUNT)).toBeCloseTo(0.5, 12)
    expect(heightStretch(20000)).toBeCloseTo(Math.sqrt(STRETCH_REF_COUNT / 20000), 12)
  })

  it('never increases with the building count', () => {
    let prev = Infinity
    for (let n = 1; n <= 50000; n += 37) {
      const s = heightStretch(n)
      expect(s).toBeLessThanOrEqual(prev)
      expect(s).toBeGreaterThan(0)
      prev = s
    }
  })
})

describe('towerHeight', () => {
  it('caps slenderness: height above the base is at most MAX_SLENDERNESS times the narrower footprint side', () => {
    for (const [w, d] of [[0.11, 42], [0.26, 0.9], [0.4, 0.4], [1, 3], [6, 9], [30, 30]] as const) {
      for (const stretch of [0.1, 0.5, 1]) {
        for (let h = 0.6; h <= 20; h += 0.25) {
          const v = towerHeight(h, w, d, stretch)
          expect(v - BASE).toBeLessThanOrEqual(MAX_SLENDERNESS * Math.min(w, d) + 1e-9)
          expect(v).toBeGreaterThanOrEqual(BASE - 1e-9)
        }
      }
    }
  })

  it('is monotonic in the layout height for equal footprints', () => {
    for (const stretch of [0.2, 0.6, 1]) {
      for (const [w, d] of [[0.5, 0.5], [2, 7], [12, 12]] as const) {
        let prev = -Infinity
        for (let h = 0.6; h <= 14; h += 0.02) {
          const v = towerHeight(h, w, d, stretch)
          expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
          prev = v
        }
      }
    }
  })

  it('is monotonic in the footprint for equal layout heights', () => {
    let prev = -Infinity
    for (let side = 0.1; side <= 30; side += 0.1) {
      const v = towerHeight(12, side, side, 1)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = v
    }
  })

  it('equals the legacy rule when nothing is capped and the stretch is full', () => {
    for (let h = 0.6; h <= 14; h += 0.1) {
      expect(towerHeight(h, 1000, 1000, 1)).toBeCloseTo(legacyHeight(h), 9)
    }
  })
})

describe('visHeight and visCenter', () => {

  it('uses the same height as towerHeight with the city stretch', () => {
    const layout = layoutOf(syntheticRepo(5000, 3))
    const s = heightStretch(layout.buildings.length)
    for (const b of layout.buildings.slice(0, 200)) {
      expect(visHeight(b, layout)).toBeCloseTo(towerHeight(b.h, b.w, b.d, s), 12)
    }
  })

  it('centers the building at half its rendered height', () => {
    const layout = layoutOf(syntheticRepo(400, 5))
    const b = layout.buildings[0]
    if (!b) throw new Error('empty layout')
    const c = visCenter(b, layout)
    expect(c.y).toBeCloseTo(visHeight(b, layout) / 2, 12)
    expect(c.x).toBeCloseTo(b.x + b.w / 2, 12)
    expect(c.z).toBeCloseTo(b.z + b.d / 2, 12)
  })
})

describe('small repos (<= 300 files)', () => {
  for (const seed of [1, 2, 3]) {
    it(`keeps heights within 5% of the current rule, except slivers the slenderness cap clips (seed ${seed})`, () => {
      const layout = layoutOf(syntheticRepo(300, seed))
      expect(layout.buildings.length).toBeLessThanOrEqual(300)
      let clipped = 0
      for (const b of layout.buildings) {
        const now = visHeight(b, layout)
        const before = legacyHeight(b.h)
        const cap = BASE + MAX_SLENDERNESS * Math.min(b.w, b.d)
        if (before > cap + 1e-9) {
          // A sliver the cap clips: it must land exactly on the cap, and only buildings above it may change.
          clipped++
          expect(now).toBeCloseTo(cap, 9)
        } else {
          expect(Math.abs(now - before) / before).toBeLessThanOrEqual(0.05 + 1e-9)
        }
      }
      expect(clipped / layout.buildings.length).toBeLessThan(0.1)
    })
  }
})

describe('big repos', () => {
  const layout = layoutOf(syntheticRepo(20000, 7))
  const heights = layout.buildings.map((b) => visHeight(b, layout)).sort((a, b) => a - b)

  it('reads as a low-rise city: the median building is short', () => {
    expect(percentile(heights, 0.5)).toBeLessThan(5)
  })

  it('still has a few real towers, where the footprint allows them', () => {
    expect(heights[heights.length - 1] ?? 0).toBeGreaterThan(15)
    const towers = heights.filter((h) => h > 15).length
    expect(towers).toBeGreaterThan(0)
    expect(towers / heights.length).toBeLessThan(0.02)
  })

  it('keeps every building inside the slenderness cap', () => {
    for (const b of layout.buildings) {
      expect(visHeight(b, layout) - BASE).toBeLessThanOrEqual(MAX_SLENDERNESS * Math.min(b.w, b.d) + 1e-9)
    }
  })
})
