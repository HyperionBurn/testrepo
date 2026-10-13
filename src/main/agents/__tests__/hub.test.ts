import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { AgentHub, FS_AGENT_ID } from '../hub'
import { encodeClaudeProjectDir } from '../claude'
import { costUsd } from '../../../shared/pricing'
import type { AgentEvent, AgentInfo } from '../../../shared/types'

const FX = path.join(__dirname, 'fixtures')
const SRC_REPO = '/work/demo-repo'

const S1 = 'S1-0000-4000-8000-000000000001'
const S2 = 'S2-subfolder-0000'
const S4 = 'S4-outside-cwd-0000'
const S5 = 'S5-stale-0000'
const SUB = 'abc123def456789'
const CODEX = 'codex-sess-0001'

const pad = (n: number): string => String(n).padStart(2, '0')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fixtureText(name: string, repoRoot: string): string {
  return readFileSync(path.join(FX, name), 'utf8').split(SRC_REPO).join(repoRoot)
}

interface Env {
  tmp: string
  repoRoot: string
  claudeHome: string
  codexHome: string
  projDir: string
  codexDayDir: string
}

function setupEnv(): Env {
  const tmp = mkdtempSync(path.join(tmpdir(), 'skyline-hub-'))
  const repoRoot = path.join(tmp, 'repo')
  mkdirSync(repoRoot, { recursive: true })
  const claudeHome = path.join(tmp, 'claude')
  const codexHome = path.join(tmp, 'codex')
  const projDir = path.join(claudeHome, 'projects', encodeClaudeProjectDir(repoRoot))
  mkdirSync(projDir, { recursive: true })

  // Main session with a subagent.
  writeFileSync(path.join(projDir, `${S1}.jsonl`), fixtureText('claude-session.jsonl', repoRoot))
  const subDir = path.join(projDir, S1, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(path.join(subDir, `agent-${SUB}.jsonl`), fixtureText('claude-subagent.jsonl', repoRoot))
  writeFileSync(path.join(subDir, `agent-${SUB}.meta.json`), readFileSync(path.join(FX, 'claude-subagent.meta.json')))

  // Session started in a subfolder of the repo: counts.
  const srcProj = path.join(claudeHome, 'projects', encodeClaudeProjectDir(path.join(repoRoot, 'src')))
  mkdirSync(srcProj, { recursive: true })
  const line = (uuid: string, cwd: string, sid: string, text: string) =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: sid,
      uuid,
      timestamp: new Date().toISOString(),
      message: { model: 'claude-haiku-5-5', id: `msg-${uuid}`, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    }) + '\n'
  writeFileSync(path.join(srcProj, `${S2}.jsonl`), line('s2a', path.join(repoRoot, 'src'), S2, 'Working in src.'))

  // Session dir matches the repo prefix but the recorded cwd is somewhere else: rejected.
  writeFileSync(path.join(srcProj, `${S4}.jsonl`), line('s4a', '/elsewhere/proj', S4, 'not ours'))

  // Session from another project entirely: never looked at.
  const otherProj = path.join(claudeHome, 'projects', encodeClaudeProjectDir('/elsewhere/proj'))
  mkdirSync(otherProj, { recursive: true })
  writeFileSync(path.join(otherProj, 'OTHER.jsonl'), line('o1', '/elsewhere/proj', 'OTHER', 'other'))

  // Stale session (older than maxAgeHours): skipped.
  const stale = path.join(projDir, `${S5}.jsonl`)
  writeFileSync(stale, line('st1', repoRoot, S5, 'old'))
  const old = (Date.now() - 100 * 24 * 3600 * 1000) / 1000
  utimesSync(stale, old, old)

  // Codex rollouts in today's day folder.
  const now = new Date()
  const codexDayDir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  mkdirSync(codexDayDir, { recursive: true })
  writeFileSync(path.join(codexDayDir, `rollout-2026-10-13T11-00-00-${CODEX}.jsonl`), fixtureText('codex-rollout.jsonl', repoRoot))
  writeFileSync(
    path.join(codexDayDir, 'rollout-2026-10-13T12-00-00-codex-other.jsonl'),
    JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id: 'codex-other', cwd: '/elsewhere/proj' } }) + '\n' +
      JSON.stringify({ timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'nope' } }) + '\n'
  )

  return { tmp, repoRoot, claudeHome, codexHome, projDir, codexDayDir }
}

