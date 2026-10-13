// Bottom-centre capsule: Live | Replay | Time-lapse. Replay scrubs agent events; Time-lapse scrubs git history.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, GitCommit } from '@shared/types'
import { useSky, type Mode } from '../state/store'
import { useUi } from '../lib/ui'
import { dateTime, clockTime, relativeTime } from '../lib/format'
import { useFrame, useNow } from '../lib/hooks'
import { setMode } from '../lib/actions'
import { IconPause, IconPlay, IconStepBack, IconStepForward } from './icons'

const BUCKETS = 96
const TIMELAPSE_MS = 20_000
const SPEEDS = [1, 10, 60] as const
type Speed = (typeof SPEEDS)[number];

interface Bucket {
  h: number;
  color: string;
}

interface Range {
  start: number;
  end: number;
}

/** Replay window: first recorded event (or the last hour) up to now. */
export function replayRange(events: readonly AgentEvent[], now: number): Range {
  const start = events[0]?.ts ?? now - 3_600_000
  const last = events[events.length - 1]?.ts ?? now
  return { start, end: Math.max(now, last, start + 1) }
}

/** Time-lapse window: first commit to the newest commit. Null when there is no history. */
export function commitRange(sorted: readonly GitCommit[]): Range | null {
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return null
  return { start: first.ts, end: Math.max(last.ts, first.ts + 1) }
}

/** Histogram of events per bucket, coloured by the dominant agent in that bucket. */
export function eventBuckets(events: readonly AgentEvent[], range: Range, colors: ReadonlyMap<string, string>): Bucket[] {
  const counts: Map<string, number>[] = Array.from({ length: BUCKETS }, () => new Map<string, number>())
  const span = range.end - range.start
  for (const e of events) {
    if (e.ts < range.start || e.ts > range.end) continue
    const i = Math.min(BUCKETS - 1, Math.floor(((e.ts - range.start) / span) * BUCKETS))
    const m = counts[i]
    if (m) m.set(e.agentId, (m.get(e.agentId) ?? 0) + 1)
  }
  const totals = counts.map((m) => {
    let t = 0
    for (const v of m.values()) t += v
    return t
  })
  const max = Math.max(1, ...totals)
  return counts.map((m, i) => {
    let best = ''
    let bestN = 0
    for (const [id, v] of m) {
      if (v > bestN) {
        bestN = v
        best = id
      }
    }
    const total = totals[i] ?? 0
    return {
      h: total === 0 ? 0 : Math.sqrt(total / max),
      color: best === '' ? '#ffffff' : best === 'fs' ? '#94A3B8' : colors.get(best) ?? '#ffffff'
    }
  })
}

/** Index of the first element with ts > t (ascending array). */
function upperBound(list: readonly { ts: number }[], t: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid]?.ts ?? 0) <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function Histogram({
  buckets,
  ratio,
  onScrub,
  label,
  valueText
}: {
  buckets: Bucket[];
  ratio: number | null;
  onScrub: (r: number) => void;
  label: string;
  valueText: string;
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const at = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || r.width === 0) return 0
    return clamp01((clientX - r.left) / r.width)
  }
  return (
    <div
      ref={ref}
      className="hist"
      role="slider"
      aria-label={label}
      aria-valuetext={valueText}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((ratio ?? 0) * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        onScrub(at(e.clientX))
      }}
      onPointerMove={(e) => {
        if (dragging.current) onScrub(at(e.clientX))
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      <svg viewBox={`0 0 ${BUCKETS} 34`} preserveAspectRatio="none" aria-hidden="true">
        {buckets.map((b, i) =>
          b.h > 0 ? (
            <rect key={i} x={i + 0.16} y={34 - 4 - b.h * 28} width={0.68} height={4 + b.h * 28} fill={b.color} opacity={0.85} />
          ) : null
        )}
      </svg>
      {ratio !== null && <div className="hist__playhead" style={{ left: `${ratio * 100}%` }} />}
    </div>
  )
}

