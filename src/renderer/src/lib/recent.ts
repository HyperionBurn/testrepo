// Welcome screen helpers for recent repositories: how a repo's parent folder is shown, and which
// recent repos are left once "Recent agent activity" is listed. Pure, no React.
import { middleEllipsis } from './format'

/**
 * The folder a repo sits in, keeping its own separators and shortened in the middle for display:
 * "/home/user/app" -> "/home/user", "C:\dev\app" -> "C:\dev", "/app" -> "/", "C:\app" -> "C:\".
 * Returns '' when the path has no parent (a bare name or a filesystem root).
 */
export function parentLabel(path: string, max = 40): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return ''
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const parent = trimmed.slice(0, i)
  const label = parent === '' ? sep : /^[A-Za-z]:$/.test(parent) ? `${parent}${sep}` : parent
  return middleEllipsis(label, max)
}

/** Comparable form of a repo path: forward slashes, no trailing slash, lower case for Windows drive paths. */
export function repoKey(path: string): string {
  const s = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

/**
 * The recent repos that "Recent agent activity" does not already list, in stored order. Repos are
 * compared with repoKey, so a trailing slash or a Windows separator does not make a repo look new.
 */
export function recentWithoutActivity(recent: readonly string[], activity: readonly { cwd: string }[]): string[] {
  const seen = new Set(activity.map((row) => repoKey(row.cwd)))
  const out: string[] = []
  for (const p of recent) {
    const key = repoKey(p)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}
