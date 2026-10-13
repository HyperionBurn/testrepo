// Test helper: builds throwaway repos under the OS temp dir. Not a test file (no .test. in the name).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `skyline-${prefix}-`))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=Skyline Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

/** Writes files (creating folders) relative to `root`. */
export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** Initializes a repo on branch `main` with the given files committed. */
export function initRepo(root: string, files: Record<string, string | Buffer>, message = 'init'): void {
  git(root, 'init', '-q', '-b', 'main')
  writeFiles(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}
