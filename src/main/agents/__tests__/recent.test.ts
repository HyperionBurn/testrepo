import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { encodeClaudeProjectDir } from '../claude'
import { codexDayDirs, listRecentSessions, readSessionHeader, RECENT_LIMIT } from '../recent'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)

let tmp: string
let claudeHome: string
let codexHome: string
let repoA: string
let repoB: string
let worktree: string

function setMtime(file: string, ms: number): void {
  utimesSync(file, ms / 1000, ms / 1000)
}

function claudeFile(cwd: string, sid: string, mtime: number, lines?: string[]): string {
  const dir = path.join(claudeHome, 'projects', encodeClaudeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  const body = lines ?? [
    JSON.stringify({ type: 'summary', summary: 'no cwd here' }),
    JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'hi' } })
  ]
  writeFileSync(file, body.join('\n') + '\n')
  setMtime(file, mtime)
  return file
}

function codexFile(day: Date, name: string, id: string | undefined, cwd: string | undefined, mtime: number): string {
  const [dir] = codexDayDirs(codexHome, [day])
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const payload: Record<string, unknown> = {}
  if (id !== undefined) payload.id = id
  if (cwd !== undefined) payload.cwd = cwd
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload }) + '\n')
  setMtime(file, mtime)
  return file
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'skyline-recent-'))
  claudeHome = path.join(tmp, 'claude')
  codexHome = path.join(tmp, 'codex')
  repoA = path.join(tmp, 'repo-a')
  repoB = path.join(tmp, 'repo-b')
  worktree = path.join(repoA, '.skyline', 'worktrees', '1a2b3c4d')
  for (const d of [repoA, repoB, worktree]) mkdirSync(d, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('readSessionHeader', () => {
  it('takes the cwd and session id of the first line that carries a cwd', async () => {
    const file = claudeFile(repoA, 'sess-1', NOW)
    expect(await readSessionHeader(file, 'claude-code')).toEqual({ cwd: repoA, id: 'sess-1' })
  })

  it('reads Codex session_meta only', async () => {
    const file = codexFile(new Date(NOW), 'rollout-x.jsonl', 'codex-1', repoB, NOW)
    expect(await readSessionHeader(file, 'codex')).toEqual({ cwd: repoB, id: 'codex-1' })
  })

  it('returns an empty header for unreadable or cwd-less files', async () => {
    const file = path.join(tmp, 'broken.jsonl')
    writeFileSync(file, 'not json\n{"type":"summary"}\n')
    expect(await readSessionHeader(file, 'claude-code')).toEqual({})
    expect(await readSessionHeader(path.join(tmp, 'missing.jsonl'), 'codex')).toEqual({})
  })
})

describe('listRecentSessions', () => {
  it('lists Claude Code and Codex sessions across repos, newest first, with worktrees mapped to their repo', async () => {
    claudeFile(repoA, 'old-claude', NOW - 3 * DAY)
    claudeFile(repoB, 'new-claude', NOW - 60_000)
    claudeFile(worktree, 'wt-claude', NOW - 10 * 60_000)
    codexFile(new Date(NOW - DAY), 'rollout-2026-yesterday-codex-1.jsonl', 'codex-1', repoA, NOW - DAY)

    const list = await listRecentSessions({ claudeHome, codexHome, now: NOW })

    expect(list).toEqual([
      { kind: 'claude-code', cwd: repoB, lastActiveAt: NOW - 60_000, id: 'new-claude' },
      { kind: 'claude-code', cwd: repoA, lastActiveAt: NOW - 10 * 60_000, id: 'wt-claude' },
      { kind: 'codex', cwd: repoA, lastActiveAt: NOW - DAY, id: 'codex-1' },
      { kind: 'claude-code', cwd: repoA, lastActiveAt: NOW - 3 * DAY, id: 'old-claude' }
    ])
  })

  it('keeps only sessions from the last 7 days', async () => {
    claudeFile(repoA, 'recent', NOW - 6 * DAY)
    claudeFile(repoA, 'stale', NOW - 8 * DAY)
    const list = await listRecentSessions({ claudeHome, codexHome, now: NOW })
    expect(list.map((s) => s.id)).toEqual(['recent'])
  })

  it('skips sessions without a cwd, sessions whose folder is gone, and subagent transcripts', async () => {
    claudeFile(repoA, 'kept', NOW)
    claudeFile(repoA, 'no-cwd', NOW, ['{"type":"summary"}'])
    claudeFile(path.join(tmp, 'deleted-repo'), 'gone', NOW)
    const sub = path.join(claudeHome, 'projects', encodeClaudeProjectDir(repoA), 'kept', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'agent-x.jsonl'), JSON.stringify({ cwd: repoA }) + '\n')

    const list = await listRecentSessions({ claudeHome, codexHome, now: NOW })
    expect(list.map((s) => s.id)).toEqual(['kept'])
  })

  it('caps the list at 200 sessions by default', async () => {
    for (let i = 0; i < RECENT_LIMIT + 5; i++) claudeFile(repoA, `s-${i}`, NOW - i * 1000)
    const list = await listRecentSessions({ claudeHome, codexHome, now: NOW })
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0].id).toBe('s-0')
  })

  it('returns nothing when no agent home exists', async () => {
    expect(await listRecentSessions({ claudeHome: path.join(tmp, 'x'), codexHome: path.join(tmp, 'y'), now: NOW })).toEqual([])
  })
})
