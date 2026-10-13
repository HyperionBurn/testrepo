import { mkdirSync, symlinkSync } from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { READ_LIMIT_BYTES, readRepoText } from '../read'
import { makeTempDir, removeDir, writeFiles } from './git-fixture'

describe('readRepoText', () => {
  const outside = makeTempDir('outside')
  const root = makeTempDir('readroot')
  let canSymlink = true

  beforeAll(() => {
    writeFiles(root, { 'src/a.ts': 'export const a = 1\n', '.git/config': 'secret\n', 'big.txt': 'x'.repeat(READ_LIMIT_BYTES + 500) })
    writeFiles(outside, { 'secret.txt': 'top secret\n' })
    mkdirSync(path.join(root, 'links'), { recursive: true })
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'links', 'escape.txt'))
    } catch {
      canSymlink = false // Windows without developer mode, for example
    }
  })
  afterAll(() => {
    removeDir(root)
    removeDir(outside)
  })

  it('reads a repo file', async () => {
    expect(await readRepoText(root, 'src/a.ts')).toBe('export const a = 1\n')
  })

  it('caps the read at 200KB', async () => {
    const text = await readRepoText(root, 'big.txt')
    expect(Buffer.byteLength(text)).toBe(READ_LIMIT_BYTES)
  })

  it('refuses traversal, git internals, folders and missing files', async () => {
    await expect(readRepoText(root, '../' + path.basename(outside) + '/secret.txt')).rejects.toThrow(/outside/)
    await expect(readRepoText(root, '.git/config')).rejects.toThrow(/Git internals/)
    await expect(readRepoText(root, 'src')).rejects.toThrow(/Not a file/)
    await expect(readRepoText(root, 'nope.ts')).rejects.toThrow()
  })

  it('refuses a symlink that resolves outside the repository', async () => {
    if (!canSymlink) return
    await expect(readRepoText(root, 'links/escape.txt')).rejects.toThrow(/outside the repository/)
  })
})
