import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, AgentInfo, Digest } from '../../../shared/types'
import { digestTotalsLine, heuristicDigest } from '../heuristic'
import { DEFAULT_MODEL_URI, LocalLlm, STILL_THINKING_MODEL } from '../local'
import { DIGEST_SYSTEM } from '../prompts'

const DEFAULT_FILE = 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
const T0 = 1_780_000_000_000
const MIN = 60_000

function agent(id: string, costUsd: number): AgentInfo {
  return {
    id,
    kind: 'claude-code',
    name: `Claude · ${id}`,
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

let seq = 0
function ev(agentId: string, type: AgentEvent['type'], ts: number, extra: Partial<AgentEvent> = {}): AgentEvent {
  seq++
  return { id: `e${seq}`, agentId, type, ts, ...extra }
}

/** 2 attributed agents over 2h 14m: 4 edits in 3 files, 3 commands, $1.84; plus one unattributed edit. */
function scenario(): { events: AgentEvent[]; agents: AgentInfo[]; now: number } {
  const events: AgentEvent[] = [
    ev('a1', 'edit', T0, { file: 'src/a.ts' }),
    ev('a1', 'edit', T0 + MIN, { file: 'src/a.ts' }),
    ev('a1', 'create', T0 + 2 * MIN, { file: 'src/a2.ts' }),
    ev('a1', 'read', T0 + 3 * MIN, { file: 'src/b.ts' }),
    ev('a1', 'command', T0 + 4 * MIN, { text: 'npm test' }),
    ev('a1', 'command', T0 + 5 * MIN, { text: 'git status' }),
    ev('b2', 'edit', T0 + 6 * MIN, { file: 'src/b.ts' }),
    ev('b2', 'command', T0 + 7 * MIN, { text: 'npm run build' }),
    ev('fs', 'edit', T0 + 8 * MIN, { file: 'README.md' })
  ]
  const agents = [agent('a1', 1.2), agent('b2', 0.64)]
  return { events, agents, now: T0 + 134 * MIN }
}

describe('digestTotalsLine', () => {
  it('states the exact totals, computed from the events and agents', () => {
    const { events, agents, now } = scenario()
    expect(digestTotalsLine(events, agents, now)).toBe('**2h 14m · 2 agents · 4 edits · 3 files · 3 commands · $1.84**')
  })

  it('counts attributed agents only, the same numbers the heuristic digest states', () => {
    const { events, agents, now } = scenario()
    const line = digestTotalsLine(events, agents, now)
    expect(line).not.toContain('5 edits')
    expect(heuristicDigest(events, agents, now)).toContain('made 4 edits across 3 files')
  })

  it('uses singular words and shows tiny costs as under a cent', () => {
    const events = [ev('a1', 'edit', T0, { file: 'x.ts' })]
    expect(digestTotalsLine(events, [agent('a1', 0.004)], T0)).toBe(
      '**<1m · 1 agent · 1 edit · 1 file · 0 commands · <$0.01**'
    )
  })

  it('is the quiet header for an empty window', () => {
    expect(digestTotalsLine([], [], T0)).toBe('**<1m · 0 agents · 0 edits · 0 files · 0 commands · $0.00**')
  })
})

describe('digest prompt', () => {
  it('tells the model not to state numeric totals, because the app prints them', () => {
    expect(DIGEST_SYSTEM).toMatch(/Do NOT state any numeric totals/)
    expect(DIGEST_SYSTEM).toMatch(/totals above your bullets/)
  })
})

type GenerateSeam = { generate(system: string, user: string, maxTokens: number): Promise<string> }

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('LocalLlm.digest', () => {
  let dir: string
  let llm: LocalLlm | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skyline-digest-'))
    // A placeholder model file makes the model "on disk", so digest() takes the model path.
    writeFileSync(path.join(dir, DEFAULT_FILE), 'placeholder')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await llm?.dispose()
    llm = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('puts the exact totals line above the model bullets', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 5000 })
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockResolvedValue('- Edited `src/a.ts` twice.\n- Ran the tests.')

    const d = await llm.digest(events, agents, 'acme')

    expect(d.model).toBe(DEFAULT_MODEL_URI)
    expect(d.text).toBe(`${digestTotalsLine(events, agents, d.generatedAt)}\n\n- Edited \`src/a.ts\` twice.\n- Ran the tests.`)
  })

  it('answers with the heuristic when the model misses the wait, then emits the model digest as an event', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 20 })
    let finish: (text: string) => void = () => undefined
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockImplementation(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    const late: Digest[] = []
    llm.on('digest', (d: Digest) => late.push(d))

    const quick = await llm.digest(events, agents, 'acme')

    expect(quick.model).toBe(STILL_THINKING_MODEL)
    expect(quick.text).toBe(heuristicDigest(events, agents, quick.generatedAt))
    expect(late).toEqual([])

    finish('- Edited `src/a.ts` twice.')
    await waitFor(() => late.length === 1)
    expect(late[0].model).toBe(DEFAULT_MODEL_URI)
    expect(late[0].text).toBe(`${digestTotalsLine(events, agents, quick.generatedAt)}\n\n- Edited \`src/a.ts\` twice.`)
  })

  it('falls back to the heuristic for a late digest when generation fails, so the UI can drop "still thinking"', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 20 })
    let fail: (err: Error) => void = () => undefined
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockImplementation(
      () => new Promise<string>((_resolve, reject) => (fail = reject))
    )
    const late: Digest[] = []
    llm.on('digest', (d: Digest) => late.push(d))

    const quick = await llm.digest(events, agents, 'acme')
    expect(quick.model).toBe(STILL_THINKING_MODEL)

    fail(new Error('boom'))
    await waitFor(() => late.length === 1)
    expect(late[0].model).toBe('heuristic')
  })
})

