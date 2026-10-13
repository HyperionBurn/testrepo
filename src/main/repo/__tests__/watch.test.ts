import { symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoWatcher, type FsChange } from '../watch'
import { makeTempDir, removeDir, writeFiles } from './git-fixture'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('RepoWatcher and symlinks', () => {
  const dirs: string[] = []
  let watcher: RepoWatcher | undefined

  afterEach(async () => {
    await watcher?.stop()
    watcher = undefined
    for (const d of dirs.splice(0)) removeDir(d)
  })

  it('reports ordinary edits but not writes that reach a file outside the repo through a symlink', async () => {
    const root = makeTempDir('watch-root')
    const outside = makeTempDir('watch-outside')
    dirs.push(root, outside)
    writeFiles(root, { 'src/a.ts': 'one\n' })
    const target = path.join(outside, 'secret.txt')
    writeFileSync(target, 'before\n')
    try {
      symlinkSync(target, path.join(root, 'link.txt'))
    } catch {
      return // Windows without developer mode cannot create the link
    }

    const seen: FsChange[] = []
    watcher = new RepoWatcher(root)
    watcher.on('change', (c: FsChange) => seen.push(c))
    watcher.start()
    await wait(400)

    // The watcher works: an ordinary edit inside the repo is reported.
    writeFileSync(path.join(root, 'src', 'a.ts'), 'two\n')
    for (let i = 0; i < 40 && !seen.some((c) => c.rel === 'src/a.ts'); i++) await wait(100)
    expect(seen.some((c) => c.rel === 'src/a.ts')).toBe(true)

    // The write lands on the outside file the link points at. It must not surface as a repo change.
    seen.length = 0
    writeFileSync(target, 'after\n')
    await wait(900)
    expect(seen.filter((c) => c.rel === 'link.txt')).toEqual([])
  })
})
