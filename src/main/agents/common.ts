// Shared helpers for the agent transcript parsers. Pure logic, no I/O.
import type { AgentEvent, AgentStatus } from '../../shared/types'

/** Context a parser needs for one line. */
export interface ParseCtx {
  /** Absolute repo root (any separator style; Windows drive letters compared case-insensitively). */
  repoRoot: string
  /** Agent id the emitted events belong to. */
  agentId: string
  /** Session working directory, when known. Used to resolve relative paths (Codex patches). */
  cwd?: string
}

/** Token usage counts in AgentInfo['tokens'] shape. */
export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Per-message usage (Claude). The same message id can appear on several streamed lines;
 * the hub keeps the last value per id and adds only the difference.
 */
export interface MessageUsage extends Usage {
  messageId: string
  model?: string
}

/**
 * Cumulative totals (Codex token_count). `input` is the raw input count, which includes the
 * cached part in `cacheRead`; the hub diffs these totals and then splits the cached part out.
 */
export interface TotalUsage extends Usage {
  model?: string
}

/** Result of parsing one transcript line. */
export interface ParsedLine {
  events: AgentEvent[]
  /** Line timestamp in ms (undefined when the line has none). */
  ts?: number
  /** Session id carried by the line (Codex session_meta.payload.id). */
  sessionId?: string
  /** Working directory carried by the line (absolute, as written by the agent). */
  cwd?: string
  /** Model named by the line (assistant message or Codex turn_context). */
  model?: string
  /** Claude per-message usage; deduplicated by the hub on messageId. */
  usage?: MessageUsage
  /** Codex cumulative totals; converted to deltas by the hub. */
  totalUsage?: TotalUsage
  /** Last assistant text in the line, truncated to 280 chars. */
  text?: string
  /** A user prompt in the line (used for naming subagents). */
  userText?: string
  /** Status hint derived from the events of this line. */
  status?: AgentStatus
}

export const MESSAGE_MAX = 280
export const COMMAND_MAX = 120

/** Collapses whitespace and truncates to `max` characters (the result never exceeds `max`). */
export function snippet(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, Math.max(0, max - 1)) + '…'
}

/** Number of lines in a text snippet (0 for empty). */
export function countLines(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.replace(/\n$/, '').split('\n').length
}

/** Parses an ISO timestamp or epoch number into ms. Undefined when unparseable. */
export function parseTs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

/** Small stable string hash (FNV-1a, hex). Used for event ids. */
export function hashString(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function isWindowsish(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')
}

/** True for POSIX absolute, Windows drive absolute (either slash) and UNC paths. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Normalizes a path to forward slashes and resolves '.' and '..'. Keeps the root
 * prefix ('/' or 'C:' or '//server') so absolute paths stay absolute.
 */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  let prefix = ''
  const drive = /^([A-Za-z]:)/.exec(s)
  if (drive?.[1]) {
    prefix = drive[1]
    s = s.slice(2)
  } else if (s.startsWith('//')) {
    prefix = '//'
    s = s.slice(2)
  }
  const absolute = s.startsWith('/') || prefix !== ''
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  if (prefix === '//') return `//${out.join('/')}`
  if (prefix !== '') return `${prefix}/${out.join('/')}`
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * Path of `p` relative to `root`, forward slashes, no leading slash.
 * - Returns '' when `p` is the root itself.
 * - Returns null when `p` is outside `root` or the two paths use different roots styles.
 * - Relative `p` is resolved against `base` (when given) or taken as already repo-relative.
 */
export function relativeWithin(p: string, root: string, base?: string): string | null {
  if (!p) return null
  const rootN = normalizePath(root)
  let target = p.trim()
  if (!target) return null
  if (!isAbsolutePath(target)) {
    if (base && base.trim() !== '') {
      target = `${base}/${target}`
    } else {
      // Repo-relative. Reject anything that climbs out of the repo.
      const rel = normalizePath(target)
      if (rel === '..' || rel.startsWith('../')) return null
      return rel.replace(/^\/+/, '')
    }
  }
  const targetN = normalizePath(target)
  if (isAbsolutePath(targetN) === false) return null
  if (isWindowsish(targetN) !== isWindowsish(rootN)) return null

  // Windows paths are case-insensitive (at least for the drive letter); compare folded.
  const winStyle = isWindowsish(rootN) || isWindowsish(targetN)
  const fold = (s: string): string => (winStyle ? s.toLowerCase() : s)
  const r = fold(rootN)
  const t = fold(targetN)
  if (t === r) return ''
  const prefix = r.endsWith('/') ? r : r + '/'
  if (!t.startsWith(prefix)) return null
  return targetN.slice(prefix.length)
}

/**
 * Repo-relative, forward-slash path for an agent-reported file path, or undefined when the
 * path is missing, is the repo root itself, or lies outside the repo.
 */
export function toRepoRelative(filePath: unknown, repoRoot: string, base?: string): string | undefined {
  if (typeof filePath !== 'string') return undefined
  const rel = relativeWithin(filePath, repoRoot, base)
  if (!rel) return undefined
  return rel
}

/** True when a directory/file path is the repo root or inside it. */
export function isWithinRepo(p: string, repoRoot: string): boolean {
  return relativeWithin(p, repoRoot) !== null
}

/** Skyline runs isolated agents in git worktrees under `<repo>/.skyline/worktrees/<id>/`. */
const WORKTREE_REL_RE = /^\.skyline\/worktrees\/[^/]+\/(?=.)/

/**
 * Maps a repo-relative, forward-slash path inside one of those worktrees back to the main checkout:
 * `.skyline/worktrees/<id>/src/a.ts` becomes `src/a.ts`. Any other path is returned unchanged.
 */
export function stripSkylineWorktree(rel: string): string {
  const m = WORKTREE_REL_RE.exec(rel)
  return m ? rel.slice(m[0].length) : rel
}

const WORKTREE_ABS_RE = /^(.*?)[\\/]\.skyline[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/

/**
 * For a path inside a Skyline worktree, the main checkout it belongs to (the text before the first
 * `/.skyline/worktrees/`), keeping the original separators. Other paths are returned unchanged.
 */
export function mainCheckoutOf(p: string): string {
  const m = WORKTREE_ABS_RE.exec(p)
  return m && m[1] ? m[1] : p
}

/** Maps the last event type of a line to a status hint. */
export function statusFromEventType(type: AgentEvent['type'] | undefined): AgentStatus | undefined {
  switch (type) {
    case 'edit':
    case 'create':
    case 'delete':
      return 'editing'
    case 'read':
      return 'reading'
    case 'command':
      return 'running'
    case 'thinking':
    case 'message':
    case 'spawn':
      return 'thinking'
    case 'end':
      return 'done'
    default:
      return undefined
  }
}
