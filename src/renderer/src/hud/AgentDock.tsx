// Left floating dock: one card per agent (nested subagents), with an activity tab and a collapsed orb rail.
import { useMemo } from 'react'
import type { AgentEvent, AgentInfo } from '@shared/types'
import { useSky } from '../state/store'
import { useUi, type DockTab } from '../lib/ui'
import { compactNumber, middleEllipsis, modelShort, relativeTime, usd } from '../lib/format'
import { useNow } from '../lib/hooks'
import { FS_AGENT } from '../city/data'
import { isActive, StatusPill } from './meta'
import { sortDockAgents } from './dockOrder'
import { ActivityFeed } from './ActivityFeed'
import { IconDoc, IconPlus, IconSidebar, IconSparkle } from './icons'

const SPARK_MINUTES = 30

/** Per-agent event counts for each of the last 30 minutes (oldest first). Events are ascending by ts. */
export function buildSparks(events: readonly AgentEvent[], now: number): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const start = now - SPARK_MINUTES * 60_000
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.ts < start) break
    const idx = SPARK_MINUTES - 1 - Math.floor((now - e.ts) / 60_000)
    if (idx < 0 || idx >= SPARK_MINUTES) continue
    let arr = out.get(e.agentId)
    if (!arr) {
      arr = new Array<number>(SPARK_MINUTES).fill(0)
      out.set(e.agentId, arr)
    }
    arr[idx] = (arr[idx] ?? 0) + 1
  }
  return out
}

export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 84
  const h = 22
  const max = Math.max(1, ...values)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => [i * step, h - 2 - (v / max) * (h - 6)] as const)
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const area = `${line} L${w} ${h} L0 ${h} Z`
  const last = pts[pts.length - 1]
  const flat = values.every((v) => v === 0)
  return (
    <svg className="agent-card__spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {flat ? (
        <line x1="0" x2={w} y1={h - 2} y2={h - 2} stroke="rgba(255,255,255,.14)" strokeWidth="1" strokeDasharray="2 3" />
      ) : (
        <>
          <path d={area} fill={color} fillOpacity={0.16} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
          {last && <circle cx={last[0]} cy={last[1]} r={2.1} fill={color} />}
        </>
      )}
    </svg>
  )
}

function fileOf(a: AgentInfo): string | undefined {
  return a.currentFile || undefined
}

function AgentCard({
  agent,
  focused,
  spark,
  now,
  child = false
}: {
  agent: AgentInfo;
  focused: boolean;
  spark: number[] | undefined;
  now: number;
  child?: boolean;
}) {
  const active = isActive(agent.status)
  const file = fileOf(agent)
  const focus = () => {
    const s = useSky.getState()
    s.focusAgent(agent.id)
    if (file) s.select(file)
  }
  // The 'fs' pseudo-agent is filesystem changes no agent claimed: it has no kind and no model.
  const isFs = agent.id === FS_AGENT
  const kind = isFs ? 'Filesystem' : agent.kind === 'claude-code' ? 'Claude Code' : agent.kind === 'codex' ? 'Codex' : 'Agent'
  return (
    <div
      role="button"
      tabIndex={0}
      className={`agent-card sheen${child ? ' agent-card--child' : ''}`}
      data-focus={focused}
      style={{ ['--c' as string]: agent.color }}
      onClick={focus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          focus()
        }
      }}
      onMouseEnter={() => file && useSky.getState().hover(file)}
      onMouseLeave={() => useSky.getState().hover(null)}
      title={agent.lastMessage ?? agent.name}
    >
      <div className="agent-card__top">
        <span className={`orb${active ? ' orb--active' : ''}`} />
        <span className="agent-card__name">{agent.name}</span>
        <StatusPill status={agent.status} />
      </div>
      <div className="agent-card__sub">
        <span>{kind}</span>
        {!isFs && (
          <>
            <span aria-hidden="true">·</span>
            <span>{modelShort(agent.model)}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="num">{relativeTime(agent.lastActiveAt, now)}</span>
      </div>
      {file && (
        <div className="agent-card__file">
          <IconDoc size={12} />
          <span className="ellipsis" title={file}>
            {middleEllipsis(file, 36)}
          </span>
        </div>
      )}
      {agent.lastAction && (
        <div className="ellipsis faint" style={{ fontSize: 11.5 }}>
          {agent.lastAction}
        </div>
      )}
      <div className="agent-card__foot">
        <div className="agent-card__stats">
          <span>
            in <b>{compactNumber(agent.tokens.input)}</b> · out <b>{compactNumber(agent.tokens.output)}</b>
          </span>
          <span>
            <b>{usd(agent.costUsd)}</b> · {agent.edits} edits · {agent.reads} reads
          </span>
        </div>
        <Sparkline values={spark ?? new Array<number>(SPARK_MINUTES).fill(0)} color={agent.color} />
      </div>
    </div>
  )
}

