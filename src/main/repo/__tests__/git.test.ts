import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { churnCounts, getHistory, isGitRepo, parseGitLog, unquoteGitPath } from '../git'
import { git, initRepo, makeTempDir, removeDir, writeFiles } from './git-fixture'

const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)

describe('parseGitLog', () => {
  it('parses headers, numstat rows and binary (-) entries as zero', () => {
    const text = [
      `\x1e${H1}\x1f1700000000\x1fAlice\x1fAdd things`,
      '',
      '3\t1\tsrc/a.ts',
      '-\t-\timg/logo.png',
      '',
      `\x1e${H2}\x1f1699990000\x1fBob\x1fFix: bug (#12)`,
      '',
      '0\t2\tsrc/a.ts',
      ''
    ].join('\n')
    const commits = parseGitLog(text)
    expect(commits).toEqual([
      {
        hash: H1,
        ts: 1700000000000,
        author: 'Alice',
        subject: 'Add things',
        files: [
          { path: 'src/a.ts', added: 3, removed: 1 },
          { path: 'img/logo.png', added: 0, removed: 0 }
        ],
        created: []
      },
      {
        hash: H2,
        ts: 1699990000000,
        author: 'Bob',
        subject: 'Fix: bug (#12)',
        files: [{ path: 'src/a.ts', added: 0, removed: 2 }],
        created: []
      }
    ])
  })

  it('reads the files a commit creates from --summary lines, and only those', () => {
    const text = [
      `\x1e${H1}\x1f1700000000\x1fAlice\x1fAdd things`,
      '',
      '10\t0\tsrc/new.ts',
      '1\t1\tsrc/old.ts',
      ' create mode 100644 src/new.ts',
      ' create mode 100644 "src/with space.ts"',
      ''
    ].join('\n')
    const [commit] = parseGitLog(text)
    expect(commit.created).toEqual(['src/new.ts', 'src/with space.ts'])
    expect(commit.files.map((f) => f.path)).toEqual(['src/new.ts', 'src/old.ts'])
  })

  it('keeps field separators that appear inside the subject', () => {
    const text = `\x1e${H1}\x1f1\x1fAlice\x1fpart one\x1fpart two\n`
    expect(parseGitLog(text)[0].subject).toBe('part one\x1fpart two')
  })

  it('returns an empty list for empty output and skips malformed records', () => {
    expect(parseGitLog('')).toEqual([])
    expect(parseGitLog('\x1enot-a-hash\x1f1\x1fX\x1fY\n')).toEqual([])
  })
})

describe('unquoteGitPath', () => {
  it('leaves plain paths alone', () => {
    expect(unquoteGitPath('src/a b.ts')).toBe('src/a b.ts')
  })
  it('decodes octal UTF-8 bytes and C escapes', () => {
    expect(unquoteGitPath('"caf\\303\\251.ts"')).toBe('café.ts')
    expect(unquoteGitPath('"say \\"hi\\".ts"')).toBe('say "hi".ts')
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there')
  })
})

describe('churnCounts', () => {
  it('counts commits per path, once per commit', () => {
    const counts = churnCounts([
      { hash: H1, ts: 0, author: '', subject: '', files: [{ path: 'a', added: 1, removed: 0 }, { path: 'a', added: 1, removed: 0 }] },
      { hash: H2, ts: 0, author: '', subject: '', files: [{ path: 'a', added: 0, removed: 1 }, { path: 'b', added: 1, removed: 0 }] }
    ])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
    expect(counts.has('c')).toBe(false)
  })
})

describe('getHistory against a real repository', () => {
  const root = makeTempDir('history')

  beforeAll(() => {
    initRepo(root, {
      'src/a.ts': 'one\ntwo\nthree\n',
      'src/b.ts': 'bye\n',
      'bin/data.dat': Buffer.from([0, 1, 2, 3, 0, 255]),
      'café.ts': 'x\n'
    }, 'first')
    writeFiles(root, { 'src/a.ts': 'one\ntwo\nthree\nfour\nfive\n' })
    git(root, 'rm', '-q', 'src/b.ts')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'second')
  })
  afterAll(() => removeDir(root))

  it('reports git repositories and not plain folders', async () => {
    expect(await isGitRepo(root)).toBe(true)
    expect(await isGitRepo(makeTempDir('plain'))).toBe(false)
  })

  it('returns commits newest first with per-file line counts', async () => {
    const commits = await getHistory(root)
    expect(commits.map((c) => c.subject)).toEqual(['second', 'first'])
    expect(commits[0].author).toBe('Skyline Test')
    expect(commits[0].ts).toBeGreaterThan(1_600_000_000_000)
    expect(commits[0].files).toEqual([
      { path: 'src/a.ts', added: 2, removed: 0 },
      { path: 'src/b.ts', added: 0, removed: 1 }
    ])
    const first = commits[1].files
    expect(first).toContainEqual({ path: 'bin/data.dat', added: 0, removed: 0 })
    expect(first).toContainEqual({ path: 'café.ts', added: 1, removed: 0 })
  })

  it('honours the limit', async () => {
    expect(await getHistory(root, 1)).toHaveLength(1)
  })

  it('builds churn from real history', async () => {
    const counts = churnCounts(await getHistory(root))
    expect(counts.get('src/a.ts')).toBe(2)
    expect(counts.get('src/b.ts')).toBe(2)
    expect(counts.get('bin/data.dat')).toBe(1)
  })

  it('returns no history for a folder without commits or git', async () => {
    const empty = makeTempDir('nocommits')
    try {
      git(empty, 'init', '-q')
      expect(await getHistory(empty)).toEqual([])
      expect(await getHistory(makeTempDir('nogit'))).toEqual([])
    } finally {
      removeDir(empty)
    }
  })
})
