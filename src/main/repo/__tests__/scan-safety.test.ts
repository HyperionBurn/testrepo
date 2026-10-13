import { symlinkSync } from 'node:fs'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_WALK_FILES, scanFile, scanRepo, walkFiles } from '../scan'
import { git, initRepo, makeTempDir, removeDir, writeFiles } from './git-fixture'

/** Makes a symlink, or returns false where the platform will not (Windows without developer mode). */
function link(target: string, at: string): boolean {
  try {
    symlinkSync(target, at)
    return true
  } catch {
    return false
  }
}

describe('scan refuses symlinks (git repository)', () => {
  const root = makeTempDir('scan-link-git')
  const outside = makeTempDir('scan-link-outside')
  let ok = true

  beforeAll(() => {
    writeFiles(outside, { 'secret.ts': 'export const secret = "outside"\n' })
    initRepo(root, { 'src/a.ts': 'export const a = 1\n' })
    // A symlink committed to the repo, and one left untracked. Both point outside the repo.
    ok = link(path.join(outside, 'secret.ts'), path.join(root, 'tracked-link.ts'))
    if (ok) git(root, 'add', 'tracked-link.ts')
    if (ok) git(root, 'commit', '-q', '-m', 'add link')
    ok = link(path.join(outside, 'secret.ts'), path.join(root, 'link.ts')) && ok
  })
  afterAll(() => {
    removeDir(root)
    removeDir(outside)
  })

  it('leaves symlinks out of the snapshot and keeps regular files', async () => {
    if (!ok) return
    const snap = await scanRepo(root)
    const paths = snap.files.map((f) => f.path)
    expect(paths).toContain('src/a.ts')
    expect(paths).not.toContain('tracked-link.ts')
    expect(paths).not.toContain('link.ts')
  })

  it('does not read a symlink through scanFile', async () => {
    if (!ok) return
    expect(await scanFile(root, 'link.ts')).toBeNull()
    expect(await scanFile(root, 'tracked-link.ts')).toBeNull()
    expect(await scanFile(root, 'src/a.ts')).not.toBeNull()
  })
})

describe('scan refuses symlinks (folder without git)', () => {
  const root = makeTempDir('scan-link-walk')
  const outside = makeTempDir('scan-link-walk-outside')
  let ok = true

  beforeAll(() => {
    writeFiles(root, { 'lib/util.ts': 'export {}\n', 'main.ts': "import './lib/util'\n", 'real.ts': 'export {}\n' })
    writeFiles(outside, { 'secret.ts': 'x\n', 'dir/nested.ts': 'y\n' })
    ok = link(path.join(outside, 'secret.ts'), path.join(root, 'link.ts'))
    ok = link(path.join(outside, 'dir'), path.join(root, 'linkdir')) && ok
    ok = link(path.join(root, 'real.ts'), path.join(root, 'alias.ts')) && ok
  })
  afterAll(() => {
    removeDir(root)
    removeDir(outside)
  })

  it('walks regular files only, without following a linked folder', async () => {
    if (!ok) return
    const snap = await scanRepo(root)
    expect(snap.files.map((f) => f.path)).toEqual(['lib/util.ts', 'main.ts', 'real.ts'])
    expect(snap.files.find((f) => f.path === 'main.ts')?.imports).toEqual(['lib/util.ts'])
  })

  it('refuses a symlink in scanFile even when the target is inside the folder', async () => {
    if (!ok) return
    expect(await scanFile(root, 'alias.ts', { knownPaths: new Set() })).toBeNull()
    expect(await scanFile(root, 'real.ts', { knownPaths: new Set() })).not.toBeNull()
  })
})

describe('walkFiles cap', () => {
  const root = makeTempDir('scan-walk-cap')
  beforeAll(() => {
    writeFiles(root, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`d/f${i}.txt`, 'x\n'])))
  })
  afterAll(() => removeDir(root))

  it('caps the default at 50k files', () => {
    expect(MAX_WALK_FILES).toBe(50_000)
  })

  it('stops at the limit and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const files = await walkFiles(root, 5)
      expect(files).toHaveLength(5)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/more than 5 files/)
    } finally {
      warn.mockRestore()
    }
  })

  it('lists everything under the limit without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await walkFiles(root, 8)).toHaveLength(8)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
