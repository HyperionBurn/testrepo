// Git access through the `git` CLI. Every call degrades to null/[] when git is missing or the
// folder is not a repository, so callers can fall back to a directory walk.
import { execFile } from 'node:child_process'
import * as path from 'node:path'
import type { GitCommit } from '../../shared/types'

export const HISTORY_LIMIT = 1500
const MAX_BUFFER = 512 * 1024 * 1024
const RECORD_SEP = '\x1e'
const FIELD_SEP = '\x1f'

/** Runs `git -C cwd ...`; resolves stdout, or null on any failure (missing git, not a repo, non-zero exit). */
export function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

export async function isGitRepo(root: string): Promise<boolean> {
  return (await runGit(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
}

/** Absolute path of the git dir: `.git`, or the target of a worktree's `.git` file. Undefined outside a repo. */
export async function gitDirOf(root: string): Promise<string | undefined> {
  const out = (await runGit(root, ['rev-parse', '--git-dir']))?.trim()
  return out ? path.resolve(root, out) : undefined
}

/** Current branch name, or undefined (detached HEAD prints 'HEAD'; unborn branches fall back to symbolic-ref). */
export async function currentBranch(root: string): Promise<string | undefined> {
  const abbrev = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (abbrev) return abbrev
  return (await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || undefined
}

/** Tracked plus untracked-but-not-ignored files, forward-slash and repo-relative. Null when not a repo. */
export async function listGitFiles(root: string): Promise<string[] | null> {
  const out = await runGit(root, ['ls-files', '-co', '--exclude-standard', '-z'])
  if (out === null) return null
  return out.split('\0').filter((p) => p !== '')
}

/** True when git's ignore rules exclude an untracked path. Any failure reads as "not ignored". */
export function isGitIgnored(root: string, rel: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'check-ignore', '-q', '--', rel],
      { windowsHide: true },
      (err) => resolve(err === null)
    )
  })
}

/**
 * Commit history, newest first, with per-file numstat. Binary files (numstat '-') count as 0 lines.
 * Timestamps are epoch milliseconds.
 */
export async function getHistory(root: string, limit = HISTORY_LIMIT): Promise<GitCommit[]> {
  const out = await runGit(root, [
    'log',
    '--numstat',
    '--no-renames',
    '--format=%x1e%H%x1f%at%x1f%an%x1f%s',
    `--max-count=${Math.max(1, Math.floor(limit))}`
  ])
  return out === null ? [] : parseGitLog(out)
}

/** Parses the output of the `git log` command used by getHistory. Pure; exported for tests. */
export function parseGitLog(text: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of text.split(RECORD_SEP)) {
    const lines = record.split('\n').map((l) => l.replace(/\r$/, ''))
    const headerIdx = lines.findIndex((l) => l.trim() !== '')
    if (headerIdx === -1) continue
    const fields = lines[headerIdx].split(FIELD_SEP)
    if (fields.length < 4) continue
    const [hash, at, author, ...subjectParts] = fields
    if (!/^[0-9a-f]{7,64}$/.test(hash)) continue
    const seconds = Number(at)
    const files: GitCommit['files'] = []
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(lines[i])
      if (!m) continue
      files.push({
        path: unquoteGitPath(m[3]),
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2])
      })
    }
    commits.push({
      hash,
      ts: Number.isFinite(seconds) ? seconds * 1000 : 0,
      author,
      subject: subjectParts.join(FIELD_SEP),
      files
    })
  }
  return commits
}

/** Number of commits touching each path (a commit counts once per path). */
export function churnCounts(commits: readonly GitCommit[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const c of commits) {
    const seen = new Set<string>()
    for (const f of c.files) {
      if (seen.has(f.path)) continue
      seen.add(f.path)
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1)
    }
  }
  return counts
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92
}

/**
 * git quotes paths with unusual bytes as "...", using C escapes and octal bytes for UTF-8.
 * Unquoted paths are returned unchanged.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p
  const body = p.slice(1, -1)
  let out = ''
  let bytes: number[] = []
  const flush = (): void => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8')
      bytes = []
    }
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      flush()
      out += ch
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
      continue
    }
    const next = body[i + 1]
    flush()
    if (next !== undefined && next in ESCAPES) {
      out += String.fromCharCode(ESCAPES[next])
    } else if (next !== undefined) {
      out += next
    }
    i += 1
  }
  flush()
  return out
}