describe('LocalLlm.digest requestId', () => {
  let dir: string
  let llm: LocalLlm | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skyline-digest-id-'))
    writeFileSync(path.join(dir, DEFAULT_FILE), 'placeholder')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await llm?.dispose()
    llm = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('echoes the request id on the model digest', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 5000 })
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockResolvedValue('- Ran the tests.')

    const d = await llm.digest(events, agents, 'acme', 'req-1')

    expect(d.model).toBe(DEFAULT_MODEL_URI)
    expect(d.requestId).toBe('req-1')
  })

  it('echoes the request id on the heuristic answer for an empty window', async () => {
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 5000 })

    const d = await llm.digest([], [], 'acme', 'req-empty')

    expect(d.model).toBe('heuristic')
    expect(d.requestId).toBe('req-empty')
  })

  it('echoes the request id on the still-thinking answer and on its late digest', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 20 })
    let finish: (text: string) => void = () => undefined
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockImplementation(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    const late: Digest[] = []
    llm.on('digest', (d: Digest) => late.push(d))

    const quick = await llm.digest(events, agents, 'acme', 'req-slow')
    expect(quick.model).toBe(STILL_THINKING_MODEL)
    expect(quick.requestId).toBe('req-slow')

    finish('- Edited `src/a.ts` twice.')
    await waitFor(() => late.length === 1)
    expect(late[0].requestId).toBe('req-slow')
  })

  it('echoes the fallback id on a late digest after generation fails', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 20 })
    let fail: (err: Error) => void = () => undefined
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockImplementation(
      () => new Promise<string>((_resolve, reject) => (fail = reject))
    )
    const late: Digest[] = []
    llm.on('digest', (d: Digest) => late.push(d))

    await llm.digest(events, agents, 'acme', 'req-failed')
    fail(new Error('boom'))
    await waitFor(() => late.length === 1)

    expect(late[0].model).toBe('heuristic')
    expect(late[0].requestId).toBe('req-failed')
  })

  it('keeps each late digest on its own request when two requests overlap', async () => {
    const { events, agents } = scenario()
    llm = new LocalLlm({ modelsDir: dir, digestWaitMs: 20 })
    // Requests run one after another on the shared sequence, so each generate() call gets its own finisher.
    const finishers: Array<(text: string) => void> = []
    vi.spyOn(llm as unknown as GenerateSeam, 'generate').mockImplementation(
      () => new Promise<string>((resolve) => finishers.push(resolve))
    )
    const late: Digest[] = []
    llm.on('digest', (d: Digest) => late.push(d))

    const a = await llm.digest(events, agents, 'acme', 'req-a')
    const b = await llm.digest(events, agents, 'acme', 'req-b')
    expect([a.requestId, b.requestId]).toEqual(['req-a', 'req-b'])

    await waitFor(() => finishers.length === 1)
    finishers[0]('- first')
    await waitFor(() => late.length === 1)
    await waitFor(() => finishers.length === 2)
    finishers[1]('- second')
    await waitFor(() => late.length === 2)

    expect(late.map((d) => d.requestId)).toEqual(['req-a', 'req-b'])
    expect(late[1].text).toContain('- second')
  })
})
