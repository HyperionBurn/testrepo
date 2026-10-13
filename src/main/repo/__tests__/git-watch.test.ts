import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { GitWatcher, gitWatchTargets } from '../git-watch'

describe('gitWatchTargets', () => {
  it('names the files and folders that move when HEAD, a branch or the history changes', () => {
    expect(gitWatchTargets('/r/.git')).toEqual([
      path.join('/r/.git', 'HEAD'),
      path.join('/r/.git', 'packed-refs'),
      path.join('/r/.git', 'refs'),
      path.join('/r/.git', 'logs', 'HEAD')
    ])
  })
})

describe('GitWatcher', () => {
  let dir: string
  let gitDir: string
  let watcher: GitWatcher | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skyline-gitwatch-'))
    gitDir = path.join(dir, '.git')
    mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  })

  afterEach(async () => {
    await watcher?.stop()
    watcher = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits one change after a burst of writes, once the quiet period passes', async () => {
    watcher = new GitWatcher(gitDir, 200)
    let changes = 0
    watcher.on('change', () => changes++)
    await watcher.start()

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/b${i}\n`)
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 900))

    expect(changes).toBe(1)
  })

  it('reports a new branch ref', async () => {
    watcher = new GitWatcher(gitDir, 100)
    let changes = 0
    watcher.on('change', () => changes++)
    await watcher.start()

    writeFileSync(path.join(gitDir, 'refs', 'heads', 'feature'), 'a'.repeat(40) + '\n')
    await new Promise((r) => setTimeout(r, 800))

    expect(changes).toBeGreaterThanOrEqual(1)
  })
})
