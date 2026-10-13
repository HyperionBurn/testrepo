// Starts Claude Code or Codex CLI runs for a repo and keeps a registry so they can be stopped.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import type { DispatchRequest } from '../../shared/types'

const CLAUDE_HINT = 'Claude Code CLI not found on PATH — install it from https://claude.com/claude-code'
const CODEX_HINT = 'Codex CLI not found on PATH — install it with: npm i -g @openai/codex'
const CLAUDE_ID_TIMEOUT_MS = 20_000
const KILL_ESCALATE_MS = 3_000
const MAX_PROMPT_CHARS = 100_000
/** cmd.exe rejects command lines longer than 8191 characters; leave room for the rest of the line. */
const WIN_MAX_PROMPT_CHARS = 7000
const STDERR_TAIL_CHARS = 2000

export interface DispatchResult {
  agentId: string
  proc: ChildProcess
}

interface Running {
  keys: Set<string>
  proc: ChildProcess
  exited: boolean
}

/** agentId (pending or real session id) → running process. Entries live until the process exits. */
const registry = new Map<string, Running>()

/**
 * Starts an agent in `root` (or in a fresh git worktree when req.worktree is set).
 * Claude Code resolves with its real session id once the stream reports it, or with 'pending-<id>'
 * after 20 s. Codex resolves as soon as the process spawns with 'codex-<id>'.
 */
export async function dispatchAgent(root: string, req: DispatchRequest): Promise<DispatchResult> {
  if (req.kind !== 'claude-code' && req.kind !== 'codex') throw new Error(`Unknown agent kind: ${String(req.kind)}`)
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : ''
  if (!prompt) throw new Error('Prompt is empty')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('Prompt is too long')
  if (process.platform === 'win32' && prompt.length > WIN_MAX_PROMPT_CHARS) {
    throw new Error('Prompt is too long for a Windows command line (about 7000 characters max)')
  }

  const bin = req.kind === 'claude-code' ? 'claude' : 'codex'
  if (!(await findOnPath(bin))) throw new Error(req.kind === 'claude-code' ? CLAUDE_HINT : CODEX_HINT)

  const shortid = randomBytes(4).toString('hex')
  const cwd = req.worktree ? await createWorktree(root, shortid) : root

  return req.kind === 'claude-code'
    ? startClaude(cwd, prompt, shortid)
    : startCodex(cwd, prompt, shortid)
}

/** Kills the process tree of a dispatched agent. Unknown or already finished ids are a no-op. */
export async function stopDispatched(agentId: string): Promise<void> {
  const entry = registry.get(agentId)
  if (!entry || entry.exited) return
  await killTree(entry)
}

// ---- Claude Code --------------------------------------------------------------------

function startClaude(cwd: string, prompt: string, shortid: string): Promise<DispatchResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
  const proc = spawnTool('claude', args, cwd)
  const pendingId = `pending-${shortid}`
  const entry: Running = { keys: new Set([pendingId]), proc, exited: false }
  const stderr = tailBuffer(STDERR_TAIL_CHARS)
  let settled = false

  return new Promise<DispatchResult>((resolve, reject) => {
    const settle = (id: string): void => {
      entry.keys.add(id)
      registry.set(id, entry)
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ agentId: id, proc })
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
    const timer = setTimeout(() => settle(pendingId), CLAUDE_ID_TIMEOUT_MS)

    registry.set(pendingId, entry)
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
    proc.once('error', (err) => {
      unregister(entry)
      fail(isMissing(err) ? new Error(CLAUDE_HINT) : err)
    })
    proc.once('exit', () => {
      entry.exited = true
      unregister(entry)
    })
    proc.once('close', (code) => {
      fail(new Error(`Claude Code exited before it started (code ${code ?? 'null'}). ${stderr.text()}`.trim()))
    })

    // stream-json: the first line carrying session_id names the transcript (<session_id>.jsonl).
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout })
      let sessionSeen = false
      rl.on('line', (line) => {
        if (sessionSeen || !line.includes('session_id')) return
        const sid = sessionIdOf(line)
        if (!sid) return
        sessionSeen = true
        settle(sid)
      })
    }
  })
}

function sessionIdOf(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as { session_id?: unknown }
    return typeof obj.session_id === 'string' && obj.session_id ? obj.session_id : undefined
  } catch {
    return undefined
  }
}

// ---- Codex ---------------------------------------------------------------------------

function startCodex(cwd: string, prompt: string, shortid: string): Promise<DispatchResult> {
  const proc = spawnTool('codex', ['exec', '--full-auto', prompt], cwd)
  const agentId = `codex-${shortid}`
  const entry: Running = { keys: new Set([agentId]), proc, exited: false }
  proc.stdout?.resume()
  proc.stderr?.resume()

  return new Promise<DispatchResult>((resolve, reject) => {
    proc.once('spawn', () => {
      registry.set(agentId, entry)
      resolve({ agentId, proc })
    })
    proc.once('error', (err) => reject(isMissing(err) ? new Error(CODEX_HINT) : err))
    proc.once('exit', () => {
      entry.exited = true
      unregister(entry)
    })
  })
}

// ---- process helpers -------------------------------------------------------------------

/**
 * Posix: spawn directly with its own process group (detached) so the whole tree can be signalled.
 * Windows: the CLIs are .cmd shims, which need the shell, so the command line is quoted by hand.
 */
function spawnTool(bin: string, args: string[], cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const commandLine = [bin, ...args].map(quoteForCmd).join(' ')
    return spawn(commandLine, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return spawn(bin, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Quotes one argument for cmd.exe running a child with MSVCRT argv rules. Newlines become spaces
 * (cmd ends the command at a line break). Not verified on Windows in this repo's test runs.
 */
export function quoteForCmd(arg: string): string {
  const flat = arg.replace(/\r?\n/g, ' ')
  if (flat === '') return '""'
  if (!/[\s"&|<>^()%!,;=]/.test(flat)) return flat
  const escaped = flat.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  return `"${escaped}"`
}

async function killTree(entry: Running): Promise<void> {
  const pid = entry.proc.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    entry.proc.kill('SIGTERM')
  }
  const escalate = setTimeout(() => {
    if (entry.exited) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, KILL_ESCALATE_MS)
  escalate.unref()
}

function unregister(entry: Running): void {
  for (const k of entry.keys) if (registry.get(k) === entry) registry.delete(k)
}

async function createWorktree(root: string, shortid: string): Promise<string> {
  const wt = path.join(root, '.skyline', 'worktrees', shortid)
  await fsp.mkdir(path.dirname(wt), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, 'worktree', 'add', wt, '-b', `skyline/${shortid}`],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`Could not create a git worktree: ${String(stderr).trim() || err.message}`))
        else resolve()
      }
    )
  })
  return wt
}

/** True when `bin` resolves to an executable file on PATH (PATHEXT applies on Windows). */
async function findOnPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      try {
        const st = await fsp.stat(candidate)
        if (!st.isFile()) continue
        if (process.platform !== 'win32') await fsp.access(candidate, fsConstants.X_OK)
        return true
      } catch {
        /* not here */
      }
    }
  }
  return false
}

function isMissing(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function tailBuffer(max: number): { push(s: string): void; text(): string } {
  let buf = ''
  return {
    push(s: string) {
      buf = (buf + s).slice(-max)
    },
    text() {
      return buf.trim()
    }
  }
}
