// Repo snapshot: which files exist, their language, size, LOC, imports and churn.
import { promises as fsp, type Dirent, type Stats } from 'node:fs'
import * as path from 'node:path'
import { isProbablyBinary, langFromPath } from '../../shared/lang'
import type { FileNode, GitCommit, Lang, RepoSnapshot } from '../../shared/types'
import { churnCounts, currentBranch, getHistory, HISTORY_LIMIT, isGitIgnored, isGitRepo, listGitFiles } from './git'
import { extractImports, hasImportSupport } from './imports'
import { isIgnoredRel, toPosixRel } from './ignore'
import { resolveInside } from './paths'

export const MAX_FILE_BYTES = 1024 * 1024
const SCAN_CONCURRENCY = 32
const BINARY_SNIFF_BYTES = 8000

export interface ScanOptions {
  /** Reuse an already loaded history instead of running git log again. */
  history?: GitCommit[]
}

export interface ScanFileOptions {
  /** Every repo file known to the caller; import targets are resolved against it. Computed when omitted. */
  knownPaths?: ReadonlySet<string>
  /** Churn map to copy into FileNode.commits. */
  churn?: ReadonlyMap<string, number>
  /** Whether the repo is a git work tree; when true, git-ignored new files are skipped. */
  git?: boolean
}

interface Entry {
  rel: string
  lang: Lang
  bytes: number
  mtime: number
  loc: number
  content?: string
}

/** Full scan of a folder. Files are listed by git when possible, otherwise by walking the directory. */
export async function scanRepo(root: string, opts: ScanOptions = {}): Promise<RepoSnapshot> {
  const abs = path.resolve(root)
  const [listed, branch, history] = await Promise.all([
    listFiles(abs),
    currentBranch(abs),
    opts.history ? Promise.resolve(opts.history) : getHistory(abs, HISTORY_LIMIT)
  ])
  // Without history (no git, or no commits) churn is unknown, so FileNode.commits stays undefined.
  const churn = history.length > 0 ? churnCounts(history) : undefined
  const candidates = listed.filter((rel) => !isIgnoredRel(rel) && !isProbablyBinary(rel))

  const entries = (await mapLimit(candidates, SCAN_CONCURRENCY, (rel) => readEntry(abs, rel))).filter(
    (e): e is Entry => e !== null
  )
  const known = new Set(entries.map((e) => e.rel))

  const files: FileNode[] = entries.map((e) =>
    toNode(e, e.content !== undefined ? extractImports(e.rel, e.content, known) : [], churn)
  )
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    root: abs,
    name: path.basename(abs) || abs,
    branch,
    files,
    scannedAt: Date.now()
  }
}

/**
 * Re-reads one file for incremental updates. Returns null when the file is missing, a directory,
 * ignored, binary, too large, or outside the repo.
 */
export async function scanFile(root: string, rel: string, opts: ScanFileOptions = {}): Promise<FileNode | null> {
  const abs = path.resolve(root)
  let posixRel: string
  try {
    posixRel = toPosixRel(path.relative(abs, resolveInside(abs, rel)))
  } catch {
    return null
  }
  if (posixRel === '' || isIgnoredRel(posixRel) || isProbablyBinary(posixRel)) return null
  const entry = await readEntry(abs, posixRel)
  if (!entry) return null
  if (opts.git && !opts.knownPaths?.has(posixRel) && (await isGitIgnored(abs, posixRel))) return null

  const known = opts.knownPaths ?? new Set((await listFiles(abs)).filter((r) => !isIgnoredRel(r)))
  const imports = entry.content !== undefined ? extractImports(posixRel, entry.content, known) : []
  return toNode(entry, imports, opts.churn)
}

// ---- listing ---------------------------------------------------------------------

async function listFiles(abs: string): Promise<string[]> {
  if (await isGitRepo(abs)) {
    const fromGit = await listGitFiles(abs)
    if (fromGit) return fromGit
  }
  return walkFiles(abs)
}

/** Directory walk used outside git: skips ignored segments and symlinks (no loops, no escapes). */
async function walkFiles(abs: string): Promise<string[]> {
  const out: string[] = []
  const pending: string[] = ['']
  while (pending.length > 0) {
    const dirRel = pending.pop() as string
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(path.join(abs, dirRel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (!isIgnoredRel(d.name)) pending.push(rel)
      } else if (d.isFile()) {
        out.push(rel)
      }
    }
  }
  return out
}

// ---- per file ----------------------------------------------------------------------

/** Stats, reads and measures one file. Import-capable files keep their text for the import pass. */
async function readEntry(abs: string, rel: string): Promise<Entry | null> {
  const full = path.join(abs, ...rel.split('/'))
  let st: Stats
  try {
    st = await fsp.stat(full)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  let buf: Buffer
  try {
    buf = await fsp.readFile(full)
  } catch {
    return null
  }
  if (looksBinary(buf)) return null
  const lang = langFromPath(rel)
  return {
    rel,
    lang,
    bytes: buf.length,
    mtime: st.mtimeMs,
    loc: countLines(buf),
    content: hasImportSupport(lang) ? buf.toString('utf8') : undefined
  }
}

function toNode(e: Entry, imports: string[], churn: ReadonlyMap<string, number> | undefined): FileNode {
  const node: FileNode = { path: e.rel, lang: e.lang, loc: e.loc, bytes: e.bytes, mtime: e.mtime, imports }
  if (churn) node.commits = churn.get(e.rel) ?? 0
  return node
}

/** Lines: newline count, plus one when the last line has no trailing newline. Empty file: 0. */
export function countLines(buf: Buffer): number {
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
  if (buf.length > 0 && buf[buf.length - 1] !== 10) n++
  return n
}

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

/** Maps items with at most `limit` promises in flight. Results keep input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
