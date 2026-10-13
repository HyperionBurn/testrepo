// Finds agent transcripts on this machine. Reads only file names, modification times and the first
// lines of each file (cwd and session id), never whole transcripts. Used by dispatch to learn the
// Codex session id of a run, and by listRecentSessions for the Welcome screen.
import { promises as fsp, type Dirent } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentKind, RecentSession } from '../../shared/types'
import { mainCheckoutOf } from './common'

const DAY_MS = 86_400_000
const HEADER_BYTES = 64 * 1024
const HEADER_LINES = 20

export const RECENT_MAX_AGE_DAYS = 7
export const RECENT_LIMIT = 200

export interface SessionHeader {
  cwd?: string
  id?: string
}

/** Local and UTC day folders (`sessions/YYYY/MM/DD`) for the given instants. Codex has used both. */
export function codexDayDirs(codexHome: string, instants: readonly Date[]): string[] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const root = path.join(codexHome, 'sessions')
  const out = new Set<string>()
  for (const d of instants) {
    out.add(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    out.add(path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  return [...out]
}

/** Working directory and session id from the first lines of a transcript. Never throws. */
export async function readSessionHeader(file: string, kind: AgentKind): Promise<SessionHeader> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0)
    let lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // A full buffer may end mid-line; that partial line is dropped.
    if (bytesRead === HEADER_BYTES) lines = lines.slice(0, -1)
    for (const line of lines.slice(0, HEADER_LINES)) {
      const header = headerOfLine(line, kind)
      if (header) return header
    }
  } catch {
    /* unreadable: no header */
  } finally {
    await fh?.close().catch(() => undefined)
  }
  return {}
}

/**
 * Codex: the rollout file that a run started at `sinceMs` in `cwd` wrote. Looks at today's and
 * yesterday's day folders, skips files in `claimed`, and returns the earliest-modified match.
 * Two runs started in the same folder at the same moment can be confused; the claimed set keeps
 * one run from taking another run's file.
 */
export async function findCodexRollout(
  codexHome: string,
  cwd: string,
  sinceMs: number,
  claimed: ReadonlySet<string> = new Set()
): Promise<{ file: string; id: string } | undefined> {
  const want = await canonicalDir(cwd)
  const hits: Array<{ file: string; id: string; mtime: number }> = []
  for (const dir of codexDayDirs(codexHome, [new Date(sinceMs), new Date()])) {
    for (const entry of await dirEntries(dir)) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
      const file = path.join(dir, entry.name)
      if (claimed.has(file)) continue
      const mtime = await mtimeOf(file)
      if (mtime === undefined || mtime < sinceMs) continue
      const header = await readSessionHeader(file, 'codex')
      if (!header.id || !header.cwd) continue
      if ((await canonicalDir(header.cwd)) !== want) continue
      hits.push({ file, id: header.id, mtime })
    }
  }
  hits.sort((a, b) => a.mtime - b.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const first = hits[0]
  return first ? { file: first.file, id: first.id } : undefined
}

export interface RecentSessionsOptions {
  claudeHome?: string
  codexHome?: string
  /** Reference time in ms. Default: now. */
  now?: number
  /** Default RECENT_MAX_AGE_DAYS. */
  maxAgeDays?: number
  /** Default RECENT_LIMIT. */
  limit?: number
}

interface Candidate {
  file: string
  kind: AgentKind
  name: string
  mtime: number
}

/**
 * Agent sessions modified in the last few days, across every repo on this machine, newest first.
 * Claude Code top-level transcripts and Codex rollouts. A session counts only when its header names
 * a working directory that still exists. A cwd inside a Skyline worktree is reported as its main
 * checkout. Capped at `limit` sessions.
 */
export async function listRecentSessions(opts: RecentSessionsOptions = {}): Promise<RecentSession[]> {
  const now = opts.now ?? Date.now()
  const maxAgeDays = opts.maxAgeDays ?? RECENT_MAX_AGE_DAYS
  const limit = opts.limit ?? RECENT_LIMIT
  const cutoff = now - maxAgeDays * DAY_MS
  const claudeHome = opts.claudeHome ?? path.join(os.homedir(), '.claude')
  const codexHome = opts.codexHome ?? path.join(os.homedir(), '.codex')

  const candidates: Candidate[] = []
  // <claudeHome>/projects/<encoded cwd>/<session>.jsonl. Subagent transcripts are not listed.
  const projects = path.join(claudeHome, 'projects')
  for (const project of await dirEntries(projects)) {
    if (!project.isDirectory()) continue
    await collect(path.join(projects, project.name), 'claude-code', (n) => n.endsWith('.jsonl'), cutoff, candidates)
  }
  // <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl, for each day inside the window.
  const days = Array.from({ length: Math.ceil(maxAgeDays) + 1 }, (_, i) => new Date(now - i * DAY_MS))
  for (const dir of codexDayDirs(codexHome, days)) {
    await collect(dir, 'codex', (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), cutoff, candidates)
  }

  candidates.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const dirExists = new Map<string, boolean>()
  const out: RecentSession[] = []
  for (const c of candidates) {
    if (out.length >= limit) break
    const header = await readSessionHeader(c.file, c.kind)
    if (!header.cwd) continue
    const cwd = mainCheckoutOf(header.cwd)
    if (!(await isDirectory(cwd, dirExists))) continue
    out.push({ kind: c.kind, cwd, lastActiveAt: Math.floor(c.mtime), id: header.id ?? c.name })
  }
  return out
}

// ---- helpers --------------------------------------------------------------------------------

function headerOfLine(line: string, kind: AgentKind): SessionHeader | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const rec = parsed as Record<string, unknown>
  if (kind === 'codex') {
    if (rec.type !== 'session_meta') return undefined
    const payload = rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : {}
    return headerOf(payload.cwd, payload.id)
  }
  return headerOf(rec.cwd, rec.sessionId)
}

function headerOf(cwd: unknown, id: unknown): SessionHeader | undefined {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  return { cwd, id: typeof id === 'string' && id !== '' ? id : undefined }
}

async function dirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function mtimeOf(file: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).mtimeMs
  } catch {
    return undefined
  }
}

/** Adds the files of `dir` that pass `accept` and were modified at or after `cutoff`. */
async function collect(
  dir: string,
  kind: AgentKind,
  accept: (name: string) => boolean,
  cutoff: number,
  out: Candidate[]
): Promise<void> {
  for (const entry of await dirEntries(dir)) {
    if (!entry.isFile() || !accept(entry.name)) continue
    const file = path.join(dir, entry.name)
    const mtime = await mtimeOf(file)
    if (mtime === undefined || mtime < cutoff) continue
    out.push({ file, kind, name: entry.name.replace(/\.jsonl$/, ''), mtime })
  }
}

async function canonicalDir(p: string): Promise<string> {
  const abs = path.resolve(p)
  const real = await fsp.realpath(abs).catch(() => abs)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

async function isDirectory(p: string, cache: Map<string, boolean>): Promise<boolean> {
  const known = cache.get(p)
  if (known !== undefined) return known
  const ok = await fsp.stat(p).then((st) => st.isDirectory(), () => false)
  cache.set(p, ok)
  return ok
}
