import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countLines, MAX_FILE_BYTES, scanFile, scanRepo } from '../scan'
import { git, initRepo, makeTempDir, removeDir, writeFiles } from './git-fixture'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('countLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['\n\n', 2]
  ])('counts %j as %i', (text, expected) => {
    expect(countLines(Buffer.from(text, 'utf8'))).toBe(expected)
  })
})

describe('scanRepo on a git repository', () => {
  const root = makeTempDir('scan-git')
  let snap: Awaited<ReturnType<typeof scanRepo>>

  beforeAll(async () => {
    initRepo(root, {
      '.gitignore': 'secret.env\n',
      'src/index.ts': "import { util } from './util'\nimport lib from './lib/index'\nexport const x = 1\n",
      'src/util.ts': 'export function util() {\n  return 1\n}\n',
      'src/lib/index.ts': 'export default 2',
      'src/app.py': 'import os\nfrom . import helper\n',
      'src/helper.py': 'x = 1\n',
      'styles/base.css': 'a {}\n',
      'styles/main.css': "@import './base.css';\nbody { color: red }\n",
      'dist/bundle.js': 'var x = 1\n',
      'logo.png': PNG_HEADER
    })
    writeFiles(root, {
      'src/util.ts': 'export function util() {\n  return 2\n}\n',
      'node_modules/pkg/index.js': 'module.exports = 1\n',
      'secret.env': 'TOKEN=1\n',
      'big.txt': Buffer.alloc(MAX_FILE_BYTES + 1, 'a'),
      'untracked.ts': 'export {}\n'
    })
    git(root, 'add', 'src/util.ts')
    git(root, 'commit', '-q', '-m', 'touch util')
    snap = await scanRepo(root)
  })
  afterAll(() => removeDir(root))

  const byPath = (p: string) => snap.files.find((f) => f.path === p)

  it('reports root name, branch and a scan timestamp', () => {
    expect(snap.root).toBe(path.resolve(root))
    expect(snap.name).toBe(path.basename(path.resolve(root)))
    expect(snap.branch).toBe('main')
    expect(snap.scannedAt).toBeGreaterThan(0)
  })

  it('lists tracked and untracked files but skips ignored, binary, oversized and git-ignored ones', () => {
    const paths = snap.files.map((f) => f.path)
    expect(paths).toEqual([
      '.gitignore',
      'src/app.py',
      'src/helper.py',
      'src/index.ts',
      'src/lib/index.ts',
      'src/util.ts',
      'styles/base.css',
      'styles/main.css',
      'untracked.ts'
    ])
    expect(paths.some((p) => p.startsWith('node_modules') || p.startsWith('dist/'))).toBe(false)
    expect(paths).not.toContain('logo.png')
    expect(paths).not.toContain('secret.env')
    expect(paths).not.toContain('big.txt')
  })

  it('computes language, bytes, loc and mtime', () => {
    expect(byPath('src/index.ts')).toMatchObject({ lang: 'ts', loc: 3, bytes: 79, imports: ['src/lib/index.ts', 'src/util.ts'] })
    expect(byPath('src/lib/index.ts')).toMatchObject({ lang: 'ts', loc: 1 })
    expect(byPath('src/app.py')).toMatchObject({ lang: 'py', loc: 2 })
    expect(byPath('styles/main.css')).toMatchObject({ lang: 'css', loc: 2 })
    expect(byPath('.gitignore')).toMatchObject({ lang: 'other' })
    expect(byPath('src/util.ts')?.mtime).toBeGreaterThan(0)
  })

  it('resolves imports between files', () => {
    expect(byPath('src/app.py')?.imports).toEqual(['src/helper.py'])
    expect(byPath('styles/main.css')?.imports).toEqual(['styles/base.css'])
    expect(byPath('src/util.ts')?.imports).toEqual([])
  })

  it('fills churn from git history', () => {
    expect(byPath('src/util.ts')?.commits).toBe(2)
    expect(byPath('src/index.ts')?.commits).toBe(1)
    expect(byPath('untracked.ts')?.commits).toBe(0)
  })

  it('uses supplied history for churn instead of running git log again', async () => {
    const fake = [{ hash: 'c'.repeat(40), ts: 0, author: '', subject: '', files: [{ path: 'src/util.ts', added: 1, removed: 0 }] }]
    const again = await scanRepo(root, { history: fake })
    expect(again.files.find((f) => f.path === 'src/util.ts')?.commits).toBe(1)
    expect(again.files.find((f) => f.path === 'src/index.ts')?.commits).toBe(0)
  })
})

describe('scanFile', () => {
  const root = makeTempDir('scan-file')
  beforeAll(() => {
    initRepo(root, { 'src/a.ts': "import b from './b'\n", 'src/b.ts': 'export default 1\n', '.gitignore': '*.env\n' })
  })
  afterAll(() => removeDir(root))

  it('re-reads one file with imports resolved against the known set', async () => {
    const node = await scanFile(root, 'src/a.ts', {
      knownPaths: new Set(['src/a.ts', 'src/b.ts']),
      churn: new Map([['src/a.ts', 4]])
    })
    expect(node).toMatchObject({ path: 'src/a.ts', lang: 'ts', loc: 1, imports: ['src/b.ts'], commits: 4 })
  })

  it('returns a node for a new, untracked file', async () => {
    writeFiles(root, { 'src/new.ts': "import a from './a'\n" })
    const node = await scanFile(root, 'src/new.ts', { knownPaths: new Set(['src/a.ts', 'src/b.ts']), git: true })
    expect(node?.imports).toEqual(['src/a.ts'])
  })

  it('returns null for missing, ignored, binary, outside and git-ignored paths', async () => {
    writeFiles(root, { 'node_modules/x/index.js': 'x\n', 'img.png': PNG_HEADER, 'local.env': 'A=1\n' })
    expect(await scanFile(root, 'src/missing.ts')).toBeNull()
    expect(await scanFile(root, 'node_modules/x/index.js')).toBeNull()
    expect(await scanFile(root, 'img.png')).toBeNull()
    expect(await scanFile(root, '../outside.ts')).toBeNull()
    expect(await scanFile(root, 'src', { knownPaths: new Set() })).toBeNull()
    expect(await scanFile(root, 'local.env', { git: true, knownPaths: new Set() })).toBeNull()
  })
})

describe('scanRepo outside git', () => {
  const root = makeTempDir('scan-walk')
  beforeAll(() => {
    writeFiles(root, {
      'main.go': 'package main\n',
      'lib/util.rs': 'pub fn f() {}\n',
      'lib/nested/deep.md': '# hi\n',
      'build/out.js': 'x\n',
      '.git/config': '[core]\n',
      '.skyline/worktrees/abc/src/x.ts': 'x\n'
    })
  })
  afterAll(() => removeDir(root))

  it('walks the folder, skipping ignored directories', async () => {
    const snap = await scanRepo(root)
    expect(snap.branch).toBeUndefined()
    expect(snap.files.map((f) => f.path)).toEqual(['lib/nested/deep.md', 'lib/util.rs', 'main.go'])
    expect(snap.files.find((f) => f.path === 'main.go')).toMatchObject({ lang: 'go', loc: 1 })
    expect(snap.files.find((f) => f.path === 'main.go')?.commits).toBeUndefined()
  })
})
