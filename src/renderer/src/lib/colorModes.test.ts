import { describe, expect, it } from 'vitest'
import { buildLayout, neighborhoodIndex } from '../../../shared/layout'
import type { FileNode, RepoSnapshot } from '../../../shared/types'
import { langFromPath, LANG_COLORS } from '../../../shared/lang'
import {
  AREA_PALETTE,
  buildColorPlan,
  COLOR_MODES,
  isColorMode,
  nextColorMode,
  percentileRanks,
  ROOT_SILVER,
  type ColorMode
} from './colorModes'

function file(path: string, extra: Partial<FileNode> = {}): FileNode {
  return { path, lang: langFromPath(path), loc: 40, bytes: 1000, mtime: 1_000, imports: [], ...extra }
}

/** Layout, neighborhoods and plan inputs for a list of files, built the way the store builds them. */
function setup(files: FileNode[], mode: ColorMode) {
  const snap: RepoSnapshot = { root: '/r', name: 'r', files, scannedAt: 0 }
  const layout = buildLayout(snap)
  const hoods = neighborhoodIndex(layout.buildings.map((b) => b.path))
  return { plan: buildColorPlan(mode, layout.buildings, files, hoods), hoods, layout }
}

const TREE: FileNode[] = [
  file('src/main/a.ts', { loc: 300, commits: 9, mtime: 5_000 }),
  file('src/main/b.ts', { loc: 120, commits: 2, mtime: 4_000 }),
  file('src/renderer/App.tsx', { loc: 500, commits: 1, mtime: 9_000 }),
  file('src/renderer/Ground.tsx', { loc: 80, commits: 4, mtime: 2_000 }),
  file('src/shared/lang.ts', { loc: 90, commits: 0, mtime: 1_000 }),
  file('docs/guide.md', { loc: 60, commits: 6, mtime: 7_000 }),
  file('README.md', { loc: 30, commits: 3, mtime: 3_000 })
]

describe('percentileRanks', () => {
  it('spreads distinct values from 0 to 1 by rank', () => {
    expect(percentileRanks([10, 20, 30])).toEqual([0, 0.5, 1])
    expect(percentileRanks([30, 10, 20])).toEqual([1, 0, 0.5])
  })

  it('gives tied values the mean of their positions', () => {
    expect(percentileRanks([1, 1, 2])).toEqual([0.25, 0.25, 1])
    expect(percentileRanks([5, 5, 5])).toEqual([0.5, 0.5, 0.5])
  })

  it('maps a single value to the middle', () => {
    expect(percentileRanks([42])).toEqual([0.5])
    expect(percentileRanks([])).toEqual([])
  })
})

describe('mode helpers', () => {
  it('cycles through every mode and back', () => {
    let m: ColorMode = 'area'
    const seen: ColorMode[] = []
    for (let i = 0; i < COLOR_MODES.length; i++) {
      seen.push(m)
      m = nextColorMode(m)
    }
    expect(seen).toEqual(['area', 'language', 'churn', 'age'])
    expect(m).toBe('area')
  })

  it('accepts only known modes', () => {
    expect(isColorMode('churn')).toBe(true)
    expect(isColorMode('rainbow')).toBe(false)
    expect(isColorMode(null)).toBe(false)
  })
})

describe('area mode', () => {
  it('gives root files the neutral silver and each neighborhood its own palette hue', () => {
    const { plan, hoods } = setup(TREE, 'area')
    expect(plan.colors.get('README.md')).toBe(ROOT_SILVER)
    expect(plan.colors.get('src/main/a.ts')).toBe(plan.areaColors.get('src/main'))
    expect(plan.colors.get('src/renderer/App.tsx')).toBe(plan.areaColors.get('src/renderer'))
    expect(hoods.chain).toEqual(['src'])

    const hues = [...plan.areaColors].filter(([k]) => k !== '').map(([, c]) => c)
    expect(new Set(hues).size).toBe(hues.length)
    for (const c of hues) expect(AREA_PALETTE).toContain(c)
  })

  it('gives the largest neighborhood the first palette hue', () => {
    const { plan, hoods } = setup(TREE, 'area')
    const largest = hoods.groups.find((g) => g.key !== '')?.key
    expect(largest).toBeDefined()
    expect(plan.areaColors.get(largest ?? '')).toBe(AREA_PALETTE[0])
  })

  it('wraps the palette when there are more neighborhoods than hues', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`d${String(i).padStart(2, '0')}/x.ts`))
    const { plan } = setup(files, 'area')
    const hues = [...plan.areaColors].filter(([k]) => k !== '').map(([, c]) => c)
    expect(hues.length).toBe(12)
    expect(hues[10]).toBe(AREA_PALETTE[0])
  })

  it('lists the top six neighborhoods by file count', () => {
    const files: FileNode[] = []
    for (let i = 0; i < 9; i++) files.push(file(`d${i}/a.ts`))
    files.push(file('d0/b.ts'), file('d0/c.ts'))
    const { plan } = setup(files, 'area')
    expect(plan.legend.length).toBe(6)
    expect(plan.legend[0]?.label).toBe('d0')
    expect(plan.legend[0]?.count).toBe(3)
    expect(plan.ramp).toBeNull()
  })
})

describe('language mode', () => {
  it('colors each building by its language and lists languages by count', () => {
    const { plan } = setup(TREE, 'language')
    expect(plan.colors.get('src/main/a.ts')).toBe(LANG_COLORS.ts)
    expect(plan.colors.get('docs/guide.md')).toBe(LANG_COLORS.md)
    expect(plan.legend[0]).toMatchObject({ label: 'TypeScript', count: 5 })
  })
})

describe('churn mode', () => {
  it('ramps the most-committed file to magenta and an untouched one to indigo', () => {
    const { plan } = setup(TREE, 'churn')
    expect(plan.colors.get('src/main/a.ts')).toBe('#E879F9')
    expect(plan.colors.get('src/shared/lang.ts')).toBe('#4338CA')
    expect(plan.legend[0]).toMatchObject({ key: 'src/main/a.ts', count: 9 })
    expect(plan.legend.every((e) => (e.count ?? 0) > 0)).toBe(true)
    expect(plan.ramp?.length).toBe(4)
  })

  it('says so when there is no git history', () => {
    const files = TREE.map((f) => ({ ...f, commits: undefined }))
    const { plan } = setup(files, 'churn')
    expect(plan.note).toMatch(/git history/i)
    expect(plan.legend).toEqual([])
    expect(plan.colors.get('src/main/a.ts')).toBe('#4338CA')
  })
})

describe('age mode', () => {
  it('brightens the most recently modified file and dims the oldest', () => {
    const { plan } = setup(TREE, 'age')
    expect(plan.colors.get('src/renderer/App.tsx')).toBe('#6CFFC2')
    expect(plan.colors.get('src/shared/lang.ts')).toBe('#2B3648')
    expect(plan.legend[0]).toMatchObject({ key: 'src/renderer/App.tsx', ts: 9_000 })
    expect(plan.legend.length).toBe(6)
    expect(plan.note).toBeNull()
  })
})
