// Right floating panel for the selected building: path, stats, agents that touched it, recent events,
// local-LLM explanation, imports, and a read-only preview.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, FileNode } from '@shared/types'
import { useSky } from '../state/store'
import { LANG_COLORS, LANG_LABEL } from '@shared/lang'
import { basename, compactNumber, dirname, formatBytes, middleEllipsis, relativeTime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { attempt } from '../lib/actions'
import { Markdown } from '../lib/markdown'
import { EVENT_META } from './meta'
import { IconEye, IconLink, IconSparkle, IconX } from './icons'

const PREVIEW_LINES = 400
const explainCache = new Map<string, string>()

interface ExplainState {
  status: 'idle' | 'loading' | 'done' | 'error';
  text?: string;
}

interface PreviewState {
  status: 'closed' | 'loading' | 'open' | 'error';
  lines?: string[];
  truncated?: boolean;
}

export function Inspector() {
  const selectedPath = useSky((s) => s.selectedPath)
  if (!selectedPath) return null
  return <InspectorPanel key={selectedPath} path={selectedPath} />
}

function Crumbs({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean)
  const last = parts.length - 1
  return (
    <div className="crumbs selectable" title={path}>
      {parts.map((p, i) => (
        <span key={`${i}-${p}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {i > 0 && <span aria-hidden="true">/</span>}
          {i === last ? <b>{p}</b> : <span>{middleEllipsis(p, 22)}</span>}
        </span>
      ))}
    </div>
  )
}

/** Read-only, horizontally scrollable code listing. The right-edge fade shows only while more text lies off-screen. */
function CodeView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [moreRight, setMoreRight] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [lines])

  return (
    <div
      ref={ref}
      className={`code-view selectable${moreRight ? ' code-view--fade' : ''}`}
      role="region"
      aria-label="File preview"
      tabIndex={0}
    >
      {lines.map((line, i) => (
        <div className="code-line" key={i}>
          <span className="code-line__n">{i + 1}</span>
          <span className="code-line__t">{line || ' '}</span>
        </div>
      ))}
    </div>
  )
}

function InspectorPanel({ path }: { path: string }) {
  const repo = useSky((s) => s.repo)
  const events = useSky((s) => s.events)
  const agents = useSky((s) => s.agents)
  const commits = useSky((s) => s.commits)
  const showImports = useSky((s) => s.showImports)
  const now = useNow(15_000)

  const node: FileNode | undefined = useMemo(() => repo?.files.find((f) => f.path === path), [repo, path])

  // Events for this file, newest first.
  const fileEvents = useMemo(() => {
    const out: AgentEvent[] = []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e && e.file === path) out.push(e)
    }
    return out
  }, [events, path])

  const touches = useMemo(() => {
    const m = new Map<string, { edits: number; reads: number; last: number }>()
    for (const e of fileEvents) {
      const row = m.get(e.agentId) ?? { edits: 0, reads: 0, last: 0 }
      if (e.type === 'edit' || e.type === 'create' || e.type === 'delete') row.edits++
      else if (e.type === 'read') row.reads++
      row.last = Math.max(row.last, e.ts)
      m.set(e.agentId, row)
    }
    return [...m.entries()].sort((a, b) => b[1].last - a[1].last)
  }, [fileEvents])

  const fileCommits = useMemo(() => {
    const out: { hash: string; subject: string; ts: number; added: number; removed: number }[] = []
    for (const c of commits) {
      const hit = c.files.find((f) => f.path === path)
      if (hit) out.push({ hash: c.hash, subject: c.subject, ts: c.ts, added: hit.added, removed: hit.removed })
    }
    return out
  }, [commits, path])

  const churn = fileCommits.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), { added: 0, removed: 0 })
  const commitCount = node?.commits ?? fileCommits.length
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents])

  const [explain, setExplain] = useState<ExplainState>(() => {
    const cached = explainCache.get(path)
    return cached !== undefined ? { status: 'done', text: cached } : { status: 'idle' }
  })
  const [preview, setPreview] = useState<PreviewState>({ status: 'closed' })

  const runExplain = async () => {
    setExplain({ status: 'loading' })
    const text = await attempt('Explanation unavailable', () => window.skyline.explain(path))
    if (text === undefined) {
      setExplain({ status: 'error', text: 'The local model could not explain this file yet. Check the digest card for model status.' })
      return
    }
    explainCache.set(path, text)
    setExplain({ status: 'done', text })
  }

  const togglePreview = async () => {
    if (preview.status === 'open' || preview.status === 'loading') {
      setPreview({ status: 'closed' })
      return
    }
    if (preview.lines) {
      setPreview({ status: 'open', lines: preview.lines, truncated: preview.truncated })
      return
    }
    setPreview({ status: 'loading' })
    const text = await attempt('Preview unavailable', () => window.skyline.readFile(path))
    if (text === undefined) {
      setPreview({ status: 'error' })
      return
    }
    const all = text.replace(/\r\n?/g, '\n').split('\n')
    const lines = all.slice(0, PREVIEW_LINES)
    setPreview({ status: 'open', lines, truncated: all.length > PREVIEW_LINES })
  }

  const lang = node?.lang ?? 'other'
  const langColor = LANG_COLORS[lang]
  const imports = node?.imports ?? []

  return (
    <aside className="inspector glass enter" aria-label="File inspector">
      <div className="inspector__head">
        <div className="inspector__top">
          <Crumbs path={path} />
          <button className="icon-btn" onClick={() => useSky.getState().select(null)} title="Close (Esc)" aria-label="Close inspector">
            <IconX size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="chip" style={{ color: 'var(--text-1)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: langColor, boxShadow: `0 0 8px ${langColor}` }} />
            {LANG_LABEL[lang]}
          </span>
          {node ? (
            <span className="faint" style={{ fontSize: 11.5 }}>
              Modified {relativeTime(node.mtime, now)}
            </span>
          ) : (
            <span className="faint" style={{ fontSize: 11.5 }}>
              Not in the current scan
            </span>
          )}
        </div>

        {node && (
          <div className="stat-grid">
            <div className="stat">
              <div className="stat__v">{compactNumber(node.loc)}</div>
              <div className="stat__k">lines of code</div>
            </div>
            <div className="stat">
              <div className="stat__v">{formatBytes(node.bytes)}</div>
              <div className="stat__k">size</div>
            </div>
            <div className="stat">
              <div className="stat__v">{commitCount}</div>
              <div className="stat__k">commits</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            className="capsule capsule--sm capsule--primary"
            onClick={() => void runExplain()}
            disabled={explain.status === 'loading'}
          >
            <IconSparkle size={12} />
            {explain.status === 'loading' ? 'Explaining…' : 'Explain'}
          </button>
          <button className="capsule capsule--sm" onClick={() => void togglePreview()} aria-pressed={preview.status === 'open'}>
            <IconEye size={12} />
            {preview.status === 'open' || preview.status === 'loading' ? 'Hide preview' : 'Preview'}
          </button>
          <button
            className="capsule capsule--sm capsule--ghost"
            onClick={() => useSky.getState().toggleImports()}
            aria-pressed={showImports}
            title="Draw this file's imports in the city"
          >
            <IconLink size={12} />
            {showImports ? 'Imports on' : 'Show imports'}
          </button>
        </div>
      </div>

      <div className="inspector__body">
        {explain.status !== 'idle' && (
          <div className="section">
            <div className="section__head">
              <span className="t-caption">Explanation</span>
              <span className="faint" style={{ fontSize: 11 }}>
                local model
              </span>
            </div>
            <div className="explain selectable">
              {explain.status === 'loading' && <div className="text-shine" style={{ fontSize: 12.5 }}>Reading the file…</div>}
              {explain.status === 'done' && <Markdown text={explain.text ?? ''} />}
              {explain.status === 'error' && <div className="muted" style={{ fontSize: 12.5 }}>{explain.text}</div>}
            </div>
          </div>
        )}

        {preview.status !== 'closed' && (
          <div className="section">
            <div className="section__head">
              <span className="t-caption">Preview</span>
              {preview.truncated && (
                <span className="faint" style={{ fontSize: 11 }}>
                  first {PREVIEW_LINES} lines
                </span>
              )}
            </div>
            {preview.status === 'loading' && <div className="skeleton" style={{ height: 120 }} />}
            {preview.status === 'error' && <div className="muted" style={{ fontSize: 12.5 }}>This file could not be read.</div>}
            {preview.status === 'open' && <CodeView lines={preview.lines ?? []} />}
          </div>
        )}

        <div className="section">
          <div className="section__head">
            <span className="t-caption">Agents</span>
            <span className="faint" style={{ fontSize: 11 }}>
              {touches.length}
            </span>
          </div>
          {touches.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              No agent has touched this file in the recorded history.
            </div>
          ) : (
            touches.map(([agentId, t]) => {
              const a = agentById.get(agentId)
              const name = agentId === 'fs' ? 'Unattributed changes' : a?.name ?? agentId
              return (
                <div className="touch-row" key={agentId}>
                  <span className="orb" style={{ ['--c' as string]: agentId === 'fs' ? '#94A3B8' : a?.color ?? '#fff' }} />
                  <span className="touch-row__name" title={name}>
                    {name}
                  </span>
                  <span className="touch-row__count">
                    {t.edits} edits · {t.reads} reads
                  </span>
                </div>
              )
            })
          )}
        </div>

        <div className="section">
          <div className="section__head">
            <span className="t-caption">Recent activity</span>
          </div>
          {fileEvents.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              Nothing recorded for this file yet.
            </div>
          ) : (
            fileEvents.slice(0, 8).map((e) => {
              const meta = EVENT_META[e.type]
              const who = e.agentId === 'fs' ? 'fs' : agentById.get(e.agentId)?.name ?? e.agentId
              return (
                <div className="event-row" key={e.id} title={`${meta.verb} by ${who}`}>
                  <meta.Icon size={14} />
                  <span className="event-row__text" style={{ fontFamily: 'var(--font-text)', fontSize: 12 }}>
                    {meta.verb} <span className="faint">by {who}</span>
                  </span>
                  <span className="event-row__time">{relativeTime(e.ts, now)}</span>
                </div>
              )
            })
          )}
        </div>

        {imports.length > 0 && (
          <div className="section">
            <div className="section__head">
              <span className="t-caption">Imports</span>
              <span className="faint" style={{ fontSize: 11 }}>
                {imports.length}
              </span>
            </div>
            <ul className="import-list">
              {imports.slice(0, 12).map((p) => (
                <li key={p}>
                  <button onClick={() => useSky.getState().select(p)} title={p}>
                    {middleEllipsis(p, 40)}
                  </button>
                </li>
              ))}
            </ul>
            {imports.length > 12 && (
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                +{imports.length - 12} more
              </div>
            )}
          </div>
        )}

        {fileCommits.length > 0 && (
          <div className="section">
            <div className="section__head">
              <span className="t-caption">History</span>
              <span className="faint" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: 'var(--success)' }}>+{churn.added}</span>{' '}
                <span style={{ color: 'var(--danger)' }}>−{churn.removed}</span>
              </span>
            </div>
            {fileCommits.slice(0, 4).map((c) => (
              <div className="event-row" key={c.hash} title={c.subject} style={{ gridTemplateColumns: '52px minmax(0, 1fr) auto' }}>
                <span className="faint" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                  {c.hash.slice(0, 7)}
                </span>
                <span className="event-row__text" style={{ fontFamily: 'var(--font-text)', fontSize: 12 }}>
                  {c.subject}
                </span>
                <span className="event-row__time">{relativeTime(c.ts, now)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="section faint" style={{ fontSize: 11 }}>
          <span className="selectable" title={path}>
            {basename(path)} in {dirname(path) || 'repository root'}
          </span>
        </div>
      </div>
    </aside>
  )
}
