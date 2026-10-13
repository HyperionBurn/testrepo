// When each file first appears in the git time-lapse. Pure: no store or DOM imports.
import type { GitCommit } from '../../../shared/types'

/**
 * Earliest commit ts per path, from commits in any order. A file appears at the earliest commit that creates it.
 * Files that already existed when the window starts were created before it, so they are not in firstSeen and
 * are visible from the start (a modification inside the window does not make them appear). Without creation
 * data, a commit's touched files count as created.
 */
export function firstSeenByPath(commits: readonly GitCommit[]): Record<string, number> {
  const firstSeen: Record<string, number> = {}
  for (const commit of commits) {
    for (const path of commit.created ?? commit.files.map((f) => f.path)) {
      const prev = firstSeen[path]
      if (prev === undefined || commit.ts < prev) firstSeen[path] = commit.ts
    }
  }
  return firstSeen
}
