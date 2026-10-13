// Derived city data: what heat to show for the current mode, and which agents get a drone.
import { useMemo } from 'react'
import { useSky, heatAt, type Heat, type Mode } from '../state/store'
import type { AgentEvent, AgentEventType, AgentInfo, AgentStatus } from '@shared/types'
import { agentColor } from '@shared/color'

/** Pseudo-agent for unattributed filesystem changes: heat only, no drone. */
export const FS_AGENT = 'fs'
export const FS_COLOR = '#8fa8c8'

/** A replayed agent counts as idle once its last event is this old (ms). */
const REPLAY_IDLE_MS = 15000

const NO_HEAT: Record<string, Heat> = {}
const NO_SOURCES: DroneSource[] = []
const NO_EVENTS: AgentEvent[] = []

export interface DroneSource {
  id: string;
  name: string;
  color: string;
  status: AgentStatus;
  file?: string;
}

/** Hex color for an agent, falling back to the stable hash color. */
export function agentHex(agentId: string, agents: readonly AgentInfo[]): string {
  if (agentId === FS_AGENT) return FS_COLOR
  const a = agents.find((x) => x.id === agentId)
  return a ? a.color : agentColor(agentId)
}

let heatCache: { events: AgentEvent[]; ts: number; out: Record<string, Heat> } | null = null

/** Heat for the current mode: live touches, the state as of replayTs, or none in git mode. */
export function resolveHeat(s: { mode: Mode; heat: Record<string, Heat>; events: AgentEvent[]; replayTs: number | null }): Record<string, Heat> {
  if (s.mode === 'git') return NO_HEAT
  if (s.mode === 'live') return s.heat
  if (s.replayTs === null) return NO_HEAT
  if (heatCache && heatCache.events === s.events && heatCache.ts === s.replayTs) return heatCache.out
  const out = heatAt(s, s.replayTs)
  heatCache = { events: s.events, ts: s.replayTs, out }
  return out
}

function statusFor(t: AgentEventType): AgentStatus {
  switch (t) {
    case 'read': return 'reading'
    case 'edit':
    case 'create':
    case 'delete': return 'editing'
    case 'command': return 'running'
    case 'message':
    case 'thinking':
    case 'tokens':
    case 'spawn': return 'thinking'
    default: return 'idle'
  }
}

/** Drone state for the replay view: each agent where its latest event at or before ts left it. */
function replayAt(agents: readonly AgentInfo[], events: readonly AgentEvent[], ts: number): DroneSource[] {
  const last = new Map<string, AgentEvent>()
  const lastFile = new Map<string, string>()
  for (const e of events) {
    if (e.ts > ts) break
    if (e.agentId === FS_AGENT) continue
    last.set(e.agentId, e)
    if (e.file) lastFile.set(e.agentId, e.file)
  }
  const out: DroneSource[] = []
  for (const a of agents) {
    if (a.id === FS_AGENT || a.startedAt > ts) continue
    const e = last.get(a.id)
    if (!e || e.type === 'end') continue
    const idle = ts - e.ts > REPLAY_IDLE_MS
    out.push({
      id: a.id,
      name: a.name,
      color: a.color,
      status: idle ? 'idle' : statusFor(e.type),
      file: lastFile.get(a.id)
    })
  }
  return out
}

/** Drones for the current mode. Git time-lapse shows none (drones would hover over unbuilt ground). */
export function useDroneSources(): DroneSource[] {
  const mode = useSky((s) => s.mode)
  const agents = useSky((s) => s.agents)
  const events = useSky((s) => (s.mode === 'replay' ? s.events : NO_EVENTS))
  const replayTs = useSky((s) => (s.mode === 'replay' ? s.replayTs : null))
  return useMemo(() => {
    if (mode === 'git') return NO_SOURCES
    if (mode === 'replay') return replayTs === null ? NO_SOURCES : replayAt(agents, events, replayTs)
    return agents
      .filter((a) => a.id !== FS_AGENT && a.status !== 'done')
      .map((a) => ({ id: a.id, name: a.name, color: a.color, status: a.status, file: a.currentFile }))
  }, [mode, agents, events, replayTs])
}
