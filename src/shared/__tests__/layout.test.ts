import { describe, expect, it } from 'vitest'
import {
  CITY_SIZE,
  buildLayout,
  buildingCenter,
  findBuilding,
  layoutBounds,
  squarify
} from '../layout'
import { LANG_COLORS, langFromPath } from '../lang'
import type { CityBuilding, CityDistrict, CityLayout, FileNode, RepoSnapshot } from '../types'

const EPS = 1e-6
const HALF = CITY_SIZE / 2

function fileNode(path: string, loc: number): FileNode {
  return { path, lang: langFromPath(path), loc, bytes: loc * 40, mtime: 0, imports: [] }
}

function snapshot(files: FileNode[]): RepoSnapshot {
  return { root: '/repo', name: 'repo', files, scannedAt: 0 }
}

/** A ~60 file repo with nested directories, a few root files and a few tiny or empty files. */
const FIXTURE_PATHS: readonly string[] = [
  'README.md', 'package.json', 'tsconfig.json', 'SPEC.md',
  'src/main/index.ts', 'src/main/ipc.ts', 'src/main/store.ts',
  'src/main/repo/scan.ts', 'src/main/repo/git.ts', 'src/main/repo/watch.ts', 'src/main/repo/imports.ts', 'src/main/repo/loc.ts',
  'src/main/agents/claude.ts', 'src/main/agents/codex.ts', 'src/main/agents/hub.ts', 'src/main/agents/dispatch.ts',
  'src/main/llm/local.ts', 'src/main/llm/prompt.ts', 'src/main/llm/digest.ts',
  'src/main/util/paths.ts', 'src/main/util/time.ts', 'src/main/util/debounce.ts', 'src/main/util/encoding.ts',
  'src/shared/types.ts', 'src/shared/ipc.ts', 'src/shared/layout.ts', 'src/shared/pricing.ts',
  'src/shared/lang.ts', 'src/shared/color.ts', 'src/shared/__tests__/layout.test.ts', 'src/shared/__tests__/pricing.test.ts',
  'src/preload/index.ts',
  'src/renderer/src/App.tsx', 'src/renderer/src/main.tsx', 'src/renderer/index.html',
  'src/renderer/src/state/store.ts',
  'src/renderer/src/city/City.tsx', 'src/renderer/src/city/Buildings.tsx', 'src/renderer/src/city/Drones.tsx',
  'src/renderer/src/city/Trails.tsx', 'src/renderer/src/city/Ground.tsx', 'src/renderer/src/city/Effects.tsx',
  'src/renderer/src/city/CameraRig.tsx',
  'src/renderer/src/hud/TitleBar.tsx', 'src/renderer/src/hud/AgentDock.tsx', 'src/renderer/src/hud/Inspector.tsx',
  'src/renderer/src/hud/Timeline.tsx', 'src/renderer/src/hud/CommandBar.tsx', 'src/renderer/src/hud/DigestCard.tsx',
  'src/renderer/src/styles/glass.css',
  'scripts/make-icon.mjs', 'scripts/release.sh',
  'resources/icon.png', '.github/workflows/ci.yml', 'electron.vite.config.ts',
  'docs/a/b/deep/notes.md'
]

/** Deterministic locs: a spread from empty files to ~900 lines. */
function fixtureFiles(): FileNode[] {
  return FIXTURE_PATHS.map((p, i) => fileNode(p, p.endsWith('.png') ? 0 : (i * 7919) % 900))
}

/** Every directory path (repo-relative) implied by the file paths, e.g. 'src', 'src/main', 'src/main/repo'. */
function dirPathsOf(paths: readonly string[]): Set<string> {
  const dirs = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

function ancestorDirs(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

function contains(outer: { x: number; z: number; w: number; d: number }, inner: { x: number; z: number; w: number; d: number }): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.z >= outer.z - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.z + inner.d <= outer.z + outer.d + EPS
  )
}

function overlapArea(a: CityBuilding, b: CityBuilding): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z)
  return ox > 0 && oz > 0 ? ox * oz : 0
}

