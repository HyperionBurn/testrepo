// 44px draggable title bar: brand, repo + branch, live mode pill, aggregate meters, window controls.
import { useSky, type Mode } from '../state/store'
import { useUi } from '../lib/ui'
import { compactNumber, usd } from '../lib/format'
import { useNow } from '../lib/hooks'
import { pickAndOpen } from '../lib/actions'
import { IconChevronDown, IconFolder, IconGitBranch, IconMinus, IconSearch, IconSquare, IconX, SkylineGlyph } from './icons'

const MODE_META: Record<Mode, { label: string; color: string; live: boolean }> = {
  live: { label: 'Live', color: 'var(--success)', live: true },
  replay: { label: 'Replay', color: 'var(--accent)', live: false },
  git: { label: 'Time-lapse', color: '#BF5AF2', live: false }
}

export function TitleBar() {
  const repo = useSky((s) => s.repo)
  const agents = useSky((s) => s.agents)
  const mode = useSky((s) => s.mode)
  const now = useNow(30_000)
  const platform = window.skyline.platform
  const isWin = platform === 'win32'
  const isMac = platform === 'darwin'

  const active = agents.filter((a) => a.status !== 'idle' && a.status !== 'done').length
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const today = agents.filter((a) => a.lastActiveAt >= startOfDay.getTime())
  const spend = today.reduce((sum, a) => sum + a.costUsd, 0)
  const tokens = today.reduce((sum, a) => sum + a.tokens.input + a.tokens.output, 0)
  const meta = MODE_META[mode]

  return (
    <header className={`titlebar${isWin ? ' titlebar--win' : ''}`}>
      <div className="tb-brand">
        <SkylineGlyph size={18} />
        <span className="tb-name">Skyline</span>
      </div>

      {repo ? (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <span className="tb-repo ellipsis" title={repo.root}>
            {repo.name}
          </span>
          {repo.branch && (
            <span className="branch-pill" title={`Branch ${repo.branch}`}>
              <IconGitBranch size={12} />
              <span className="ellipsis">{repo.branch}</span>
            </span>
          )}
          <span className="mode-pill" style={{ ['--c' as string]: meta.color }}>
            <span className={`dot-live${meta.live ? '' : ' dot-live--still'}`} style={{ ['--c' as string]: meta.color }} />
            {meta.label}
          </span>
        </>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          No repository open
        </span>
      )}

      <div className="tb-spacer" />

      {repo && (
        <div className="meters" aria-label="Session totals">
          <div className="meter" title="Agents currently working">
            <span className="meter__v num">{active}</span>
            <span className="meter__k">active</span>
          </div>
          <span className="tb-divider" aria-hidden="true" />
          <div className="meter meter--secondary" title="Estimated spend for agents active today">
            <span className="meter__v num">{usd(spend)}</span>
            <span className="meter__k">today</span>
          </div>
          <span className="tb-divider" aria-hidden="true" />
          <div className="meter meter--secondary" title="Input and output tokens for agents active today">
            <span className="meter__v num">{compactNumber(tokens)}</span>
            <span className="meter__k">tokens</span>
          </div>
        </div>
      )}

      <button
        className="capsule capsule--ghost capsule--sm"
        onClick={() => useUi.getState().setPalette(true)}
        title="Search files, agents and actions"
      >
        <IconSearch size={13} />
        <span className="muted">Search</span>
        <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>

      {repo ? (
        <button className="capsule capsule--ghost capsule--sm" onClick={() => void pickAndOpen()} title="Open another repository (Ctrl O)">
          <IconFolder size={13} />
          <span className="muted">Open</span>
          <IconChevronDown size={11} />
        </button>
      ) : null}

      {!isWin && (
        <div className="win-controls">
          <button className="win-btn" onClick={() => window.skyline.window.minimize()} title="Minimize" aria-label="Minimize">
            <IconMinus size={14} />
          </button>
          <button className="win-btn" onClick={() => window.skyline.window.maximize()} title="Maximize" aria-label="Maximize">
            <IconSquare size={13} />
          </button>
          <button className="win-btn win-btn--close" onClick={() => window.skyline.window.close()} title="Close" aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
      )}
    </header>
  )
}
