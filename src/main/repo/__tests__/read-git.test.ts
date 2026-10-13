import { mkdirSync, symlinkSync } from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasGitSegment, readRepoText } from '../read'
import { makeTempDir, removeDir, writeFiles } from './git-fixture'

describe('hasGitSegment', () => {
  it('matches .git as a whole segment only', () => {
    expect(hasGitSegment('.git/config', false)).toBe(true)
    expect(hasGitSegment('a/.git', false)).toBe(true)
    expect(hasGitSegment('a\\.git\\HEAD', false)).toBe(true)
    expect(hasGitSegment('.gitignore', false)).toBe(false)
    expect(hasGitSegment('src/git/x.ts', false)).toBe(false)
  })

  it('folds case on Windows only', () => {
    expect(hasGitSegment('.GIT/config', false)).toBe(false)
    expect(hasGitSegment('.GIT/config', true)).toBe(true)
  })
})

describe('readRepoText and .git (symlinks)', () => {
  const root = makeTempDir('read-git')
  let canSymlink = true

  beforeAll(() => {
    writeFiles(root, { 'src/a.ts': 'ok\n', '.git/config': '[remote "origin"]\n\turl = secret\n' })
    try {
      // A link inside the repo that points at git internals. Its own path looks harmless.
      mkdirSync(path.join(root, 'docs'), { recursive: true })
      symlinkSync(path.join(root, '.git', 'config'), path.join(root, 'docs', 'config.txt'))
      // A link to the .git folder itself: 'alias/config' has no .git segment lexically.
      symlinkSync(path.join(root, '.git'), path.join(root, 'alias'), 'dir')
    } catch {
      canSymlink = false // Windows without developer mode, for example
    }
  })
  afterAll(() => removeDir(root))

  it('still reads ordinary files', async () => {
    expect(await readRepoText(root, 'src/a.ts')).toBe('ok\n')
  })

  it('refuses a file symlink whose target is inside .git', async () => {
    if (!canSymlink) return
    await expect(readRepoText(root, 'docs/config.txt')).rejects.toThrow(/Git internals/)
  })

  it('refuses a path through a directory symlink into .git', async () => {
    if (!canSymlink) return
    await expect(readRepoText(root, 'alias/config')).rejects.toThrow(/Git internals/)
  })

  it('still refuses the direct .git path', async () => {
    await expect(readRepoText(root, '.git/config')).rejects.toThrow(/Git internals/)
  })
})