function byId(list: AgentInfo[], id: string): AgentInfo {
  const a = list.find((x) => x.id === id)
  if (!a) throw new Error(`no agent ${id}`)
  return a
}

describe('AgentHub end to end', () => {
  let env: Env
  let hub: AgentHub
  let events: AgentEvent[]
  let agentEmits: AgentInfo[][]

  beforeEach(async () => {
    env = setupEnv()
    hub = new AgentHub({
      repoRoot: env.repoRoot,
      claudeHome: env.claudeHome,
      codexHome: env.codexHome,
      pollMs: 600_000,
      maxAgeHours: 48
    })
    events = []
    agentEmits = []
    hub.on('event', (e: AgentEvent) => events.push(e))
    hub.on('agents', (a: AgentInfo[]) => agentEmits.push(a))
    await hub.start()
  })

  afterEach(() => {
    hub.stop()
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('loads history silently and emits agents once', () => {
    expect(events).toEqual([])
    expect(agentEmits).toHaveLength(1)
  })

  it('discovers only sessions whose cwd is inside the repo, with parent links', () => {
    const ids = hub.getAgents().map((a) => a.id).sort()
    expect(ids).toEqual([CODEX, S1, S2, SUB].sort())
    expect(byId(hub.getAgents(), SUB).parentId).toBe(S1)
    expect(byId(hub.getAgents(), S1).parentId).toBeUndefined()
    expect(byId(hub.getAgents(), CODEX).kind).toBe('codex')
    expect(byId(hub.getAgents(), S1).kind).toBe('claude-code')
  })

  it('names agents: session prefix, subagent description, codex prefix', () => {
    const all = hub.getAgents()
    expect(byId(all, S1).name).toBe(`Claude · ${S1.slice(0, 6)}`)
    expect(byId(all, SUB).name).toBe('Write login tests')
    expect(byId(all, CODEX).name).toBe(`Codex · ${CODEX.slice(0, 6)}`)
  })

  it('counts each message once even when streamed lines repeat usage', () => {
    const s1 = byId(hub.getAgents(), S1)
    // msg_01 (sonnet) 3/10/100/50 · msg_02 (haiku) 1/9/0/0 (streamed twice, output grows)
    // msg_03 (opus) 2/30/20/10 (two lines) · msg_04..06 (sonnet) 1/5/0/0 each · msg_07 synthetic
    expect(s1.tokens).toEqual({ input: 9, output: 64, cacheRead: 120, cacheWrite: 60 })
    const expected =
      costUsd('claude-sonnet-4-5-20250929', { input: 3, output: 10, cacheRead: 100, cacheWrite: 50 }) +
      costUsd('claude-haiku-5-5', { input: 1, output: 9, cacheRead: 0, cacheWrite: 0 }) +
      costUsd('claude-opus-4-1', { input: 2, output: 30, cacheRead: 20, cacheWrite: 10 }) +
      3 * costUsd('claude-sonnet-4-5', { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 })
    expect(s1.costUsd).toBeCloseTo(expected, 12)
  })

  it('tracks files, reads, edits, commands and last activity text for a session', () => {
    const s1 = byId(hub.getAgents(), S1)
    expect([...s1.filesTouched].sort()).toEqual(['src/app.ts', 'src/login.tsx'])
    expect(s1.reads).toBe(5)
    expect(s1.edits).toBe(3)
    expect(s1.commands).toBe(1)
    expect(s1.currentFile).toBe('src/app.ts')
    expect(s1.lastAction).toBe('Read src/app.ts')
    expect(s1.lastMessage).toBe('Reading the file now.')
    expect(s1.model).toBe('claude-sonnet-4-5-20250929')
    expect(s1.cwd).toBe(env.repoRoot)
    // Transcripts are from the past, so the session is not active.
    expect(['idle', 'done']).toContain(s1.status)
  })

  it('subagent carries its own tokens, files and parent', () => {
    const sub = byId(hub.getAgents(), SUB)
    expect(sub.parentId).toBe(S1)
    expect(sub.tokens).toEqual({ input: 4, output: 40, cacheRead: 1000, cacheWrite: 0 })
    expect(sub.filesTouched).toEqual(['src/login.test.ts'])
    expect(sub.edits).toBe(1)
    expect(sub.commands).toBe(1)
  })

  it('codex: converts cumulative totals to deltas, tracks patches and messages', () => {
    const cx = byId(hub.getAgents(), CODEX)
    expect(cx.model).toBe('gpt-5-codex')
    expect(cx.tokens).toEqual({ input: 1500, output: 120, cacheRead: 1500, cacheWrite: 0 })
    expect(cx.costUsd).toBeCloseTo(costUsd('gpt-5-codex', { input: 1500, output: 120, cacheRead: 1500, cacheWrite: 0 }), 12)
    expect([...cx.filesTouched].sort()).toEqual(['README.md', 'src/app.ts', 'src/new.ts', 'src/old.ts'])
    expect(cx.edits).toBe(4)
    expect(cx.commands).toBe(2)
    expect(cx.lastMessage).toBe('Done. Added the new module and ran the tests.')
  })

  it('getEvents returns events sorted by ts and filters by sinceTs', () => {
    const all = hub.getEvents()
    expect(all.length).toBeGreaterThan(10)
    for (let i = 1; i < all.length; i++) expect(all[i]!.ts).toBeGreaterThanOrEqual(all[i - 1]!.ts)
    const since = Date.parse('2026-10-13T11:00:00.000Z')
    const late = hub.getEvents(since)
    expect(late.length).toBeGreaterThan(0)
    expect(late.every((e) => e.ts >= since)).toBe(true)
    // Claude history is from 10:00-10:02 UTC; only codex events (and the live-stamped S2 line) qualify.
    expect(late.some((e) => e.agentId === CODEX)).toBe(true)
    expect(late.every((e) => e.agentId !== S1 && e.agentId !== SUB)).toBe(true)
  })

  it('does not report the fs pseudo agent until it has events', () => {
    expect(hub.getAgents().some((a) => a.id === FS_AGENT_ID)).toBe(false)
  })

  describe('live updates', () => {
    const liveLine = (uuid: string, content: unknown[], usage?: Record<string, number>) =>
      JSON.stringify({
        type: 'assistant',
        cwd: env.repoRoot,
        sessionId: S1,
        uuid,
        timestamp: new Date().toISOString(),
        message: { model: 'claude-sonnet-4-5', id: `msg_${uuid}`, content, usage: usage ?? { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }) + '\n'

    it('emits new events and updates status, tokens and currentFile', async () => {
      const file = path.join(env.projDir, `${S1}.jsonl`)
      appendFileSync(
        file,
        liveLine('live1', [{ type: 'text', text: 'Live message' }]) +
          liveLine('live2', [{ type: 'tool_use', id: 'tl', name: 'Edit', input: { file_path: path.join(env.repoRoot, 'src/live.ts'), old_string: 'a', new_string: 'b' } }])
      )
      await hub.refresh()
      const fresh = events.filter((e) => e.agentId === S1)
      expect(fresh.map((e) => [e.type, e.file ?? null])).toEqual([
        ['message', null],
        ['edit', 'src/live.ts']
      ])
      await sleep(350)
      const last = agentEmits[agentEmits.length - 1]!
      const s1 = byId(last, S1)
      expect(s1.status).toBe('editing')
      expect(s1.currentFile).toBe('src/live.ts')
      expect(s1.lastMessage).toBe('Live message')
      // Two new messages (live1, live2), each 2 in / 3 out.
      expect(s1.tokens.input).toBe(9 + 4)
      expect(s1.tokens.output).toBe(64 + 6)
    })

    it('waits for the newline before emitting a partial line', async () => {
      const file = path.join(env.projDir, `${S1}.jsonl`)
      const full = liveLine('pl1', [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'echo partial' } }])
      appendFileSync(file, full.slice(0, 40))
      await hub.refresh()
      expect(events.filter((e) => e.type === 'command')).toHaveLength(0)
      appendFileSync(file, full.slice(40))
      await hub.refresh()
      const cmds = events.filter((e) => e.type === 'command')
      expect(cmds.map((e) => e.text)).toEqual(['echo partial'])
    })

    it('counts only the growth of cumulative codex totals', async () => {
      const file = path.join(env.codexDayDir, `rollout-2026-10-13T11-00-00-${CODEX}.jsonl`)
      appendFileSync(
        file,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4000, cached_input_tokens: 2000, output_tokens: 200 } } }
        }) + '\n'
      )
      await hub.refresh()
      const cx = byId(hub.getAgents(), CODEX)
      expect(cx.tokens).toEqual({ input: 2000, output: 200, cacheRead: 2000, cacheWrite: 0 })
    })

    it('does not pick up sessions that were ignored at load time', async () => {
      // A new rollout for another repo appears: still ignored.
      const other = path.join(env.codexDayDir, 'rollout-2026-10-13T13-00-00-codex-late.jsonl')
      writeFileSync(other, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'codex-late', cwd: '/elsewhere/x' } }) + '\n')
      await hub.refresh()
      expect(hub.getAgents().some((a) => a.id === 'codex-late')).toBe(false)
    })
  })
})

