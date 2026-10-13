// Starts Claude Code or Codex CLI runs for a repo and keeps a registry so they can be stopped.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import type { DispatchRequest } from '../../shared/types'
import { findCodexRollout } from './recent'

const CLAUDE_HINT = 'Claude Code CLI not found on PATH — install it from https://claude.com/claude-code'
const CODEX_HINT = 'Codex CLI not found on PATH — install it with: npm i -g @openai/codex'
const CLAUDE_ID_TIMEOUT_MS = 20_000
const CODEX_LINK_TIMEOUT_MS = 60_000
const CODEX_LINK_POLL_MS = 500
const KILL_ESCALATE_MS = 3_000
const MAX_PROMPT_CHARS = 100_000
/** cmd.exe rejects command lines longer than 8191 characters; leave room for the rest of the line. */
const WIN_MAX_PROMPT_CHARS = 7000
const STDERR_TAIL_CHARS = 2000

export interface DispatchResult {
  agentId: string
  proc: ChildProcess
}

export interface DispatchOptions {
  /** How long Claude Code gets to report its session id before the 'pending-' id is returned. Default 20 s. */
  claudeIdTimeoutMs?: number
  /** Codex home, used to find the rollout file of a run. Default ~/.codex. */
  codexHome?: string
  /** Poll interval while looking for a Codex rollout file. Default 500 ms. */
  codexPollMs?: number
}

interface Running {
  /** Every id this process answers to: the id dispatch returned first, then the real session id. */
  keys: Set<string>
  proc: ChildProcess
  exited: boolean
  kind: DispatchRequest['kind']
  cwd: string
}

export interface RunningAgent {
  /** The id dispatch returned. */
  id: string
  /** Every id stopAgent accepts for this process. */
  ids: string[]
  kind: DispatchRequest['kind']
  cwd: string
  pid?: number
}

/** agentId (pending, codex or real session id) → running process. Entries live until the process exits. */
const registry = new Map<string, Running>()
/** Codex rollout files already matched to a dispatched run. */
const linkedRollouts = new Set<string>()

/**
 * Starts an agent in `root` (or in a fresh git worktree when req.worktree is set).
 * Claude Code resolves with its real session id once the stream reports it, or with 'pending-<id>'
 * after 20 s. Codex resolves as soon as the process spawns with 'codex-<id>'; its own session id is
 * registered as an alias once its rollout file appears. stopAgent accepts either id.
 */
export async function dispatchAgent(root: string, req: DispatchRequest, opts: DispatchOptions = {}): Promise<DispatchResult> {
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
    ? startClaude(cwd, prompt, shortid, opts)
    : startCodex(cwd, prompt, shortid, opts)
}

/**
 * Kills the process tree of a dispatched agent. Accepts the id dispatch returned or the agent's real
 * session id. Unknown or already finished ids are a no-op.
 */
export async function stopDispatched(agentId: string): Promise<void> {
  const entry = registry.get(agentId)
  if (!entry || entry.exited) return
  await killTree(entry)
}

/** Dispatched processes still running, with their pids. Used to log what is left when Skyline quits. */
export function runningDispatched(): RunningAgent[] {
  const seen = new Set<Running>()
  const out: RunningAgent[] = []
  for (const entry of registry.values()) {
    if (seen.has(entry) || entry.exited) continue
    seen.add(entry)
    const ids = [...entry.keys]
    out.push({ id: ids[0] ?? '', ids, kind: entry.kind, cwd: entry.cwd, pid: entry.proc.pid })
  }
  return out
}

// ---- Claude Code --------------------------------------------------------------------

function startClaude(cwd: string, prompt: string, shortid: string, opts: DispatchOptions): Promise<DispatchResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
  const proc = spawnTool('claude', args, cwd)
  const pendingId = `pending-${shortid}`
  const entry: Running = { keys: new Set([pendingId]), proc, exited: false, kind: 'claude-code', cwd }
  const stderr = tailBuffer(STDERR_TAIL_CHARS)
  const timeoutMs = opts.claudeIdTimeoutMs ?? CLAUDE_ID_TIMEOUT_MS
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
    const timer = setTimeout(() => settle(pendingId), timeoutMs)

    registry.set(pendingId, entry)
    logStarted(entry, pendingId)
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

function startCodex(cwd: string, prompt: string, shortid: string, opts: DispatchOptions): Promise<DispatchResult> {
  const sinceMs = Date.now()
  const proc = spawnTool('codex', ['exec', '--full-auto', prompt], cwd)
  const agentId = `codex-${shortid}`
  const entry: Running = { keys: new Set([agentId]), proc, exited: false, kind: 'codex', cwd }
  proc.stdout?.resume()
  proc.stderr?.resume()

  return new Promise<DispatchResult>((resolve, reject) => {
    proc.once('spawn', () => {
      registry.set(agentId, entry)
      logStarted(entry, agentId)
      void linkCodexRollout(entry, sinceMs, opts)
      resolve({ agentId, proc })
    })
    proc.once('error', (err) => reject(isMissing(err) ? new Error(CODEX_HINT) : err))
    proc.once('exit', () => {
      entry.exited = true
      unregister(entry)
    })
  })
}

/**
 * Codex names its sessions with its own id, which only appears in the rollout file it writes. Polls
 * for that file and registers the id as an alias, so stopAgent works with the id the hub shows.
 */
async function linkCodexRollout(entry: Running, sinceMs: number, opts: DispatchOptions): Promise<void> {
  const codexHome = opts.codexHome ?? path.join(os.homedir(), '.codex')
  const pollMs = opts.codexPollMs ?? CODEX_LINK_POLL_MS
  const deadline = Date.now() + CODEX_LINK_TIMEOUT_MS
  while (!entry.exited && Date.now() < deadline) {
    const found = await findCodexRollout(codexHome, entry.cwd, sinceMs, linkedRollouts).catch(() => undefined)
    if (found) {
      linkedRollouts.add(found.file)
      if (!entry.exited) {
        entry.keys.add(found.id)
        registry.set(found.id, entry)
        console.info(`[skyline] codex agent ${found.id} is pid ${entry.proc.pid} in ${entry.cwd}`)
      }
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}

// ---- process helpers -------------------------------------------------------------------

function logStarted(entry: Running, id: string): void {
  if (entry.proc.pid === undefined) return
  console.info(`[skyline] ${entry.kind} agent ${id} started, pid ${entry.proc.pid}, cwd ${entry.cwd}`)
}

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
