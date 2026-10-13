import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentInfo } from '../../../shared/types'
import { heuristicDigest, heuristicExplain } from '../heuristic'
import { formatDuration } from '../text'

const T0 = 1_780_000_000_000
const MIN = 60_000

let seq = 0
function ev(agentId: string, type: AgentEvent['type'], ts: number, extra: Partial<AgentEvent> = {}): AgentEvent {
  seq++
  return { id: `ev-${seq}`, agentId, type, ts, ...extra }
}

function agent(id: string, name: string, kind: AgentInfo['kind'], costUsd: number): AgentInfo {
  return {
    id,
    kind,
    name,
    cwd: '/repo',
    startedAt: T0,
    lastActiveAt: T0,
    status: 'idle',
    costUsd,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    filesTouched: [],
    edits: 0,
    reads: 0,
    commands: 0,
    color: '#ffffff'
  }
}

/** Scenario: two active agents, one idle agent, and one unattributed edit. */
function scenario() {
  const events: AgentEvent[] = []
  const at = (i: number) => T0 + i * MIN
  // Agent a81457: 10 changes in src/main/agents, 3 reads, 5 commands (4 test runs).
  events.push(ev('a81457', 'edit', at(0), { file: 'src/main/agents/hub.ts', linesAdded: 4 }))
  for (let i = 1; i < 5; i++) events.push(ev('a81457', 'edit', at(i), { file: 'src/main/agents/hub.ts' }))
  for (let i = 0; i < 3; i++) events.push(ev('a81457', 'edit', at(5 + i), { file: 'src/main/agents/claude.ts' }))
  for (let i = 0; i < 2; i++) events.push(ev('a81457', 'edit', at(8 + i), { file: 'src/main/agents/tail.ts' }))
  events.push(ev('a81457', 'read', at(10), { file: 'src/shared/types.ts' }))
  events.push(ev('a81457', 'read', at(11), { file: 'src/shared/types.ts' }))
  events.push(ev('a81457', 'read', at(12), { file: 'src/main/agents/hub.ts' }))
  events.push(ev('a81457', 'command', at(13), { text: 'npm test' }))
  events.push(ev('a81457', 'command', at(14), { text: 'npm test' }))
  events.push(ev('a81457', 'command', at(15), { text: 'npm test' }))
  events.push(ev('a81457', 'command', at(16), { text: 'npx vitest run src/main/agents' }))
  events.push(ev('a81457', 'command', at(17), { text: 'git status' }))
  // Agent b2: 6 changes (4 in the renderer HUD, 2 in llm), 2 build commands.
  for (let i = 0; i < 4; i++) events.push(ev('b2', 'edit', at(20 + i), { file: 'src/renderer/src/hud/Inspector.tsx' }))
  for (let i = 0; i < 2; i++) events.push(ev('b2', 'edit', at(25 + i), { file: 'src/main/llm/local.ts' }))
  events.push(ev('b2', 'command', at(27), { text: 'npm run build' }))
  events.push(ev('b2', 'command', at(28), { text: 'npm run build' }))
  // Unattributed change from outside any agent.
  events.push(ev('fs', 'edit', at(30), { file: 'README.md' }))
  // The span runs from T0 to now, which is 2h 14m.
  const agents = [
    agent('a81457', 'Claude · a81457', 'claude-code', 1.2),
    agent('b2', 'Codex · b2', 'codex', 0.64),
    agent('c9', 'Claude · c9', 'claude-code', 3.5) // idle: no events in the window
  ]
  return { events, agents, now: T0 + 2 * 60 * MIN + 14 * MIN }
}

describe('formatDuration', () => {
  it('formats short, medium and long spans', () => {
    expect(formatDuration(0)).toBe('<1m')
    expect(formatDuration(59_999)).toBe('<1m')
    expect(formatDuration(MIN)).toBe('1m')
    expect(formatDuration(2 * 60 * MIN + 14 * MIN)).toBe('2h 14m')
    expect(formatDuration(2 * 60 * MIN)).toBe('2h')
    expect(formatDuration(26 * 60 * MIN)).toBe('1d 2h')
  })
})

