// RepoSession lifecycle: disposal during init starts nothing, and the sorted snapshot is cached
// until the file set changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { RepoSnapshot } from '../../shared/types'
import { AgentHub } from '../agents/hub'
import { RepoSession } from '../session'
import { RepoWatcher } from '../repo/watch'
import { initRepo } from '../repo/__tests__/git-fixture'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('RepoSession disposal during init', () => {
  it('starts neither the watcher nor the agent hub when disposed before init finishes', async () => {
    const repo = tempDir('skyline-life-repo-')
    initRepo(repo, { 'src/a.ts': 'export const a = 1\n' })
    const homes = { claudeHome: tempDir('skyline-life-claude-'), codexHome: tempDir('skyline-life-codex-') }

    const hubStart = vi.spyOn(AgentHub.prototype, 'start')
    const watcherStart = vi.spyOn(RepoWatcher.prototype, 'start')
    const proto = RepoSession.prototype as unknown as { init: () => Promise<void> }
    const originalInit = proto.init
    let session: RepoSession | undefined
    vi.spyOn(proto, 'init').mockImplementation(function (this: RepoSession) {
      session = this
      return originalInit.call(this)
    })

    // open() calls init() synchronously, so the instance is captured before open() yields.
    const opened = RepoSession.open(repo, homes)
    session!.dispose()
    await opened

    expect(watcherStart).not.toHaveBeenCalled()
    expect(hubStart).not.toHaveBeenCalled()
  })
})

describe('RepoSession snapshot cache', () => {
  it('reuses the sorted file list until the file set changes', async () => {
    const repo = tempDir('skyline-cache-repo-')
    initRepo(repo, { 'src/b.ts': 'b\n', 'a.md': 'a\n' })
    const homes = { claudeHome: tempDir('skyline-cache-claude-'), codexHome: tempDir('skyline-cache-codex-') }
    const session = await RepoSession.open(repo, homes)
    try {
      const first = session.getSnapshot()
      const second = session.getSnapshot()
      expect(second.files.map((f) => f.path)).toEqual(['a.md', 'src/b.ts'])
      expect(second.files).not.toBe(first.files)
      expect(second.files[0]).toBe(first.files[0])

      writeFileSync(path.join(repo, 'src', 'c.ts'), 'c\n')
      const changed = await new Promise<RepoSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no repo event with the new file')), 10_000)
        session.on('repo', (snap: RepoSnapshot) => {
          if (!snap.files.some((f) => f.path === 'src/c.ts')) return
          clearTimeout(timer)
          resolve(snap)
        })
      })
      const third = session.getSnapshot()
      expect(third.files.map((f) => f.path)).toEqual(['a.md', 'src/b.ts', 'src/c.ts'])
      expect(third.files.map((f) => f.path)).toEqual(changed.files.map((f) => f.path))
      expect(third.files[0]).not.toBe(first.files[0])
    } finally {
      session.dispose()
    }
  })
})
