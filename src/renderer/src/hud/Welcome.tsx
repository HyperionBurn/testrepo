// No-repo state: the idle city shows behind a glass card. Also the scanning card shown while a repo is read.
import { useEffect, useState } from 'react'
import { useUi } from '../lib/ui'
import { basename, dirname, shortPath } from '../lib/format'
import { loadSettings, openRepoPath, pickAndOpen } from '../lib/actions'
import { toast } from '../lib/toast'
import { IconFolder, SkylineGlyph } from './icons'

export function Welcome() {
  const [recent, setRecent] = useState<string[] | null>(null)

  useEffect(() => {
    let alive = true
    void loadSettings().then((s) => {
      if (alive) setRecent(s?.recentRepos ?? [])
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

  return (
    <div className="welcome-wrap">
      <section className="welcome glass-strong sheen" aria-labelledby="welcome-title">
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

        {recent && recent.length > 0 && (
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
