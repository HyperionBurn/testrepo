// Recent agent activity for the Welcome screen: one row per working directory. Pure, no React.
import type { AgentKind, RecentSession } from '@shared/types'
import { basename } from './format'

export interface RepoActivity {
  /** Working directory, as the agent reported it. Click target. */
  cwd: string;
  /** Folder name: the repo's display name. */
  name: string;
  /** Agent kinds that worked in this directory, in first-seen order (newest session first). */
  kinds: AgentKind[];
  /** Newest session activity in this directory, ms. */
  lastActiveAt: number;
  sessions: number;
}

/** Dedupes sessions by working directory (newest first), keeping the first `limit` directories. */
export function groupByRepo(sessions: readonly RecentSession[], limit = 6): RepoActivity[] {
  const byCwd = new Map<string, RepoActivity>()
  const newestFirst = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  for (const s of newestFirst) {
    const cwd = s.cwd.trim().replace(/[\\/]+$/, '')
    if (!cwd) continue
    const seen = byCwd.get(cwd)
    if (!seen) {
      byCwd.set(cwd, { cwd, name: basename(cwd), kinds: [s.kind], lastActiveAt: s.lastActiveAt, sessions: 1 })
      continue
    }
    seen.sessions++
    if (!seen.kinds.includes(s.kind)) seen.kinds.push(s.kind)
  }
  return [...byCwd.values()].slice(0, Math.max(0, limit))
}
