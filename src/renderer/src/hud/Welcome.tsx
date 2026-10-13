// No-repo state: the idle city shows behind a glass card. Also the scanning card shown while a repo is read.
import { useEffect, useState } from 'react'
import type { AgentKind, RecentSession } from '@shared/types'
import { useUi } from '../lib/ui'
import { basename, dirname, middleEllipsis, relativeTime, shortPath } from '../lib/format'
import { groupByRepo, type RepoActivity } from '../lib/activity'
import { loadSettings, openRepoPath, pickAndOpen } from '../lib/actions'
import { toast } from '../lib/toast'
import { IconDots, IconFolder, IconSparkle, IconTerminal, SkylineGlyph } from './icons'

const ACTIVITY_ROWS = 6

const KIND_META: Record<AgentKind, { label: string; color: string; Icon: typeof IconSparkle }> = {
  'claude-code': { label: 'Claude Code', color: '#D97757', Icon: IconSparkle },
  codex: { label: 'Codex', color: '#10A37F', Icon: IconTerminal },
  unknown: { label: 'Agent', color: '#8E8E93', Icon: IconDots }
}

function AgentKindBadge({ kind }: { kind: AgentKind }) {
  const m = KIND_META[kind] ?? KIND_META.unknown
  return (
    <span className="activity__kind" style={{ ['--c' as string]: m.color }} title={m.label} role="img" aria-label={m.label}>
      <m.Icon size={11} />
    </span>
  )
}

function RecentActivity({ rows }: { rows: readonly RepoActivity[] }) {
  return (
    <section className="activity" aria-labelledby="activity-title">
      <div id="activity-title" className="t-caption">
        Recent agent activity
      </div>
      <div className="activity__list">
        {rows.map((r) => (
          <button
            key={r.cwd}
            className="row-btn activity__row"
            onClick={() => void openRepoPath(r.cwd)}
            title={`Open ${r.cwd}`}
          >
            <IconFolder size={14} />
            <span className="activity__text">
              <span className="ellipsis activity__name">{r.name}</span>
              <span className="ellipsis faint activity__path">{middleEllipsis(r.cwd, 46)}</span>
            </span>
            <span className="activity__kinds">
              {r.kinds.map((k) => (
                <AgentKindBadge key={k} kind={k} />
              ))}
            </span>
            <span className="faint activity__time">{relativeTime(r.lastActiveAt)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function Welcome() {
  const [recent, setRecent] = useState<string[] | null>(null)
  const [activity, setActivity] = useState<RepoActivity[] | null>(null)

  useEffect(() => {
    let alive = true
    void loadSettings().then((s) => {
      if (alive) setRecent(s?.recentRepos ?? [])
    })
    // Session discovery is a convenience: if it fails the section simply stays hidden.
    window.skyline
      .listSessions()
      .then((list: RecentSession[]) => {
        if (alive) setActivity(groupByRepo(list, ACTIVITY_ROWS))
      })
      .catch(() => {
        if (alive) setActivity([])
      })
    return () => {
      alive = false
    }
  }, [])

  const demo = () => {
    const fn = (window as unknown as { __skylineDemo?: () => void }).__skylineDemo
    if (typeof fn === 'function') fn()
    else toast.info('Demo city unavailable', 'This build does not include a sample repository.')
  }

  const hasRecent = recent !== null && recent.length > 0
  const hasActivity = activity !== null && activity.length > 0
  const twoColumns = hasRecent || hasActivity

  return (
    <div className="welcome-wrap">
      <section
        className={`welcome glass-strong sheen${twoColumns ? ' welcome--wide' : ''}`}
        aria-labelledby="welcome-title"
      >
        <div className="welcome__main">
          <div className="welcome__glyph">
            <SkylineGlyph size={46} />
          </div>
          <h1 id="welcome-title" className="t-hero">
            Watch your agents build.
          </h1>
          <p className="t-body muted" style={{ margin: '12px 0 0', maxWidth: 440 }}>
            Skyline turns any repository into a living city — and every AI coding agent into a builder you can see.
          </p>

          <div className="welcome__actions">
            <button className="capsule capsule--primary" onClick={() => void pickAndOpen()}>
              <IconFolder size={14} />
              Open repository…
            </button>
            <button className="capsule" onClick={demo}>
              Try the demo city
            </button>
          </div>
        </div>

        {twoColumns && (
          <div className="welcome__aside">
            {hasActivity && activity && <RecentActivity rows={activity} />}

            {hasRecent && recent && (
              <div className="recent">
                <div className="t-caption">Recent</div>
                <div className="recent__list">
                  {recent.slice(0, 6).map((p) => (
                    <button key={p} className="row-btn" onClick={() => void openRepoPath(p)} title={p}>
                      <IconFolder size={14} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                          {basename(p)}
                        </span>
                        <span className="ellipsis faint" style={{ display: 'block', fontSize: 11 }}>
                          {shortPath(dirname(p)) || '/'}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="welcome__foot">100% local · Open source · Works with Claude Code &amp; Codex</div>
      </section>
    </div>
  )
}

export function Scanning() {
  const label = useUi((s) => s.scanLabel)
  return (
    <div className="scanning" role="status" aria-live="polite">
      <div className="scanning__card glass-strong">
        <SkylineGlyph size={56} animated />
        <div className="text-shine t-title">{label}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          Reading files, imports and history
        </div>
      </div>
    </div>
  )
}
