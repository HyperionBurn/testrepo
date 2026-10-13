import { describe, expect, it } from 'vitest'
import { neighborhoodChain, neighborhoodIndex, neighborhoodOf, NEIGHBORHOOD_LEVELS } from '../layout'

describe('neighborhoodChain', () => {
  it('descends into a directory holding more than 70% of the files', () => {
    const paths = ['src/main/a.ts', 'src/main/b.ts', 'src/renderer/App.tsx', 'src/renderer/x/y.tsx', 'src/shared/t.ts', 'src/index.ts', 'docs/a.md', 'README.md']
    expect(neighborhoodChain(paths)).toEqual(['src'])
  })

  it('stays at the top level when no top-level directory dominates', () => {
    expect(neighborhoodChain(['a/x.ts', 'b/y.ts', 'c/z.ts', 'd/w.ts'])).toEqual([])
  })

  it('does not descend into a directory that would not split (flat folder)', () => {
    const flat = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']
    expect(neighborhoodChain(flat)).toEqual([])
    expect(neighborhoodIndex(flat).groups).toEqual([{ key: 'src', count: 5 }])
  })

  it('descends through nested dominant directories, at most NEIGHBORHOOD_LEVELS deep', () => {
    const paths = [
      'app/src/main/java/a/A.java', 'app/src/main/java/b/B.java', 'app/src/main/res/r.xml',
      'app/src/main/res/s.xml', 'app/src/main/java/c/C.java'
    ]
    const chain = neighborhoodChain(paths)
    expect(chain).toEqual(['app', 'app/src', 'app/src/main'])
    expect(chain.length).toBe(NEIGHBORHOOD_LEVELS)
    const idx = neighborhoodIndex(paths)
    expect(idx.keyOf.get('app/src/main/java/a/A.java')).toBe('app/src/main/java')
    expect(idx.keyOf.get('app/src/main/res/r.xml')).toBe('app/src/main/res')
  })

  it('keeps a dominant directory only while its files split into several neighborhoods', () => {
    // src holds 75% of the files and src/only holds 75% too, so the search descends twice. Keeping docs/
    // as its own neighborhood, the chain still splits the repo into two groups.
    const paths = ['src/only/a.ts', 'src/only/b.ts', 'src/only/c.ts', 'docs/x.md']
    expect(neighborhoodChain(paths)).toEqual(['src', 'src/only'])
  })

  it('returns an empty chain for an empty repo', () => {
    expect(neighborhoodChain([])).toEqual([])
  })
})

describe('neighborhoodOf', () => {
  it('keys files by the first directory below the chain, and root files to the empty key', () => {
    const chain = ['src']
    expect(neighborhoodOf('src/main/a.ts', chain)).toBe('src/main')
    expect(neighborhoodOf('src/main/deep/a.ts', chain)).toBe('src/main')
    expect(neighborhoodOf('src/index.ts', chain)).toBe('src')
    expect(neighborhoodOf('docs/a.md', chain)).toBe('docs')
    expect(neighborhoodOf('README.md', chain)).toBe('')
  })

  it('normalizes separators and a leading ./', () => {
    expect(neighborhoodOf('./src\\main\\a.ts', ['src'])).toBe('src/main')
    expect(neighborhoodOf('docs\\a.md', [])).toBe('docs')
  })

  it('keys every file to its top-level directory when the chain is empty', () => {
    expect(neighborhoodOf('a/b/c.ts', [])).toBe('a')
    expect(neighborhoodOf('c.ts', [])).toBe('')
  })
})

describe('neighborhoodIndex', () => {
  it('groups files by key, largest first, ties by key', () => {
    const paths = ['src/main/a.ts', 'src/main/b.ts', 'src/renderer/c.ts', 'src/renderer/d.ts', 'src/shared/e.ts', 'docs/a.md', 'README.md']
    const idx = neighborhoodIndex(paths)
    expect(idx.chain).toEqual(['src'])
    expect(idx.groups.map((g) => g.key)).toEqual(['src/main', 'src/renderer', '', 'docs', 'src/shared'])
    expect(idx.groups.map((g) => g.count)).toEqual([2, 2, 1, 1, 1])
  })

  it('counts each path once, however often it is listed', () => {
    const idx = neighborhoodIndex(['a/x.ts', 'a/x.ts', 'b/y.ts'])
    expect(idx.groups.reduce((n, g) => n + g.count, 0)).toBe(2)
  })

  it('handles an empty repo', () => {
    expect(neighborhoodIndex([])).toEqual({ chain: [], keyOf: new Map(), groups: [] })
  })
})
