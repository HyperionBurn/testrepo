import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { dispatchAgent, runningDispatched, stopDispatched } from '../dispatch'

describe('dispatchAgent validation', () => {
  const root = process.cwd()
  let savedPath: string | undefined

  beforeEach(() => {
    savedPath = process.env.PATH
  })
  afterEach(() => {
    process.env.PATH = savedPath
  })

  it('rejects unknown kinds and empty prompts before spawning anything', async () => {
    await expect(dispatchAgent(root, { kind: 'cursor' as never, prompt: 'x', worktree: false })).rejects.toThrow(/Unknown agent kind/)
    await expect(dispatchAgent(root, { kind: 'codex', prompt: '   ', worktree: false })).rejects.toThrow(/empty/)
  })

  it('reports a friendly error when the CLI is not on PATH', async () => {
    process.env.PATH = ''
    await expect(dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false })).rejects.toThrow(
      'Claude Code CLI not found on PATH — install it from https://claude.com/claude-code'
    )
  })
})

// Fake CLIs are shell scripts, so the stdin tests run on POSIX only.
const posix = process.platform === 'win32' ? describe.skip : describe

const CLAUDE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
const CODEX_ARGS = ['exec', '--full-auto', '-']
/** Hostile on purpose: %VAR% expansion, cmd operators, quotes, a trailing backslash, CRLF and LF, non-ASCII. */
const NASTY = 'Use %PATH% and %USERPROFILE% & echo pwned | more ^ "quoted" \'single\' `id` $HOME\r\nline two\\\nline three: a=b, c;d (e) <f> !g!\ncafé ✓ 漢字'

let tmp: string
let bin: string
let out: string
let root: string
let logDir: string
let savedPath: string | undefined
let savedOut: string | undefined

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function fakeCli(name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** A fake CLI that records its argv and stdin under FAKE_OUT, then runs `tail`. */
function recordingCli(name: string, tail: string): void {
  fakeCli(name, [`printf '%s\\n' "$@" > "$FAKE_OUT/${name}-argv"`, `cat > "$FAKE_OUT/${name}-stdin"`, tail].join('\n'))
}

const argvOf = (name: string): string[] => readFileSync(path.join(out, `${name}-argv`), 'utf8').split('\n').slice(0, -1)
const stdinOf = (name: string): string => readFileSync(path.join(out, `${name}-stdin`), 'utf8')

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

posix('prompts reach the CLI on stdin, never on the command line', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    savedPath = process.env.PATH
    savedOut = process.env.FAKE_OUT
    tmp = mkdtempSync(path.join(tmpdir(), 'skyline-prompt-'))
    bin = path.join(tmp, 'bin')
    out = path.join(tmp, 'out')
    root = path.join(tmp, 'repo')
    logDir = path.join(tmp, 'logs')
    mkdirSync(bin)
    mkdirSync(out)
    mkdirSync(root)
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`
    process.env.FAKE_OUT = out
  })

  afterEach(async () => {
    for (const a of runningDispatched()) await stopDispatched(a.ids[0] ?? a.id)
    restoreEnv('PATH', savedPath)
    restoreEnv('FAKE_OUT', savedOut)
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('delivers a Claude Code prompt byte for byte and passes only the fixed flags', async () => {
    recordingCli('claude', `echo '{"type":"system","session_id":"sid-stdin-1"}'`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: NASTY, worktree: false }, { logDir })
    expect(r.agentId).toBe('sid-stdin-1')
    expect(await exited(r.proc)).toBe(true)
    expect(stdinOf('claude')).toBe(NASTY)
    expect(argvOf('claude')).toEqual(CLAUDE_ARGS)
  })

  it('delivers a Codex prompt byte for byte with the - flag', async () => {
    recordingCli('codex', '')
    const r = await dispatchAgent(root, { kind: 'codex', prompt: NASTY, worktree: false }, { codexHome: path.join(tmp, 'codex'), codexPollMs: 50, logDir })
    expect(await exited(r.proc)).toBe(true)
    expect(stdinOf('codex')).toBe(NASTY)
    expect(argvOf('codex')).toEqual(CODEX_ARGS)
  })

  it('keeps a prompt of the full 100k characters intact', async () => {
    // Ends in a non-space character so dispatch's trim() leaves every character in place.
    const unit = 'row %PATH% & | ^ "q"\n'
    const big = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 99_999) + 'E'
    expect(big).toHaveLength(100_000)
    recordingCli('claude', `echo '{"type":"system","session_id":"sid-big-1"}'`)
    const r = await dispatchAgent(root, { kind: 'claude-code', prompt: big, worktree: false }, { logDir })
    expect(await exited(r.proc)).toBe(true)
    expect(stdinOf('claude')).toBe(big)
  })

  it('rejects a prompt over 100k characters before spawning anything', async () => {
    recordingCli('claude', `echo '{"type":"system","session_id":"sid-x"}'`)
    await expect(dispatchAgent(root, { kind: 'claude-code', prompt: 'x'.repeat(100_001), worktree: false }, { logDir })).rejects.toThrow(
      /too long/
    )
    expect(existsSync(path.join(out, 'claude-argv'))).toBe(false)
  })

  it('reports a CLI that exits without reading its prompt, without crashing on the broken pipe', async () => {
    fakeCli('claude', `echo 'refused'\nexit 3`)
    await expect(
      dispatchAgent(root, { kind: 'claude-code', prompt: 'x'.repeat(100_000), worktree: false }, { logDir })
    ).rejects.toThrow(/exited before it started \(code 3\)\. refused/)
  })
})