/** Checks the invariants that must hold for any snapshot. */
function expectValidLayout(layout: CityLayout, files: readonly FileNode[]): void {
  const paths = files.map((f) => f.path)
  const langByPath = new Map(files.map((f) => [f.path, f.lang] as const))
  const districtByName = new Map<string, CityDistrict>()
  for (const d of layout.districts) districtByName.set(d.name, d)

  // Exactly one building per file.
  expect(layout.buildings.length).toBe(files.length)
  expect(new Set(layout.buildings.map((b) => b.path))).toEqual(new Set(paths))

  expect(layout.size).toBe(CITY_SIZE)
  for (const b of layout.buildings) {
    // Positive, finite footprints and heights.
    expect(b.w).toBeGreaterThan(0)
    expect(b.d).toBeGreaterThan(0)
    expect(Number.isFinite(b.x) && Number.isFinite(b.z) && Number.isFinite(b.h)).toBe(true)
    expect(b.h).toBeGreaterThan(0)

    // Inside the city square.
    expect(b.x).toBeGreaterThanOrEqual(-HALF - EPS)
    expect(b.z).toBeGreaterThanOrEqual(-HALF - EPS)
    expect(b.x + b.w).toBeLessThanOrEqual(HALF + EPS)
    expect(b.z + b.d).toBeLessThanOrEqual(HALF + EPS)

    // Inside every ancestor district (the city itself for root files).
    const ancestors = ancestorDirs(b.path)
    for (const dir of ancestors) {
      const district = districtByName.get(dir)
      expect(district, `district for ${dir}`).toBeDefined()
      if (district) expect(contains(district, b), `${b.path} inside ${dir}`).toBe(true)
    }

    // District tag and color.
    const top = ancestors[0] ?? ''
    expect(b.district).toBe(top)
    expect(b.lang).toBe(langByPath.get(b.path))
    expect(b.color).toBe(LANG_COLORS[b.lang])
  }

  // Districts: one per directory, depth = nesting level, nested inside their parent.
  expect(new Set(layout.districts.map((d) => d.name))).toEqual(dirPathsOf(paths))
  expect(layout.districts.length).toBe(dirPathsOf(paths).size)
  for (const d of layout.districts) {
    expect(d.depth).toBe(d.name.split('/').length)
    expect(d.w).toBeGreaterThan(0)
    expect(d.d).toBeGreaterThan(0)
    expect(contains({ x: -HALF, z: -HALF, w: CITY_SIZE, d: CITY_SIZE }, d)).toBe(true)
    const parentName = d.name.includes('/') ? d.name.slice(0, d.name.lastIndexOf('/')) : null
    if (parentName !== null) {
      const parent = districtByName.get(parentName)
      expect(parent).toBeDefined()
      if (parent) expect(contains(parent, d), `${d.name} inside ${parentName}`).toBe(true)
    }
  }
}

describe('buildLayout invariants (60-file nested repo)', () => {
  const files = fixtureFiles()
  const layout = buildLayout(snapshot(files))

  it('places every file inside the city, its districts and never on top of another building', () => {
    expectValidLayout(layout, files)
  })

  it('has no overlapping buildings anywhere (pairwise check)', () => {
    for (let i = 0; i < layout.buildings.length; i++) {
      for (let j = i + 1; j < layout.buildings.length; j++) {
        const a = layout.buildings[i]
        const b = layout.buildings[j]
        if (!a || !b) continue
        expect(overlapArea(a, b), `${a.path} vs ${b.path}`).toBeLessThanOrEqual(1e-9)
      }
    }
  })

  it('keeps sibling districts apart (no overlapping plates under the same parent)', () => {
    const groups = new Map<string, CityDistrict[]>()
    for (const d of layout.districts) {
      const parent = d.name.includes('/') ? d.name.slice(0, d.name.lastIndexOf('/')) : ''
      const list = groups.get(parent) ?? []
      list.push(d)
      groups.set(parent, list)
    }
    for (const siblings of groups.values()) {
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          const a = siblings[i]
          const b = siblings[j]
          if (!a || !b) continue
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
          const oz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z)
          expect(ox > EPS && oz > EPS, `${a.name} vs ${b.name}`).toBe(false)
        }
      }
    }
  })

  it('keeps every footprint at or above the 0.4 minimum', () => {
    for (const b of layout.buildings) {
      expect(Math.min(b.w, b.d)).toBeGreaterThanOrEqual(0.4 - EPS)
    }
  })

  it('scales building height with the spec formula', () => {
    for (const b of layout.buildings) {
      const loc = fixtureFiles().find((f) => f.path === b.path)?.loc ?? 0
      expect(b.h).toBeCloseTo(0.6 + 2.2 * Math.log2(1 + loc / 20), 10)
    }
  })

  it('tags root-level files with an empty district and nothing else', () => {
    const root = layout.buildings.filter((b) => !b.path.includes('/'))
    expect(root.map((b) => b.path).sort()).toEqual(
      ['README.md', 'SPEC.md', 'electron.vite.config.ts', 'package.json', 'tsconfig.json']
    )
    expect(root.every((b) => b.district === '')).toBe(true)
  })

  it('is deterministic for the same snapshot', () => {
    expect(buildLayout(snapshot(fixtureFiles()))).toEqual(layout)
  })

  it('finds buildings by path, normalizing separators and a leading ./', () => {
    const hit = findBuilding(layout, 'src/shared/layout.ts')
    expect(hit?.path).toBe('src/shared/layout.ts')
    expect(findBuilding(layout, './src\\shared\\layout.ts')).toBe(hit)
    expect(findBuilding(layout, 'nope/missing.ts')).toBeUndefined()
  })

  it('reports the footprint center and the city bounds', () => {
    const b = findBuilding(layout, 'src/main/index.ts')
    if (!b) throw new Error('missing building')
    const c = buildingCenter(b)
    expect(c.x).toBeCloseTo(b.x + b.w / 2, 12)
    expect(c.z).toBeCloseTo(b.z + b.d / 2, 12)
    expect(c.y).toBeCloseTo(b.h / 2, 12)
    expect(layoutBounds(layout)).toEqual({ minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF, size: CITY_SIZE })
  })
})

