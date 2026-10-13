// RepoSession end to end on a throwaway git repo: commits made outside Skyline refresh history,
// churn counts and the 'repo' snapshot.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GitCommit, RepoSnapshot } from '../../shared/types'
import { RepoSession } from '../session'
import { git, initRepo } from '../repo/__tests__/git-fixture'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'skyline-session-'))
  dirs.push(dir)
  return dir
}

function waitForEvent<T>(subscribe: (cb: (v: T) => void) => void, ready: (v: T) => boolean, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for event')), ms)
    subscribe((v: T) => {
      if (!ready(v)) return
      clearTimeout(timer)
      resolve(v)
    })
  })
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('RepoSession live git refresh', () => {
  it('emits history and repo with fresh churn after a commit made outside Skyline', async () => {
    const base = tempRoot()
    const repo = path.join(base, 'repo')
    mkdirSync(repo)
    initRepo(repo, { 'src/a.ts': 'export const a = 1\n', 'README.md': '# demo\n' })
    const claudeHome = path.join(base, 'claude')
    const codexHome = path.join(base, 'codex')

    const session = await RepoSession.open(repo, { claudeHome, codexHome })
    try {
      // The city opens on the scan; git history and churn follow in the background.
      const deadline = Date.now() + 10_000
      while ((await session.getHistory()).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect((await session.getHistory()).length).toBe(1)
      expect(session.getSnapshot().files.find((f) => f.path === 'src/a.ts')?.commits).toBe(1)

      // A second commit touches src/a.ts; this happens outside Skyline, so only the git watcher sees it.
      writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 2\n')
      git(repo, 'commit', '-q', '-am', 'bump a')

      const history = await waitForEvent<GitCommit[]>(
        (cb) => session.on('history', cb),
        (c) => c.length === 2
      )
      expect(history.map((c) => c.subject)).toEqual(['bump a', 'init'])

      const snap = await waitForEvent<RepoSnapshot>(
        (cb) => session.on('repo', cb),
        (s) => s.files.find((f) => f.path === 'src/a.ts')?.commits === 2
      )
      expect(snap.files.find((f) => f.path === 'README.md')?.commits).toBe(1)
    } finally {
      session.dispose()
    }
  }, 30_000)
})
