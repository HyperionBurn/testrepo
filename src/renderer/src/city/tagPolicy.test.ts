import { describe, expect, it } from 'vitest'
import { MAX_TAGS, selectTags, stackTags, type TagCandidate } from './tagPolicy'

function tag(id: string, over: Partial<TagCandidate> = {}): TagCandidate {
  return { id, status: 'running', sub: false, depth: 0.5, x: 400, y: 300, w: 160, h: 24, ...over }
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

describe('selectTags', () => {
  it('shows only active agents: idle and done tags are hidden', () => {
    const shown = selectTags([tag('a', { status: 'idle' }), tag('b', { status: 'done' }), tag('c', { status: 'editing' })])
    expect([...shown]).toEqual(['c'])
  })

  it('caps the tags at MAX_TAGS (four), keeping the nearest', () => {
    const cands = Array.from({ length: 9 }, (_, i) => tag(`t${i}`, { depth: i / 10 }))
    const shown = selectTags(cands)
    expect(shown.size).toBe(MAX_TAGS)
    expect(MAX_TAGS).toBe(4)
    expect(shown.has('t0')).toBe(true)
    expect(shown.has('t8')).toBe(false)
  })

  it('ranks primary agents before subagent escorts', () => {
    const shown = selectTags(
      [tag('esc1', { sub: true, depth: 0.1 }), tag('esc2', { sub: true, depth: 0.1 }), tag('main', { depth: 0.9 })],
      2
    )
    expect(shown.has('main')).toBe(true)
    expect(shown.size).toBe(2)
  })

  it('is stable for the same input', () => {
    const cands = [tag('b'), tag('a')]
    expect([...selectTags(cands)].sort()).toEqual([...selectTags([...cands].reverse())].sort())
  })
})

describe('stackTags', () => {
  it('leaves tags that do not overlap where they are', () => {
    const offs = stackTags([tag('a', { x: 100 }), tag('b', { x: 500 })], 4)
    expect(offs.size).toBe(0)
  })

  it('pushes overlapping tags apart so that no two overlap', () => {
    const cands = [tag('a'), tag('b', { y: 302 }), tag('c', { y: 304 }), tag('d', { y: 306 })]
    const offs = stackTags(cands, 4)
    const placed = cands.map((c) => ({ ...c, y: c.y + (offs.get(c.id) ?? 0) }))
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i]!, placed[j]!)).toBe(false)
      }
    }
    expect(offs.size).toBeGreaterThan(0)
  })

  it('keeps the gap between stacked tags', () => {
    const cands = [tag('a'), tag('b', { y: 300 })]
    const offs = stackTags(cands, 4)
    const b = { ...cands[1]!, y: 300 + (offs.get('b') ?? 0) }
    const a = cands[0]!
    expect(b.y - a.y).toBeGreaterThanOrEqual(a.h + 4)
  })
})
