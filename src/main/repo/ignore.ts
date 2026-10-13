// Path-segment ignore rules shared by the scanner, the watcher and the session.
import { IGNORED_DIRS } from '../../shared/lang'

/** Shared dirs from lang.ts plus '.git' and Skyline's own worktree folder (full repo copies). */
const SKIP_SEGMENTS: ReadonlySet<string> = new Set([...IGNORED_DIRS, '.git', '.skyline'])

/** True when any segment of a repo-relative path (either slash style) is an ignored directory name. */
export function isIgnoredRel(rel: string): boolean {
  for (const seg of rel.split(/[\\/]/)) {
    if (seg !== '' && SKIP_SEGMENTS.has(seg)) return true
  }
  return false
}

/** Native relative path to forward-slash repo-relative path. */
export function toPosixRel(rel: string): string {
  return rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.').join('/')
}