describe('unattributed filesystem changes', () => {
  let env: Env
  let hub: AgentHub
  let events: AgentEvent[]

  beforeEach(async () => {
    env = setupEnv()
    hub = new AgentHub({ repoRoot: env.repoRoot, claudeHome: env.claudeHome, codexHome: env.codexHome, pollMs: 600_000 })
    events = []
    hub.on('event', (e: AgentEvent) => events.push(e))
    await hub.start()
    events = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    hub.stop()
    vi.useRealTimers()
    rmSync(env.tmp, { recursive: true, force: true })
  })

  const fsEvents = (): AgentEvent[] => events.filter((e) => e.agentId === FS_AGENT_ID)

  it('emits an fs event after the 3 s window when no agent touched the file', () => {
    hub.noteFsChange('src/untracked.ts', 'change')
    vi.advanceTimersByTime(2999)
    expect(fsEvents()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(fsEvents()).toMatchObject([{ agentId: 'fs', type: 'edit', file: 'src/untracked.ts' }])
    const fs = hub.getAgents().find((a) => a.id === FS_AGENT_ID)
    expect(fs).toMatchObject({ name: 'Unattributed', kind: 'unknown', filesTouched: ['src/untracked.ts'] })
  })

  it('maps add and unlink to create and delete, and coalesces repeated changes', () => {
    hub.noteFsChange('src/dup.ts', 'change')
    hub.noteFsChange('src/dup.ts', 'change')
    hub.noteFsChange('src/dup.ts', 'change')
    vi.advanceTimersByTime(3000)
    expect(fsEvents().filter((e) => e.file === 'src/dup.ts')).toHaveLength(1)
    hub.noteFsChange('src/new-file.ts', 'add')
    hub.noteFsChange('src/gone.ts', 'unlink')
    vi.advanceTimersByTime(3000)
    expect(fsEvents().find((e) => e.file === 'src/new-file.ts')?.type).toBe('create')
    expect(fsEvents().find((e) => e.file === 'src/gone.ts')?.type).toBe('delete')
  })

  it('ignores .git and paths outside the repo', () => {
    hub.noteFsChange('.git/index', 'change')
    hub.noteFsChange('/etc/passwd', 'change')
    vi.advanceTimersByTime(3000)
    expect(fsEvents()).toHaveLength(0)
  })

  it('does not attribute a change when an agent touched the file just before it', async () => {
    const file = path.join(env.projDir, `${S1}.jsonl`)
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        cwd: env.repoRoot,
        sessionId: S1,
        uuid: 'claimed1',
        timestamp: new Date().toISOString(),
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg_claimed1',
          content: [{ type: 'tool_use', id: 'tc', name: 'Write', input: { file_path: path.join(env.repoRoot, 'src/claimed.ts'), content: 'x' } }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
      }) + '\n'
    )
    await hub.refresh()
    hub.noteFsChange('src/claimed.ts', 'add')
    vi.advanceTimersByTime(5000)
    expect(fsEvents().filter((e) => e.file === 'src/claimed.ts')).toHaveLength(0)
  })

  it('gives late-arriving agent lines a chance to claim a change within the window', async () => {
    hub.noteFsChange('src/late.ts', 'change')
    vi.advanceTimersByTime(1000)
    const file = path.join(env.projDir, `${S1}.jsonl`)
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        cwd: env.repoRoot,
        sessionId: S1,
        uuid: 'late1',
        timestamp: new Date().toISOString(),
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg_late1',
          content: [{ type: 'tool_use', id: 'tl', name: 'Edit', input: { file_path: path.join(env.repoRoot, 'src/late.ts'), old_string: 'a', new_string: 'b' } }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
      }) + '\n'
    )
    await hub.refresh()
    vi.advanceTimersByTime(2500)
    expect(fsEvents().filter((e) => e.file === 'src/late.ts')).toHaveLength(0)
    expect(events.some((e) => e.agentId === S1 && e.file === 'src/late.ts')).toBe(true)
  })
})
