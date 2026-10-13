import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { churnCounts, getHistory, listGitFiles, parseGitLog } from '../git'
import { scanRepo } from '../scan'
import { initRepo, makeTempDir, removeDir, writeFiles, git } from './git-fixture'

const H1 = 'a'.repeat(40)

describe('parseGitLog with a prefix', () => {
  it('rebases create lines to the opened folder and drops ones outside it', () => {
    const text = [
      `\x1e${H1}\x1f1700000000\x1fAlice\x1fAdd`,
      '',
      '3\t0\tsub/x.ts',
      '2\t0\tother/y.ts',
      ' create mode 100644 sub/x.ts',
      ' create mode 100644 sub/inner/z.ts',
      ' create mode 100644 other/y.ts',
      ''
    ].join('\n')
    const [commit] = parseGitLog(text, 'sub/')
    expect(commit.created).toEqual(['x.ts', 'inner/z.ts'])
  })

  it('keeps create paths unchanged at the repository top', () => {
    const text = `\x1e${H1}\x1f1\x1fA\x1fB\n\n create mode 100644 sub/x.ts\n`
    expect(parseGitLog(text)[0].created).toEqual(['sub/x.ts'])
  })
})

describe('git history opened at a subfolder of a repository', () => {
  const root = makeTempDir('git-subfolder')
  const sub = path.join(root, 'sub')

  beforeAll(() => {
    initRepo(root, {
      'sub/a.ts': 'one\n',
      'sub/inner/c.ts': 'c\n',
      'other/b.ts': 'b\n'
    }, 'first')
    writeFiles(root, { 'sub/a.ts': 'one\ntwo\n', 'other/b.ts': 'b2\n' })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'second')
  })
  afterAll(() => removeDir(root))

  it('reports file paths relative to the opened folder, the same base as the file list', async () => {
    const listed = await listGitFiles(sub)
    const commits = await getHistory(sub)
    expect(listed?.sort()).toEqual(['a.ts', 'inner/c.ts'])
    for (const c of commits) {
      for (const f of c.files) expect(listed).toContain(f.path)
    }
  })

  it('omits changes outside the opened folder but keeps the commits', async () => {
    const commits = await getHistory(sub)
    expect(commits.map((c) => c.subject)).toEqual(['second', 'first'])
    expect(commits[0].files).toEqual([{ path: 'a.ts', added: 1, removed: 0 }])
    expect(commits.flatMap((c) => c.files.map((f) => f.path))).not.toContain('other/b.ts')
  })

  it('rebases the creation list, so time-lapse creation matches the file list', async () => {
    const [, first] = await getHistory(sub)
    expect([...(first.created ?? [])].sort()).toEqual(['a.ts', 'inner/c.ts'])
  })

  it('gives each file in the subfolder its churn in the snapshot', async () => {
    const snap = await scanRepo(sub)
    const byPath = (p: string) => snap.files.find((f) => f.path === p)
    expect(snap.files.map((f) => f.path)).toEqual(['a.ts', 'inner/c.ts'])
    expect(byPath('a.ts')?.commits).toBe(2)
    expect(byPath('inner/c.ts')?.commits).toBe(1)
    expect(churnCounts(await getHistory(sub)).get('a.ts')).toBe(2)
  })

  it('still reads the whole repository when opened at the top', async () => {
    const commits = await getHistory(root)
    expect(commits[0].files.map((f) => f.path).sort()).toEqual(['other/b.ts', 'sub/a.ts'])
  })
})