function AgentList({ agents, now }: { agents: AgentInfo[]; now: number }) {
  const focusAgentId = useSky((s) => s.focusAgentId)
  const events = useSky((s) => s.events)
  const sparks = useMemo(() => buildSparks(events, now), [events, now])

  const byId = new Map(agents.map((a) => [a.id, a] as const))
  const byRecency = (a: AgentInfo, b: AgentInfo) => b.lastActiveAt - a.lastActiveAt
  const children = new Map<string, AgentInfo[]>()
  const roots: AgentInfo[] = []
  for (const a of agents) {
    // The filesystem pseudo-agent never nests under a parent: it is always a top-level card, last.
    if (a.id !== FS_AGENT && a.parentId && byId.has(a.parentId)) {
      const list = children.get(a.parentId) ?? []
      list.push(a)
      children.set(a.parentId, list)
    } else {
      roots.push(a)
    }
  }
  const ordered = sortDockAgents(roots, FS_AGENT)

  return (
    <>
      {ordered.map((a) => {
        const kids = (children.get(a.id) ?? []).sort(byRecency)
        return (
          <div key={a.id} className="dock__group">
            <AgentCard agent={a} focused={focusAgentId === a.id} spark={sparks.get(a.id)} now={now} />
            {kids.length > 0 && (
              <div className="agent-children">
                {kids.map((k) => (
                  <div className="agent-child" key={k.id}>
                    <AgentCard agent={k} focused={focusAgentId === k.id} spark={sparks.get(k.id)} now={now} child />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function TabSwitch({ tab }: { tab: DockTab }) {
  const setTab = useUi((s) => s.setDockTab)
  const idx = tab === 'agents' ? 0 : 1
  return (
    <div className="seg" style={{ ['--n' as string]: 2, ['--i' as string]: idx, width: '100%', marginBottom: 2 }} role="tablist">
      <span className="seg__thumb" />
      <button className="seg__btn" role="tab" aria-selected={tab === 'agents'} onClick={() => setTab('agents')}>
        Agents
      </button>
      <button className="seg__btn" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
        Activity
      </button>
    </div>
  )
}

export function AgentDock() {
  const agents = useSky((s) => s.agents)
  const focusAgentId = useSky((s) => s.focusAgentId)
  const collapsed = useUi((s) => s.dockCollapsed)
  const tab = useUi((s) => s.dockTab)
  const toggleDock = useUi((s) => s.toggleDock)
  const openDispatch = () => useUi.getState().setDispatch(true)
  const now = useNow(15_000)

  const activeCount = agents.filter((a) => isActive(a.status)).length

  if (collapsed) {
    const sorted = sortDockAgents(agents, FS_AGENT)
    return (
      <aside className="dock dock--collapsed glass" aria-label="Agents">
        <div className="dock__head" style={{ justifyContent: 'center', padding: '10px 0', minHeight: 0 }}>
          <button className="icon-btn" onClick={toggleDock} title="Expand agents" aria-label="Expand agents">
            <IconSidebar size={16} />
          </button>
        </div>
        <div className="dock__collapsed-list">
          {sorted.map((a) => (
            <button
              key={a.id}
              className="dock__collapsed-orb"
              data-focus={focusAgentId === a.id}
              style={{ ['--c' as string]: a.color }}
              title={`${a.name} · ${a.status}`}
              aria-label={`${a.name}, ${a.status}`}
              onClick={() => {
                const s = useSky.getState()
                s.focusAgent(a.id)
                if (a.currentFile) s.select(a.currentFile)
              }}
            >
              <span className={`orb${isActive(a.status) ? ' orb--active' : ''}`} />
            </button>
          ))}
        </div>
        <div style={{ padding: '6px 0 12px', display: 'flex', justifyContent: 'center' }}>
          <button className="icon-btn" onClick={openDispatch} title="Dispatch an agent (D)" aria-label="Dispatch an agent">
            <IconPlus size={16} />
          </button>
        </div>
      </aside>
    )
  }

  const title = tab === 'agents' ? `Agents${activeCount > 0 ? ` · ${activeCount} active` : ''}` : 'Activity'

  return (
    <aside className="dock glass" aria-label="Agent dock">
      <div className="dock__head">
        <div className="dock__title" title={title}>
          {title}
        </div>
        <button
          className="capsule capsule--sm capsule--primary"
          onClick={openDispatch}
          title="Dispatch an agent (D)"
        >
          <IconPlus size={11} />
          Dispatch
        </button>
        <button className="icon-btn" onClick={toggleDock} title="Collapse" aria-label="Collapse agent dock">
          <IconSidebar size={16} />
        </button>
      </div>
      <div style={{ padding: '0 10px 8px' }}>
        <TabSwitch tab={tab} />
      </div>

      {tab === 'agents' ? (
        <div className="dock__list">
          {agents.length === 0 ? (
            <div className="empty">
              <div className="empty__glyph">
                <IconSparkle size={18} />
              </div>
              <div>No agents yet.</div>
              <div>Start Claude Code or Codex in this repo — they'll appear here automatically.</div>
            </div>
          ) : (
            <AgentList agents={agents} now={now} />
          )}
        </div>
      ) : (
        <ActivityFeed />
      )}

      <div className="dock__foot">
        Listening to Claude Code and Codex sessions in this repo.
      </div>
    </aside>
  )
}
