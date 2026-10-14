// Compact live feed of the latest agent events. New rows slide in; clicking a row selects its file.
import { useEffect, useMemo, useRef } from 'react'
import type { AgentEvent } from '@shared/types'
import { useSky } from '../state/store'
import { middleEllipsisDir, relativeTime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { EVENT_META } from './meta'

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const FEED_SIZE = 50

/** Last `n` events, newest first. Events are kept ascending, so scan from the end. */
export function latestEvents(events: readonly AgentEvent[], n: number): AgentEvent[] {
  const out: AgentEvent[] = []
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i]
    if (e) out.push(e)
  }
  return out.sort((a, b) => b.ts - a.ts)
}

export function ActivityFeed() {
  const events = useSky((s) => s.events)
  const agents = useSky((s) => s.agents)
  const now = useNow(15_000)
  const items = useMemo(() => latestEvents(events, FEED_SIZE), [events])

  const colorOf = useMemo(() => new Map(agents.map((a) => [a.id, a.color] as const)), [agents])
  const nameOf = useMemo(() => new Map(agents.map((a) => [a.id, a.name] as const)), [agents])

  // Rows not seen in an earlier render slide in. The first render marks what is already there as seen.
  const seenRef = useRef<Set<string> | null>(null)
  if (seenRef.current === null) seenRef.current = new Set(items.map((e) => e.id))
  const seen = seenRef.current
  const fresh = new Set<string>()
  for (const e of items) if (!seen.has(e.id)) fresh.add(e.id)

  useEffect(() => {
    const set = seenRef.current
    if (!set) return
    for (const e of items) set.add(e.id)
    // Keep the set bounded; the feed only shows the newest rows anyway.
    if (set.size > 400) seenRef.current = new Set(items.map((e) => e.id))
  }, [items])

  if (items.length === 0) {
    return (
      <div className="feed">
        <div className="empty">
          <div>Nothing yet.</div>
          <div>Agent reads, edits and commands stream here as they happen.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="feed" role="list" aria-label="Recent agent activity">
      {items.map((e) => {
        const meta = EVENT_META[e.type]
        const color = e.agentId === 'fs' ? '#94A3B8' : colorOf.get(e.agentId) ?? '#ffffff'
        const who = e.agentId === 'fs' ? 'Unattributed change' : nameOf.get(e.agentId) ?? e.agentId
        const label = e.file ? null : e.text ? e.text : meta.verb
        const hasDiff = typeof e.linesAdded === 'number' || typeof e.linesRemoved === 'number'
        return (
          <button
            key={e.id}
            role="listitem"
            className={`feed-item${fresh.has(e.id) ? ' feed-item--new' : ''}`}
            onClick={() => e.file && useSky.getState().select(e.file)}
            onMouseEnter={() => e.file && useSky.getState().hover(e.file)}
            onMouseLeave={() => useSky.getState().hover(null)}
            title={`${who} · ${meta.verb}${e.file ? ` ${e.file}` : ''}`}
            style={{ cursor: e.file ? 'pointer' : 'default' }}
          >
            <span className="dot-live" style={{ ['--c' as string]: color, width: 6, height: 6, boxShadow: 'none' }} />
            <meta.Icon size={14} />
            <span className="feed-item__file">
              {e.file ? (
                <>
                  {dirOf(e.file) && <span className="feed-item__dir">{middleEllipsisDir(dirOf(e.file), 26)}/</span>}
                  <span className="feed-item__base">{baseOf(e.file)}</span>
                </>
              ) : (
                label
              )}
              {hasDiff && (
                <span style={{ marginLeft: 6, fontSize: 11 }}>
                  {e.linesAdded ? <span style={{ color: 'var(--success)' }}>+{e.linesAdded}</span> : null}
                  {e.linesRemoved ? <span style={{ color: 'var(--danger)', marginLeft: 4 }}>−{e.linesRemoved}</span> : null}
                </span>
              )}
            </span>
            <span className="feed-item__time">{relativeTime(e.ts, now)}</span>
          </button>
        )
      })}
    </div>
  )
}
