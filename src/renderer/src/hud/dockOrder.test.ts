import { describe, expect, it } from 'vitest'
import type { AgentInfo } from '../../../shared/types'
import { sortDockAgents } from './dockOrder'

const FS = 'fs'

function agent(id: string, lastActiveAt: number): AgentInfo {
  return {
    id,
    kind: 'unknown',
    name: id,
    cwd: '/repo',
    startedAt: 0,
    lastActiveAt,
    status: 'idle',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    filesTouched: [],
    edits: 0,
    reads: 0,
    commands: 0,
    color: '#fff'
  }
}

describe('sortDockAgents', () => {
  it('sorts real agents most recent first', () => {
    const out = sortDockAgents([agent('a', 1), agent('c', 3), agent('b', 2)], FS)
    expect(out.map((a) => a.id)).toEqual(['c', 'b', 'a'])
  })

  it('keeps the filesystem pseudo-agent last even when it is the most recently active', () => {
    const out = sortDockAgents([agent(FS, 99), agent('a', 1), agent('b', 5)], FS)
    expect(out.map((a) => a.id)).toEqual(['b', 'a', FS])
  })

  it('keeps it last on a tie in activity time', () => {
    const out = sortDockAgents([agent(FS, 5), agent('x', 5)], FS)
    expect(out.map((a) => a.id)).toEqual(['x', FS])
  })

  it('does not reorder or mutate its input', () => {
    const input = [agent(FS, 9), agent('a', 1)]
    const before = input.map((a) => a.id)
    sortDockAgents(input, FS)
    expect(input.map((a) => a.id)).toEqual(before)
  })
})
