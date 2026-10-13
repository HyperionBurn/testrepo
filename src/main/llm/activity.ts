// Aggregates raw AgentEvents into per-agent activity. Shared by the heuristic digest and the
// LLM prompt compaction so both describe the same numbers. Pure: no I/O, no clock reads.
import type { AgentEvent, AgentInfo } from '../../shared/types'
import { squash } from './text'

/** agentId the hub uses for filesystem changes that no agent explains. */
export const UNATTRIBUTED_ID = 'fs'

const CHANGE_TYPES: ReadonlySet<AgentEvent['type']> = new Set(['edit', 'create', 'delete'])
// Matches commands that run a test suite, not any command that mentions "test" in a path.
const TEST_RUN_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|vitest\b|jest\b|pytest\b|mocha\b|rspec\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|gradle\s+test\b|make\s+test\b)/i

const COMMAND_MAX = 80
const MESSAGE_MAX = 200
const MESSAGE_KEEP = 3

export interface FileTally {
  path: string;
  changes: number;
  added: number;
  removed: number;
  lastTs: number;
}

export interface CommandTally {
  text: string;
  count: number;
  lastTs: number;
}

export interface ActivityGroup {
  agentId: string;
  /** Undefined for the unattributed group and for ids missing from the agents list. */
  agent?: AgentInfo;
  name: string;
  /** edit + create + delete events. */
  changes: number;
  reads: number;
  commands: number;
  testRuns: number;
  spawns: number;
  files: Map<string, FileTally>;
  readFiles: Set<string>;
  commandTallies: Map<string, CommandTally>;
  /** Last few assistant message snippets, oldest first. */
  messages: string[];
  firstTs: number;
  lastTs: number;
}

export interface ActivitySummary {
  /** Timestamp of the earliest event, or `now` when there are no events. */
  start: number;
  /** One group per attributed agent that has events, in no particular order. */
  agentGroups: ActivityGroup[];
  /** Filesystem changes not attributed to any agent, if any. */
  unattributed?: ActivityGroup;
}

function emptyGroup(agentId: string, agent: AgentInfo | undefined, ts: number): ActivityGroup {
  const name = agent?.name ?? (agentId === UNATTRIBUTED_ID ? 'Unattributed' : agentId)
  return {
    agentId,
    agent,
    name,
    changes: 0,
    reads: 0,
    commands: 0,
    testRuns: 0,
    spawns: 0,
    files: new Map(),
    readFiles: new Set(),
    commandTallies: new Map(),
    messages: [],
    firstTs: ts,
    lastTs: ts
  }
}

export function isTestRun(command: string): boolean {
  return TEST_RUN_RE.test(command)
}

export function summarizeActivity(
  events: readonly AgentEvent[],
  agents: readonly AgentInfo[],
  now: number
): ActivitySummary {
  const byId = new Map<string, AgentInfo>()
  for (const a of agents) byId.set(a.id, a)

  // Chronological order keeps "last" fields and message order deterministic.
  const sorted = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const groups = new Map<string, ActivityGroup>()

  for (const e of sorted) {
    let g = groups.get(e.agentId)
    if (!g) {
      g = emptyGroup(e.agentId, byId.get(e.agentId), e.ts)
      groups.set(e.agentId, g)
    }
    g.lastTs = e.ts

    if (CHANGE_TYPES.has(e.type)) {
      g.changes++
      if (e.file) {
        const t = g.files.get(e.file) ?? { path: e.file, changes: 0, added: 0, removed: 0, lastTs: e.ts }
        t.changes++
        t.added += e.linesAdded ?? 0
        t.removed += e.linesRemoved ?? 0
        t.lastTs = e.ts
        g.files.set(e.file, t)
      }
      continue
    }

    switch (e.type) {
      case 'read':
        g.reads++
        if (e.file) g.readFiles.add(e.file)
        break
      case 'command': {
        const text = squash(e.text ?? '', COMMAND_MAX)
        g.commands++
        if (isTestRun(text)) g.testRuns++
        if (text) {
          const c = g.commandTallies.get(text) ?? { text, count: 0, lastTs: e.ts }
          c.count++
          c.lastTs = e.ts
          g.commandTallies.set(text, c)
        }
        break
      }
      case 'spawn':
        g.spawns++
        break
      case 'message': {
        const text = squash(e.text ?? '', MESSAGE_MAX)
        if (text) {
          g.messages.push(text)
          if (g.messages.length > MESSAGE_KEEP) g.messages.shift()
        }
        break
      }
      default:
        break
    }
  }

  const unattributed = groups.get(UNATTRIBUTED_ID)
  const agentGroups = [...groups.values()].filter((g) => g.agentId !== UNATTRIBUTED_ID)
  return {
    start: sorted.length > 0 ? sorted[0].ts : now,
    agentGroups,
    unattributed
  }
}

/** Changed files of a group, most recently changed first. */
export function changedFilesByRecency(g: ActivityGroup): FileTally[] {
  return [...g.files.values()].sort((a, b) => b.lastTs - a.lastTs || (a.path < b.path ? -1 : 1))
}

/** Commands of a group, most recently run first. */
export function commandsByRecency(g: ActivityGroup): CommandTally[] {
  return [...g.commandTallies.values()].sort((a, b) => b.lastTs - a.lastTs || (a.text < b.text ? -1 : 1))
}
