// Ctrl/⌘K palette: jump to files and agents, or run an action. Arrow keys + Enter; Esc closes (App handles Esc).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentEvent, AgentInfo, FileNode } from '@shared/types'
import { useSky } from '../state/store'
import { useUi } from '../lib/ui'
import { basename, dirname, fuzzyScore, middleEllipsis } from '../lib/format'
import { COLOR_MODE_LABEL, type ColorMode } from '../lib/colorModes'
import { pickAndOpen, setMode } from '../lib/actions'
import { Overlay } from './Overlay'
import { IconArrowRight, IconClock, IconDoc, IconFolder, IconLink, IconSend, IconSparkle, IconWave, IconReplay } from './icons'

const COLOR_ACTION_META: Record<ColorMode, { sub: string; icon: ReactNode }> = {
  area: { sub: 'One hue per neighborhood', icon: <IconFolder size={13} /> },
  language: { sub: 'Color by file type', icon: <IconDoc size={13} /> },
  churn: { sub: 'Most-committed files glow hot', icon: <IconSparkle size={13} /> },
  age: { sub: 'Recently changed files glow mint', icon: <IconClock size={13} /> }
}

interface Item {
  key: string;
  group: 'Actions' | 'Agents' | 'Files' | 'Recently touched';
  label: string;
  sub?: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

const FILE_LIMIT = 12
const AGENT_LIMIT = 6

function close(): void {
  useUi.getState().setPalette(false)
}

function colorItems(current: ColorMode): Item[] {
  return (Object.keys(COLOR_ACTION_META) as ColorMode[]).map((m) => ({
    key: `a-color-${m}`,
    group: 'Actions',
    label: `Color by ${COLOR_MODE_LABEL[m].toLowerCase()}`,
    sub: m === current ? `${COLOR_ACTION_META[m].sub} · current` : COLOR_ACTION_META[m].sub,
    icon: COLOR_ACTION_META[m].icon,
    run: () => {
      close()
      useSky.getState().setColorMode(m)
    }
  }))
}

function actionItems(q: string, color: ColorMode): Item[] {
  const all: Item[] = [
    ...colorItems(color),
    {
      key: 'a-dispatch',
      group: 'Actions',
      label: 'Dispatch agent…',
      icon: <IconSend size={13} />,
      hint: 'D',
      run: () => {
        close()
        useUi.getState().setDispatch(true)
      }
    },
    {
      key: 'a-digest',
      group: 'Actions',
      label: 'Generate digest',
      sub: 'Summarise the last hour of agent activity',
      icon: <IconSparkle size={13} />,
      hint: 'G',
      run: () => {
        close()
        useUi.getState().openDigest(Date.now() - 3_600_000)
      }
    },
    {
      key: 'a-open',
      group: 'Actions',
      label: 'Open repository…',
      icon: <IconFolder size={13} />,
      hint: 'Ctrl O',
      run: () => {
        close()
        void pickAndOpen()
      }
    },
    {
      key: 'a-imports',
      group: 'Actions',
      label: 'Toggle imports',
      sub: 'Draw import edges between buildings',
      icon: <IconLink size={13} />,
      hint: 'I',
      run: () => {
        close()
        useSky.getState().toggleImports()
      }
    },
    {
      key: 'a-replay',
      group: 'Actions',
      label: 'Replay last hour',
      sub: 'Scrub the city back to one hour ago',
      icon: <IconReplay size={13} />,
      run: () => {
        close()
        const at = Date.now() - 3_600_000
        setMode('replay')
        useSky.getState().setReplayTs(at)
      }
    },
    {
      key: 'a-live',
      group: 'Actions',
      label: 'Live view',
      icon: <IconWave size={13} />,
      hint: '1',
      run: () => {
        close()
        setMode('live')
      }
    },
    {
      key: 'a-timelapse',
      group: 'Actions',
      label: 'Git time-lapse',
      sub: 'Watch the city grow from the first commit',
      icon: <IconClock size={13} />,
      hint: '3',
      run: () => {
        close()
        setMode('git')
      }
    },
    {
      key: 'a-frame',
      group: 'Actions',
      label: 'Frame the city',
      icon: <IconArrowRight size={13} />,
      hint: 'F',
      run: () => {
        close()
        useSky.getState().select(null)
      }
    }
  ]
  return q ? all.filter((a) => fuzzyScore(q, a.label) >= 0) : all
}

function agentItems(q: string, agents: readonly AgentInfo[]): Item[] {
  const sorted = agents.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const matched = q ? sorted.filter((a) => fuzzyScore(q, `${a.name} ${a.currentFile ?? ''}`) >= 0) : sorted
  return matched.slice(0, AGENT_LIMIT).map((a) => ({
    key: `g-${a.id}`,
    group: 'Agents',
    label: a.name,
    sub: a.currentFile ?? a.lastAction ?? a.status,
    icon: <span className="orb" style={{ ['--c' as string]: a.color, width: 8, height: 8 }} />,
    run: () => {
      close()
      const s = useSky.getState()
      s.focusAgent(a.id)
      if (a.currentFile) s.select(a.currentFile)
    }
  }))
}

function fileItems(q: string, files: readonly FileNode[], recent: readonly string[]): Item[] {
  if (!q) {
    return recent.slice(0, FILE_LIMIT).map((p) => fileItem(p, 'Recently touched'))
  }
  const scored: { p: string; s: number }[] = []
  for (const f of files) {
    const s = fuzzyScore(q, f.path)
    if (s >= 0) scored.push({ p: f.path, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, FILE_LIMIT).map((x) => fileItem(x.p, 'Files'))
}

function fileItem(path: string, group: Item['group']): Item {
  return {
    key: `f-${path}`,
    group,
    label: basename(path),
    sub: dirname(path) ? middleEllipsis(dirname(path), 60) : 'repository root',
    icon: <IconDoc size={13} />,
    run: () => {
      close()
      useSky.getState().select(path)
    }
  }
}

function recentlyTouched(events: readonly AgentEvent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = events.length - 1; i >= 0 && out.length < FILE_LIMIT; i--) {
    const f = events[i]?.file
    if (f && !seen.has(f)) {
      seen.add(f)
      out.push(f)
    }
  }
  return out
}

export function CommandBar() {
  const repo = useSky((s) => s.repo)
  const agents = useSky((s) => s.agents)
  const events = useSky((s) => s.events)
  const color = useSky((s) => s.colorMode)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const query = q.trim()
  const items = useMemo<Item[]>(() => {
    const files = repo?.files ?? []
    const groups = query
      ? [...agentItems(query, agents), ...fileItems(query, files, []), ...actionItems(query, color)]
      : [...actionItems('', color), ...agentItems('', agents), ...fileItems('', files, recentlyTouched(events))]
    return groups
  }, [query, repo, agents, events, color])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (items.length ? (i + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[active]?.run()
    }
  }

  // Render with group headers, keeping one flat index for keyboard selection.
  const rendered: ReactNode[] = []
  let lastGroup = ''
  items.forEach((it, idx) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group
      rendered.push(
        <div className="palette__group t-caption" key={`h-${it.group}-${idx}`}>
          {it.group}
        </div>
      )
    }
    rendered.push(
      <button
        key={it.key}
        className="pal-item"
        role="option"
        aria-selected={idx === active}
        data-idx={idx}
        onMouseMove={() => idx !== active && setActive(idx)}
        onClick={() => it.run()}
      >
        <span className="pal-item__icon">{it.icon}</span>
        <span className="pal-item__label">
          {it.label}
          {it.sub && <small>{it.sub}</small>}
        </span>
        {it.hint && (
          <span className="pal-item__hint">
            <span className="kbd">{it.hint}</span>
          </span>
        )}
      </button>
    )
  })

  return (
    <Overlay onClose={close} label="Command palette" placement="top">
      <div className="palette glass-strong">
        <div className="palette__input">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files, agents or actions…"
            aria-label="Command"
            aria-controls="palette-list"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 ? (
            <div className="empty" style={{ padding: '26px 16px' }}>
              No matches for “{query}”.
            </div>
          ) : (
            rendered
          )}
        </div>
        <div className="palette__foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> select
          </span>
          <span style={{ marginLeft: 'auto' }}>{repo ? `${repo.files.length.toLocaleString('en-US')} files indexed` : 'No repository'}</span>
        </div>
      </div>
    </Overlay>
  )
}
