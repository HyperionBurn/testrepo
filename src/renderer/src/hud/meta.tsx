// Visual metadata for agent statuses and event types, plus the status pill.
import type { AgentEventType, AgentStatus } from '@shared/types'
import type { ComponentType } from 'react'
import { IconCheck, IconCoins, IconDots, IconEye, IconFilePlus, IconMessage, IconMoon, IconPencil, IconSparkle, IconTerminal, IconTrash, IconBranch, IconSplit } from './icons'

export interface StatusMeta {
  label: string;
  color: string;
  Icon: ComponentType<{ size?: number }>;
}

export const STATUS_META: Record<AgentStatus, StatusMeta> = {
  thinking: { label: 'Thinking', color: '#BF5AF2', Icon: IconSparkle },
  editing: { label: 'Editing', color: '#FF9F0A', Icon: IconPencil },
  reading: { label: 'Reading', color: '#64D2FF', Icon: IconEye },
  running: { label: 'Running', color: '#FFD60A', Icon: IconTerminal },
  idle: { label: 'Idle', color: '#8E8E93', Icon: IconMoon },
  done: { label: 'Done', color: '#30D158', Icon: IconCheck }
}

export function isActive(status: AgentStatus): boolean {
  return status === 'thinking' || status === 'editing' || status === 'reading' || status === 'running'
}

export interface EventMeta {
  verb: string;
  color: string;
  Icon: ComponentType<{ size?: number }>;
}

export const EVENT_META: Record<AgentEventType, EventMeta> = {
  read: { verb: 'Read', color: '#64D2FF', Icon: IconEye },
  edit: { verb: 'Edited', color: '#FF9F0A', Icon: IconPencil },
  create: { verb: 'Created', color: '#30D158', Icon: IconFilePlus },
  delete: { verb: 'Deleted', color: '#FF453A', Icon: IconTrash },
  command: { verb: 'Ran', color: '#FFD60A', Icon: IconTerminal },
  message: { verb: 'Said', color: 'rgba(255,255,255,.64)', Icon: IconMessage },
  thinking: { verb: 'Thought', color: '#BF5AF2', Icon: IconDots },
  tokens: { verb: 'Tokens', color: 'rgba(255,255,255,.42)', Icon: IconCoins },
  spawn: { verb: 'Spawned', color: '#5E5CE6', Icon: IconSplit },
  end: { verb: 'Finished', color: '#30D158', Icon: IconBranch }
}

export function StatusPill({ status }: { status: AgentStatus }) {
  const m = STATUS_META[status]
  return (
    <span className="pill" style={{ ['--c' as string]: m.color }} title={m.label}>
      <m.Icon size={11} />
      {m.label}
    </span>
  )
}