function SegMode({ mode }: { mode: Mode }) {
  const idx = mode === 'live' ? 0 : mode === 'replay' ? 1 : 2
  return (
    <div className="seg" style={{ ['--n' as string]: 3, ['--i' as string]: idx, width: 262, flex: 'none' }} role="tablist" aria-label="Timeline mode">
      <span className="seg__thumb" />
      <button className="seg__btn" role="tab" aria-selected={mode === 'live'} onClick={() => setMode('live')} title="Live (1)">
        Live
      </button>
      <button className="seg__btn" role="tab" aria-selected={mode === 'replay'} onClick={() => setMode('replay')} title="Replay (2)">
        Replay
      </button>
      <button className="seg__btn" role="tab" aria-selected={mode === 'git'} onClick={() => setMode('git')} title="Time-lapse (3)">
        Time-lapse
      </button>
    </div>
  )
}

function PlayButton({ playing, onToggle, disabled }: { playing: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button className="play-btn" onClick={onToggle} disabled={disabled} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
      {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
    </button>
  )
}

export function Timeline() {
  const mode = useSky((s) => s.mode)
  const events = useSky((s) => s.events)
  const agents = useSky((s) => s.agents)
  const replayTs = useSky((s) => s.replayTs)
  const commits = useSky((s) => s.commits)
  const gitTs = useSky((s) => s.gitTs)
  const now = useNow(10_000)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(10)

  const colors = useMemo(() => new Map(agents.map((a) => [a.id, a.color] as const)), [agents])
  const sortedCommits = useMemo(() => commits.slice().sort((a, b) => a.ts - b.ts), [commits])
  const rRange = useMemo(() => replayRange(events, now), [events, now])
  const cRange = useMemo(() => commitRange(sortedCommits), [sortedCommits])

  const replayBk = useMemo(() => (mode === 'replay' ? eventBuckets(events, rRange, colors) : []), [mode, events, rRange, colors])
  const commitBk = useMemo(() => {
    if (mode !== 'git' || !cRange) return []
    const counts = new Array<number>(BUCKETS).fill(0)
    const span = cRange.end - cRange.start
    for (const c of sortedCommits) {
      const i = Math.min(BUCKETS - 1, Math.floor(((c.ts - cRange.start) / span) * BUCKETS))
      counts[i] = (counts[i] ?? 0) + 1
    }
    const max = Math.max(1, ...counts)
    return counts.map((n) => ({ h: n === 0 ? 0 : Math.sqrt(n / max), color: '#BF5AF2' }))
  }, [mode, sortedCommits, cRange])

  // Playback. Pause whenever the mode changes.
  useEffect(() => setPlaying(false), [mode])

  useFrame(playing && mode === 'replay', (dt) => {
    const s = useSky.getState()
    const cur = s.replayTs ?? rRange.start
    const next = cur + dt * speed
    if (next >= rRange.end) {
      s.setReplayTs(rRange.end)
      setPlaying(false)
    } else {
      s.setReplayTs(next)
    }
  })

  useFrame(playing && mode === 'git' && cRange !== null, (dt) => {
    if (!cRange) return
    const s = useSky.getState()
    const span = cRange.end - cRange.start
    const cur = s.gitTs ?? cRange.start
    const next = cur + (dt * span) / TIMELAPSE_MS
    if (next >= cRange.end) {
      s.setGitTs(cRange.end)
      setPlaying(false)
    } else {
      s.setGitTs(next)
    }
  })

  // Keyboard: Space toggles playback; arrows step to the neighbouring event or commit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState()
      if (ui.palette || ui.dispatch || ui.digest) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const s = useSky.getState()
      if (s.mode === 'live' || !s.repo) return
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setPlaying(false)
        const dir = e.key === 'ArrowRight' ? 1 : -1
        if (s.mode === 'replay') {
          const cur = s.replayTs ?? rRange.start
          const list = s.events
          if (dir > 0) {
            const i = upperBound(list, cur)
            s.setReplayTs(list[i]?.ts ?? rRange.end)
          } else {
            const i = upperBound(list, cur - 1) - 1
            s.setReplayTs(list[i]?.ts ?? rRange.start)
          }
        } else if (cRange) {
          const cur = s.gitTs ?? cRange.start
          if (dir > 0) {
            const i = upperBound(sortedCommits, cur)
            s.setGitTs(sortedCommits[i]?.ts ?? cRange.end)
          } else {
            const i = upperBound(sortedCommits, cur - 1) - 1
            s.setGitTs(sortedCommits[i]?.ts ?? cRange.start)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rRange, cRange, sortedCommits])

  if (mode === 'live') {
    const cutoff = now - 60_000
    let perMin = 0
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (!e || e.ts < cutoff) break
      perMin++
    }
    const active = agents.filter((a) => a.status !== 'idle' && a.status !== 'done').length
    return (
      <div className="timeline-wrap">
        <div className="timeline timeline--compact glass" role="region" aria-label="Timeline">
          <SegMode mode={mode} />
          <div className="timeline__body" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="dot-live" style={{ ['--c' as string]: 'var(--success)' }} />
            <span className="t-ui" style={{ whiteSpace: 'nowrap' }}>
              Following live
            </span>
            <span className="timeline__meta">
              {active} working · {perMin} events / min
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'replay') {
    const cur = replayTs ?? rRange.start
    const span = rRange.end - rRange.start
    const ratio = clamp01((cur - rRange.start) / span)
    const scrub = (r: number) => useSky.getState().setReplayTs(rRange.start + r * span)
    const stepTo = (dir: 1 | -1) => {
      setPlaying(false)
      const list = useSky.getState().events
      if (dir > 0) useSky.getState().setReplayTs(list[upperBound(list, cur)]?.ts ?? rRange.end)
      else useSky.getState().setReplayTs(list[upperBound(list, cur - 1) - 1]?.ts ?? rRange.start)
    }
    return (
      <div className="timeline-wrap">
        <div className="timeline timeline--tall glass-strong" role="region" aria-label="Replay timeline">
          <div className="timeline__row">
            <SegMode mode={mode} />
            <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
            <div className="speed" role="group" aria-label="Playback speed">
              {SPEEDS.map((v) => (
                <button key={v} aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                  {v}×
                </button>
              ))}
            </div>
            <span className="timeline__time">
              {new Date(cur).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}{' '}
              <span>{relativeTime(cur, now)}</span>
            </span>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={() => stepTo(-1)} aria-label="Previous event" title="Previous event (←)">
              <IconStepBack size={15} />
            </button>
            <button className="icon-btn" onClick={() => stepTo(1)} aria-label="Next event" title="Next event (→)">
              <IconStepForward size={15} />
            </button>
          </div>
          <Histogram
            buckets={replayBk}
            ratio={ratio}
            onScrub={scrub}
            label="Replay position"
            valueText={clockTime(cur)}
          />
          <div className="timeline__row" style={{ justifyContent: 'space-between', marginTop: -4 }}>
            <span className="timeline__meta">{clockTime(rRange.start)}</span>
            <span className="timeline__meta">{events.length.toLocaleString('en-US')} events</span>
            <span className="timeline__meta">now</span>
          </div>
        </div>
      </div>
    )
  }

  // Time-lapse
  const hasHistory = cRange !== null
  const cur = gitTs ?? cRange?.start ?? 0
  const ratio = cRange ? clamp01((cur - cRange.start) / (cRange.end - cRange.start)) : 0
  let idx = -1
  for (let i = 0; i < sortedCommits.length; i++) {
    if ((sortedCommits[i]?.ts ?? 0) <= cur) idx = i
    else break
  }
  const current: GitCommit | undefined = idx >= 0 ? sortedCommits[idx] : undefined
  const scrub = (r: number) => {
    if (cRange) useSky.getState().setGitTs(cRange.start + r * (cRange.end - cRange.start))
  }
  return (
    <div className="timeline-wrap">
      <div className="timeline timeline--tall glass-strong" role="region" aria-label="Time-lapse timeline">
        <div className="timeline__row">
          <SegMode mode={mode} />
          <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} disabled={!hasHistory} />
          <div className="timeline__body" style={{ minWidth: 0, gap: 2 }}>
            <div className="commit-subject" title={current?.subject}>
              {!hasHistory ? 'No git history in this repository' : current ? current.subject : 'Before the first commit'}
            </div>
            {current && (
              <div className="timeline__meta" style={{ fontSize: 10.5 }}>
                {dateTime(current.ts)} · {current.author} · {current.hash.slice(0, 7)}
              </div>
            )}
          </div>
          {hasHistory && (
            <span className="timeline__time" style={{ whiteSpace: 'nowrap' }}>
              {idx + 1}
              <span> / {sortedCommits.length}</span>
            </span>
          )}
        </div>
        {hasHistory && (
          <Histogram
            buckets={commitBk}
            ratio={ratio}
            onScrub={scrub}
            label="Commit position"
            valueText={current ? current.subject : 'before first commit'}
          />
        )}
      </div>
    </div>
  )
}
