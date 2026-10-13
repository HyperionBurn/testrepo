import { describe, expect, it } from 'vitest'
import type { RecentSession } from '@shared/types'
import { groupByRepo } from './activity'

function session(kind: RecentSession['kind'], cwd: string, lastActiveAt: number, id = `${kind}-${lastActiveAt}`): RecentSession {
  return { kind, cwd, lastActiveAt, id }
}

describe('groupByRepo', () => {
  it('dedupes by working directory and keeps the newest activity', () => {
    const rows = groupByRepo([
      session('codex', '/work/app', 1_000),
      session('claude-code', '/work/app', 5_000),
      session('claude-code', '/work/app/', 3_000)
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ cwd: '/work/app', name: 'app', kinds: ['claude-code', 'codex'], lastActiveAt: 5_000, sessions: 3 })
  })

  it('orders directories newest first and caps the list', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session('claude-code', `/r/repo${i}`, i * 100))
    const rows = groupByRepo(sessions)
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => r.name)).toEqual(['repo8', 'repo7', 'repo6', 'repo5', 'repo4', 'repo3'])
  })

  it('names Windows folders by their last segment', () => {
    const [row] = groupByRepo([session('claude-code', 'C:\\dev\\skyline', 1)])
    expect(row?.name).toBe('skyline')
  })

  it('returns nothing for no sessions, and skips blank working directories', () => {
    expect(groupByRepo([])).toEqual([])
    expect(groupByRepo([session('codex', '   ', 1)])).toEqual([])
  })
})