describe('heuristicDigest', () => {
  it('produces the exact digest for the synthetic scenario', () => {
    const { events, agents, now } = scenario()
    const text = heuristicDigest(events, agents, now)
    expect(text).toBe(
      [
        'While you were away (2h 14m), 2 agents made 16 edits across 5 files and ran 7 commands, spending $1.84.',
        '',
        '- **Claude · a81457** — mostly in `src/main/agents` (edited hub.ts, claude.ts, tail.ts), ran tests 4× and ran 1 other command.',
        '- **Codex · b2** — mostly in `src/renderer/src/hud` (edited Inspector.tsx, local.ts) and ran 2 other commands.',
        '- **Unattributed** — 1 change in 1 file not tied to any agent.',
        '',
        'Hotspots: `src/main/agents/hub.ts` (5 edits), `src/renderer/src/hud/Inspector.tsx` (4 edits), `src/main/agents/claude.ts` (3 edits).'
      ].join('\n')
    )
  })

  it('is a pure function of its inputs', () => {
    const { events, agents, now } = scenario()
    expect(heuristicDigest(events, agents, now)).toBe(heuristicDigest([...events], [...agents], now))
  })

  it('leaves out agents with no events in the window', () => {
    const { events, agents, now } = scenario()
    expect(heuristicDigest(events, agents, now)).not.toContain('c9')
  })

  it('says so when nothing happened', () => {
    expect(heuristicDigest([], [], T0)).toBe('All quiet: no agent activity was recorded in this window.')
  })

  it('describes changes that no agent made', () => {
    const events = [ev('fs', 'edit', T0, { file: 'docs/a.md' }), ev('fs', 'create', T0 + MIN, { file: 'docs/b.md' })]
    const text = heuristicDigest(events, [], T0 + MIN)
    expect(text.split('\n')[0]).toBe('While you were away (1m), 2 changes to 2 files came from outside any agent.')
    expect(text).toContain('Hotspots: `docs/a.md` (1 edit), `docs/b.md` (1 edit).')
  })

  it('treats a 1-minute, one-agent session with reads only correctly', () => {
    const events = [ev('a', 'read', T0, { file: 'x.ts' }), ev('a', 'read', T0 + 1000, { file: 'y.ts' })]
    const text = heuristicDigest(events, [agent('a', 'Claude · a', 'claude-code', 0)], T0 + 30_000)
    expect(text).toBe(
      ['While you were away (<1m), 1 agent read 2 files.', '', '- **Claude · a** — read 2 files.'].join('\n')
    )
  })
})

describe('heuristicExplain', () => {
  const source = [
    "import { a } from './a'",
    "import type { B } from './b'",
    'export interface Thing { x: number }',
    'export const VALUE = 1',
    'export function run(x: number) { return x }',
    'function helper() {}',
    'export class Engine {}',
    'export { helper as aliasHelper }',
    '  function nested() {}',
    ''
  ].join('\n')

  it('reports language, lines of code, exports, functions and imports', () => {
    const text = heuristicExplain('src/x.ts', source, 'acme')
    expect(text).toContain('`src/x.ts` is a TypeScript file in acme with 9 lines of code.')
    for (const name of ['Engine', 'Thing', 'VALUE', 'run', 'aliasHelper']) expect(text).toContain(`\`${name}\``)
    expect(text).toContain('defines 1 function `helper`')
    expect(text).not.toContain('`nested`')
    expect(text).toContain('imports 2 modules')
    expect(text).toContain('Heuristic summary')
  })

  it('uses a neutral label for unknown extensions and handles files with no declarations', () => {
    const text = heuristicExplain('notes/data.xyz', 'hello\nworld\n', 'acme')
    expect(text).toContain('is a source file in acme with 2 lines of code.')
    expect(text).toContain('no top-level declarations')
  })

  it('recognises Python and Rust declarations', () => {
    const py = heuristicExplain('tool.py', 'import os\n\ndef main():\n    pass\n\nclass Cfg:\n    pass\n', 'r')
    expect(py).toContain('Python file')
    expect(py).toContain('defines 1 function `main`')
    expect(py).toContain('declares 1 class or type `Cfg`')
    const rs = heuristicExplain('src/lib.rs', 'use std::fmt;\npub fn go() {}\npub struct Node {}\n', 'r')
    expect(rs).toContain('Rust file')
    expect(rs).toContain('`go`')
    expect(rs).toContain('`Node`')
    expect(rs).toContain('imports 1 module')
  })
})
