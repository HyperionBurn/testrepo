import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { encodeClaudeProjectDir } from '../claude'
import { isWithinRepo, mainCheckoutOf, stripSkylineWorktree } from '../common'
import { AgentHub } from '../hub'

const WT = '1a2b3c4d'
const SID = 'WT-session-0001'

describe('stripSkylineWorktree', () => {
  it.each([
    ['.skyline/worktrees/1a2b3c4d/src/main/x.ts', 'src/main/x.ts'],
    ['.skyline/worktrees/1a2b3c4d/README.md', 'README.md'],
    ['src/main/x.ts', 'src/main/x.ts'],
    ['.skyline/worktrees/1a2b3c4d', '.skyline/worktrees/1a2b3c4d'],
    ['.skyline/other/x.ts', '.skyline/other/x.ts'],
    ['docs/.skyline/worktrees/x/y.ts', 'docs/.skyline/worktrees/x/y.ts']
  ])('maps %s to %s', (input, expected) => {
    expect(stripSkylineWorktree(input)).toBe(expected)
  })
})

describe('mainCheckoutOf', () => {
  it.each([
    ['/home/u/repo/.skyline/worktrees/1a2b3c4d', '/home/u/repo'],
    ['/home/u/repo/.skyline/worktrees/1a2b3c4d/src/deep', '/home/u/repo'],
    ['C:\\dev\\app\\.skyline\\worktrees\\1a2b3c4d\\src', 'C:\\dev\\app'],
    ['/home/u/repo/src', '/home/u/repo/src'],
    ['/home/u/repo', '/home/u/repo']
  ])('maps %s to %s', (input, expected) => {
    expect(mainCheckoutOf(input)).toBe(expected)
  })
})

describe('worktree sessions count as inside the repo', () => {
  it('accepts a cwd inside .skyline/worktrees', () => {
    expect(isWithinRepo('/home/u/repo/.skyline/worktrees/1a2b3c4d', '/home/u/repo')).toBe(true)
    expect(isWithinRepo('/home/u/elsewhere/.skyline/worktrees/1a2b3c4d', '/home/u/repo')).toBe(false)
  })
})

describe('AgentHub with a dispatched worktree', () => {
  let tmp: string
  let repoRoot: string
  let wt: string
  let hub: AgentHub

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'skyline-wt-'))
    repoRoot = path.join(tmp, 'repo')
    wt = path.join(repoRoot, '.skyline', 'worktrees', WT)
    mkdirSync(wt, { recursive: true })

    // Claude Code keeps a worktree session under the encoded worktree path.
    const claudeHome = path.join(tmp, 'claude')
    const projDir = path.join(claudeHome, 'projects', encodeClaudeProjectDir(wt))
    mkdirSync(projDir, { recursive: true })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const line = (uuid: string, content: unknown[]): string =>
      JSON.stringify({
        type: 'assistant',
        cwd: wt,
        sessionId: SID,
        uuid,
        timestamp: new Date().toISOString(),
        message: { model: 'claude-haiku-5-5', id: `msg-${uuid}`, content, usage }
      }) + '\n'
    writeFileSync(
      path.join(projDir, `${SID}.jsonl`),
      line('w1', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(wt, 'src', 'main', 'x.ts'), old_string: 'a', new_string: 'b' } }]) +
        line('w2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: path.join(wt, 'src', 'shared', 'types.ts') } }])
    )

    hub = new AgentHub({ repoRoot, claudeHome, codexHome: path.join(tmp, 'codex'), pollMs: 600_000 })
    await hub.start()
  })

  afterEach(() => {
    vi.useRealTimers()
    hub.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reports the worktree session as an agent of the repo, with its worktree cwd', () => {
    const agent = hub.getAgents().find((a) => a.id === SID)
    expect(agent?.cwd).toBe(wt)
  })

  it('records edits and reads on the main checkout paths', () => {
    const files = hub
      .getEvents()
      .filter((e) => e.agentId === SID && e.file)
      .map((e) => [e.type, e.file])
    expect(files).toEqual([
      ['edit', 'src/main/x.ts'],
      ['read', 'src/shared/types.ts']
    ])
    const agent = hub.getAgents().find((a) => a.id === SID)
    expect(agent?.filesTouched).toEqual(['src/main/x.ts', 'src/shared/types.ts'])
  })

  it('attributes filesystem changes inside a worktree to the same main checkout file', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Already touched by the agent: no unattributed event.
    hub.noteFsChange(`.skyline/worktrees/${WT}/src/main/x.ts`, 'change')
    // Not touched by any agent: becomes an 'fs' event once the 3 s window passes.
    hub.noteFsChange(`.skyline/worktrees/${WT}/src/new.ts`, 'add')
    vi.advanceTimersByTime(3100)

    const fsEvents = hub.getEvents().filter((e) => e.agentId === 'fs').map((e) => [e.type, e.file])
    expect(fsEvents).toEqual([['create', 'src/new.ts']])
  })
})
