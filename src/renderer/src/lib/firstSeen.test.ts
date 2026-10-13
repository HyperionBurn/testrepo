import { describe, expect, it } from 'vitest'
import type { GitCommit } from '../../../shared/types'
import { firstSeenByPath } from './firstSeen'

function commit(ts: number, files: string[], created?: string[]): GitCommit {
  return {
    hash: `h${ts}`,
    ts,
    author: 'dev',
    subject: `commit at ${ts}`,
    files: files.map((path) => ({ path, added: 1, removed: 0 })),
    created
  }
}

describe('firstSeenByPath', () => {
  it('places a file at the commit that creates it, not at a later modification', () => {
    // Newest first, as the main process sends it. old.ts existed before this window and is only modified in it.
    const seen = firstSeenByPath([
      commit(300, ['old.ts', 'new.ts'], []),
      commit(200, ['new.ts'], []),
      commit(100, ['old.ts', 'new.ts'], ['new.ts'])
    ])
    expect(seen['new.ts']).toBe(100)
    expect(seen['old.ts']).toBeUndefined()
  })

  it('uses the earliest creation when a file is created more than once', () => {
    expect(firstSeenByPath([commit(400, ['a.ts'], ['a.ts']), commit(100, ['a.ts'], ['a.ts'])])['a.ts']).toBe(100)
  })

  it('falls back to touches when creation data is absent', () => {
    expect(firstSeenByPath([commit(200, ['x.ts']), commit(100, ['x.ts'])])['x.ts']).toBe(100)
  })

  it('returns an empty map for no commits', () => {
    expect(firstSeenByPath([])).toEqual({})
  })
})