describe('buildLayout edge cases', () => {
  it('handles an empty repo', () => {
    const layout = buildLayout(snapshot([]))
    expect(layout).toEqual({ buildings: [], districts: [], size: CITY_SIZE })
  })

  it('gives a single root file one building covering most of the city', () => {
    const files = [fileNode('index.ts', 120)]
    const layout = buildLayout(snapshot(files))
    expectValidLayout(layout, files)
    const b = layout.buildings[0]
    if (!b) throw new Error('missing building')
    expect(b.district).toBe('')
    expect(b.w * b.d).toBeGreaterThan(CITY_SIZE * CITY_SIZE * 0.4)
  })

  it('treats zero-loc and negative-loc files as the minimum weight', () => {
    const files = [fileNode('a.ts', 0), fileNode('b.ts', -40), fileNode('c.ts', Number.NaN), fileNode('d.ts', 5000)]
    const layout = buildLayout(snapshot(files))
    expectValidLayout(layout, files)
    const a = findBuilding(layout, 'a.ts')
    const d = findBuilding(layout, 'd.ts')
    if (!a || !d) throw new Error('missing building')
    expect(a.h).toBeCloseTo(0.6, 10)
    expect(d.w * d.d).toBeGreaterThan(a.w * a.d)
  })

  it('ignores duplicate paths and normalizes them to one building', () => {
    const files = [fileNode('src/a.ts', 10), fileNode('src\\a.ts', 99), fileNode('./src/b.ts', 10)]
    const layout = buildLayout(snapshot(files))
    expect(layout.buildings.map((b) => b.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('keeps sizes positive and inside bounds for very skewed weights', () => {
    const files: FileNode[] = [fileNode('huge/mega.ts', 1_000_000)]
    for (let i = 0; i < 300; i++) files.push(fileNode(`tiny/f${String(i).padStart(3, '0')}.ts`, 0))
    const layout = buildLayout(snapshot(files))
    expectValidLayout(layout, files)
  })
})

describe('squarify', () => {
  it('partitions the rect exactly, in order', () => {
    const rect = { x: 0, z: 0, w: 10, d: 4 }
    const values = [5, 3, 2, 1, 1]
    const cells = squarify(values, rect)
    expect(cells).toHaveLength(values.length)
    const total = cells.reduce((s, c) => s + c.w * c.d, 0)
    expect(total).toBeCloseTo(40, 9)
    values.forEach((v, i) => {
      const c = cells[i]
      expect(c).toBeDefined()
      if (c) expect(c.w * c.d).toBeCloseTo((v / 12) * 40, 6)
    })
  })

  it('returns an empty list for no values', () => {
    expect(squarify([], { x: 0, z: 0, w: 1, d: 1 })).toEqual([])
  })
})

describe('buildLayout performance', () => {
  it('lays out 20,000 files in under 300ms', () => {
    let seed = 0x9e3779b9
    const rand = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x100000000
    }
    const exts = ['ts', 'tsx', 'py', 'md', 'json', 'css', 'rs']
    const files: FileNode[] = []
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        for (let c = 0; c < 20; c++) {
          for (let d = 0; d < 10; d++) {
            const ext = exts[(a + b + c + d) % exts.length] ?? 'ts'
            const path = `pkg${a}/mod${b}/sub${c}/file${d}.${ext}`
            files.push(fileNode(path, Math.floor(rand() * 1200)))
          }
        }
      }
    }
    expect(files).toHaveLength(20_000)

    const t0 = performance.now()
    const layout = buildLayout(snapshot(files))
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(300)
    expect(layout.buildings).toHaveLength(20_000)
    // Spot-check containment on the big layout (the pairwise overlap check is too slow at this size).
    const districtByName = new Map(layout.districts.map((d) => [d.name, d] as const))
    let bad = 0
    for (const b of layout.buildings) {
      const pkg = districtByName.get(ancestorDirs(b.path)[0] ?? '')
      if (!(b.w > 0 && b.d > 0) || !pkg || !contains(pkg, b)) bad++
    }
    expect(bad).toBe(0)
  }, 30_000)
})
