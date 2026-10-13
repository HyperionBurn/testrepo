import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { dispatchAgent, runningDispatched, stopDispatched } from '../dispatch'
import { codexDayDirs, findCodexRollout } from '../recent'

// Fake CLIs are shell scripts, so these tests run on POSIX only.
const posix = process.platform === 'win32' ? describe.skip : describe

const SESSION = 'fake-session-1'
const CODEX_UUID = 'codex-uuid-1'

let tmp: string
let bin: string
let root: string
let codexHome: string
let logDir: string
let savedPath: string | undefined
let savedFakeHome: string | undefined

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function fakeCli(name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** Resolves true once the process has exited (or at once if it already has). */
function exited(proc: ChildProcess, ms = 5000): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

posix('dispatched agents answer to the id dispatch returned and to the real session id', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    savedPath = process.env.PATH
    savedFakeHome = process.env.FAKE_CODEX_HOME
    tmp = mkdtempSync(path.join(tmpdir(), 'skyline-dispatch-'))
    bin = path.join(tmp, 'bin')
    root = path.join(tmp, 'repo')
    codexHome = path.join(tmp, 'codex')
    logDir = path.join(tmp, 'logs')
    mkdirSync(bin)
    mkdirSync(root)
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`
  })

  afterEach(async () => {
    for (const a of runningDispatched()) await stopDispatched(a.ids[0] ?? a.id)
    restoreEnv('PATH', savedPath)
    restoreEnv('FAKE_CODEX_HOME', savedFakeHome)
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('stops a Claude Code run by its real session id once the stream reports it', async () => {
    fakeCli('claude', `echo '{"type":"system","session_id":"${SESSION}"}'\nsleep 30`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir })
    expect(r.agentId).toBe(SESSION)
    expect(runningDispatched().find((a) => a.ids.includes(SESSION))?.pid).toBe(r.proc.pid)

    await stopDispatched(SESSION)
    expect(await exited(r.proc)).toBe(true)
    expect(runningDispatched().some((a) => a.ids.includes(SESSION))).toBe(false)
  })

  it('stops a Claude Code run by the pending id returned after the timeout, once the real id is known', async () => {
    fakeCli('claude', `sleep 0.4\necho '{"type":"system","session_id":"${SESSION}"}'\nsleep 30`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir, claudeIdTimeoutMs: 100 })
    expect(r.agentId).toMatch(/^pending-/)

    await eventually(() => runningDispatched().some((a) => a.ids.includes(SESSION)))
    await stopDispatched(r.agentId)
    expect(await exited(r.proc)).toBe(true)
  })

  it('stops a Claude Code run by the real session id even when the pending id was returned first', async () => {
    fakeCli('claude', `sleep 0.4\necho '{"type":"system","session_id":"${SESSION}"}'\nsleep 30`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir, claudeIdTimeoutMs: 100 })
    await eventually(() => runningDispatched().some((a) => a.ids.includes(SESSION)))
    await stopDispatched(SESSION)
    expect(await exited(r.proc)).toBe(true)
  })

  it('keeps output in a log file, not a pipe, so the run carries on without Skyline reading it', async () => {
    fakeCli('claude', `echo '{"type":"system","session_id":"${SESSION}"}'\nsleep 0.3\necho after-quit\nsleep 30`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir })
    expect(r.proc.stdout).toBeNull()
    expect(r.proc.stderr).toBeNull()

    const [logName] = readdirSync(logDir)
    expect(logName).toMatch(/^dispatch-[0-9a-f]{8}\.log$/)
    await eventually(() => readFileSync(path.join(logDir, logName), 'utf8').includes('after-quit'))
    expect(r.proc.exitCode).toBeNull()

    await stopDispatched(SESSION)
    expect(await exited(r.proc)).toBe(true)
  })

  it('returns the session id of a run that prints it and exits at once', async () => {
    fakeCli('claude', `echo '{"type":"system","session_id":"fast-1"}'`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir })
    expect(r.agentId).toBe('fast-1')
  })

  it('fails with the start of the log when Claude Code exits before it reports a session', async () => {
    fakeCli('claude', `echo 'boom from the cli'\nexit 3`)
    await expect(dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false }, { logDir })).rejects.toThrow(
      /exited before it started \(code 3\)\. boom from the cli/
    )
  })

  it('links a Codex run to its own session id from the rollout file it writes', async () => {
    process.env.FAKE_CODEX_HOME = codexHome
    fakeCli(
      'codex',
      [
        'day="$FAKE_CODEX_HOME/sessions/$(date +%Y)/$(date +%m)/$(date +%d)"',
        'mkdir -p "$day"',
        `echo '{"type":"session_meta","payload":{"id":"${CODEX_UUID}","cwd":"'"$(pwd -P)"'"}}' > "$day/rollout-test-${CODEX_UUID}.jsonl"`,
        'sleep 30'
      ].join('\n')
    )
    const r = await dispatchAgent(root, { kind: 'codex', prompt: 'hi', worktree: false }, { codexHome, codexPollMs: 50, logDir })
    expect(r.agentId).toMatch(/^codex-/)

    await eventually(() => runningDispatched().some((a) => a.ids.includes(CODEX_UUID)))
    await stopDispatched(CODEX_UUID)
    expect(await exited(r.proc)).toBe(true)
  })
})

describe('findCodexRollout', () => {
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'skyline-rollout-'))
    root = path.join(tmp, 'repo')
    codexHome = path.join(tmp, 'codex')
    mkdirSync(root)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const writeRollout = (dir: string, name: string, id: string, cwd: string): string => {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n')
    return file
  }

  it('returns the rollout for the cwd written after the start, skipping claimed files and other folders', async () => {
    const since = Date.now() - 1000
    const [today] = codexDayDirs(codexHome, [new Date()])
    writeRollout(today, 'rollout-a-other.jsonl', 'other-id', path.join(tmp, 'elsewhere'))
    const claimed = writeRollout(today, 'rollout-b-claimed.jsonl', 'claimed-id', root)
    const mine = writeRollout(today, 'rollout-c-mine.jsonl', 'mine-id', root)

    expect(await findCodexRollout(codexHome, root, since, new Set([claimed]))).toEqual({ file: mine, id: 'mine-id' })
  })

  it('ignores rollouts written before the run started', async () => {
    const [today] = codexDayDirs(codexHome, [new Date()])
    writeRollout(today, 'rollout-old.jsonl', 'old-id', root)
    expect(await findCodexRollout(codexHome, root, Date.now() + 60_000)).toBeUndefined()
  })

  it('finds nothing when there is no sessions folder', async () => {
    expect(await findCodexRollout(path.join(tmp, 'missing'), root, 0)).toBeUndefined()
    expect(readdirSync(tmp)).toEqual(['repo'])
  })
})
