// AgentHub: discovers Claude Code and Codex transcripts for one repo, tails them incrementally,
// turns their lines into AgentEvents, keeps per-agent state (tokens, cost, files, status) and
// emits 'agents' (debounced) and 'event' (live only).
import { EventEmitter } from 'node:events'
import { promises as fsp, watch, type Dirent, type FSWatcher } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, AgentEventType, AgentInfo, AgentKind, AgentStatus } from '../../shared/types'
import { costUsd } from '../../shared/pricing'
import { agentColor } from '../../shared/color'
import { JsonlTailer } from './tail'
import { claudeProjectDirsFor, parseClaudeLine } from './claude'
import { parseCodexLine } from './codex'
import {
  isWithinRepo,
  relativeWithin,
  snippet,
  stripSkylineWorktree,
  type MessageUsage,
  type ParseCtx,
  type ParsedLine,
  type TotalUsage,
  type Usage
} from './common'

export interface AgentHubOptions {
  /** Repo root. Only sessions whose cwd is this directory or inside it are reported. */
  repoRoot: string
  /** Claude Code config dir. Default ~/.claude */
  claudeHome?: string
  /** Codex config dir. Default ~/.codex */
  codexHome?: string
  /** Poll interval in ms. Default 1000. */
  pollMs?: number
  /** Only sessions modified within this many hours are loaded. Default 48. */
  maxAgeHours?: number
}

/** Pseudo agent id for filesystem changes no agent accounts for. */
export const FS_AGENT_ID = 'fs'

const MAX_EVENTS = 20_000
const ACTIVE_MS = 8_000
const IDLE_MS = 10 * 60_000
const FS_WINDOW_MS = 3_000
const AGENTS_DEBOUNCE_MS = 250
const KICK_DEBOUNCE_MS = 250
const CODEX_FULL_SCAN_MS = 5_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const TOUCH_HISTORY = 32
/** Bytes read per refresh round across all transcripts; a bigger backlog takes several rounds. */
const READ_ROUND_BYTES = 4 * 1024 * 1024

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type Source = 'claude' | 'claude-sub' | 'codex'

interface TrackedFile {
  file: string
  source: Source
  agentId: string
  parentId?: string
  /** Codex: id is taken from session_meta once seen. */
  idFixed: boolean
  /** Session cwd (latest in-repo value). */
  cwd?: string
  /** Subagent description from its .meta.json. */
  metaDescription?: string
  metaChecks: number
  /** Size and mtime seen at the last read; equal values mean nothing new was appended. */
  size?: number
  mtimeMs?: number
  /** The last read stopped before the end of the file. */
  backlog: boolean
}

interface Listed {
  file: string
  source: Source
  agentId: string
  parentId?: string
}

interface Candidate extends Listed {
  size: number
  mtimeMs: number
}

interface AgentState {
  id: string
  kind: AgentKind
  parentId?: string
  cwd: string
  model?: string
  startedAt: number
  lastActiveAt: number
  /** Type and ts of the newest event, for status. */
  lastType?: AgentEventType
  lastEventTs: number
  metaDescription?: string
  promptName?: string
  tokens: Usage
  costUsd: number
  files: Set<string>
  edits: number
  reads: number
  commands: number
  currentFile?: string
  lastAction?: string
  lastMessage?: string
  /** Claude: last usage seen per message id; the hub adds only the difference. */
  usageByMsg: Map<string, Usage>
  /** Codex: last cumulative totals. */
  codexTotals?: Usage
  isSub: boolean
}

interface PendingFs {
  kind: 'add' | 'change' | 'unlink'
  ts: number
  timer: ReturnType<typeof setTimeout>
}

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function zeroUsage(): Usage {
  return { ...ZERO }
}

function diffUsage(cur: Usage, prev: Usage): Usage {
  return {
    input: Math.max(0, cur.input - prev.input),
    output: Math.max(0, cur.output - prev.output),
    cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
    cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite)
  }
}

function anyBelow(cur: Usage, prev: Usage): boolean {
  return (
    cur.input < prev.input ||
    cur.output < prev.output ||
    cur.cacheRead < prev.cacheRead ||
    cur.cacheWrite < prev.cacheWrite
  )
}

function hasTokens(u: Usage): boolean {
  return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0
}

function newState(id: string, kind: AgentKind, cwd: string, ts: number, parentId?: string, isSub = false): AgentState {
  return {
    id,
    kind,
    parentId,
    cwd,
    startedAt: ts,
    lastActiveAt: ts,
    lastEventTs: 0,
    tokens: zeroUsage(),
    costUsd: 0,
    files: new Set<string>(),
    edits: 0,
    reads: 0,
    commands: 0,
    usageByMsg: new Map<string, Usage>(),
    isSub
  }
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Size and mtime when the file exists and was modified at or after `cutoff`. */
async function statFresh(file: string, cutoff: number): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const st = await fsp.stat(file)
    return st.mtimeMs >= cutoff ? { size: st.size, mtimeMs: st.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/** Codex session_meta cwd from the first line of a rollout, read without tailing the whole file. */
async function peekCodexCwd(file: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(512 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    const first = nl === -1 ? text : text.slice(0, nl)
    const o = JSON.parse(first) as { type?: unknown; payload?: { cwd?: unknown } }
    return o.type === 'session_meta' && typeof o.payload?.cwd === 'string' ? o.payload.cwd : undefined
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export class AgentHub extends EventEmitter {
  private readonly repoRoot: string
  private readonly claudeHome: string
  private readonly codexHome: string
  private readonly pollMs: number
  private readonly maxAgeMs: number

  private readonly tailer = new JsonlTailer()
  private readonly files = new Map<string, TrackedFile>()
  private readonly rejected = new Set<string>()
  private readonly agents = new Map<string, AgentState>()
  private fsAgent?: AgentState
  private events: AgentEvent[] = []
  /** Files any agent has read or written; a Write to one of these is an edit. */
  private readonly knownFiles = new Set<string>()
  /** Recent agent event timestamps per file, for the fs-attribution window. */
  private readonly touches = new Map<string, number[]>()
  private readonly pendingFs = new Map<string, PendingFs>()

  private running = false
  /** Set by stop(); cuts a refresh in progress short. Cleared by start(). */
  private stopRequested = false
  private initialized = false
  private pollTimer?: ReturnType<typeof setInterval>
  private agentsTimer?: ReturnType<typeof setTimeout>
  private kickTimer?: ReturnType<typeof setTimeout>
  private watchers: FSWatcher[] = []
  private chain: Promise<void> = Promise.resolve()
  private refreshQueued = false
  private lastSig = ''
  private lastCodexFull = 0

  constructor(opts: AgentHubOptions) {
    super()
    this.repoRoot = opts.repoRoot
    this.claudeHome = opts.claudeHome ?? path.join(os.homedir(), '.claude')
    this.codexHome = opts.codexHome ?? path.join(os.homedir(), '.codex')
    this.pollMs = opts.pollMs ?? 1000
    this.maxAgeMs = (opts.maxAgeHours ?? 48) * HOUR_MS
  }

  /** Loads all sessions (no per-event emits), emits 'agents' once, then polls. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopRequested = false
    await this.refresh()
    // stop() may have run during the load: then nothing may be wired up.
    if (!this.running) return
    this.initialized = true
    this.cancelAgentsTimer()
    this.emit('agents', this.getAgents())
    this.startWatchers()
    this.pollTimer = setInterval(() => {
      if (this.running) void this.queueRefresh()
    }, this.pollMs)
    this.pollTimer.unref?.()
  }

  stop(): void {
    this.running = false
    this.stopRequested = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.cancelAgentsTimer()
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.kickTimer = undefined
    for (const p of this.pendingFs.values()) clearTimeout(p.timer)
    this.pendingFs.clear()
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
    this.watchers = []
  }

  /** Runs one discovery + tail pass and waits for it. Serialized with other passes. */
  refresh(): Promise<void> {
    return this.enqueue(() => this.doRefresh())
  }

  /** Agents (and the 'fs' pseudo agent once it has events), most recently active first. */
  getAgents(): AgentInfo[] {
    const now = Date.now()
    const out: AgentInfo[] = []
    for (const st of this.agents.values()) out.push(this.toInfo(st, now))
    if (this.fsAgent && this.fsAgent.lastEventTs > 0) out.push(this.toInfo(this.fsAgent, now))
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** Events with ts >= sinceTs (all when omitted), oldest first. Keeps the last 20k. */
  getEvents(sinceTs?: number): AgentEvent[] {
    const list = sinceTs === undefined ? this.events.slice() : this.events.filter((e) => e.ts >= sinceTs)
    list.sort((a, b) => a.ts - b.ts)
    return list.length > MAX_EVENTS ? list.slice(list.length - MAX_EVENTS) : list
  }

  /**
   * A filesystem change under the repo. If no agent event touched the file within ±3 s, an
   * event for the pseudo agent 'fs' is emitted, deferred 3 s so late agent lines can claim it.
   */
  noteFsChange(relPath: string, kind: 'add' | 'change' | 'unlink'): void {
    if (this.stopRequested) return
    const rel = this.relOf(relPath)
    if (!rel || rel === '.git' || rel.startsWith('.git/')) return
    const now = Date.now()
    const pending = this.pendingFs.get(rel)
    if (pending) {
      pending.kind = kind
      pending.ts = now
      return
    }
    if (this.touchedNear(rel, now)) return
    const timer = setTimeout(() => this.flushFs(rel), FS_WINDOW_MS)
    this.pendingFs.set(rel, { kind, ts: now, timer })
  }

  // ---- internals -----------------------------------------------------------

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private queueRefresh(): Promise<void> {
    if (this.refreshQueued) return this.chain
    this.refreshQueued = true
    return this.enqueue(async () => {
      this.refreshQueued = false
      await this.doRefresh()
    })
  }

  private async doRefresh(): Promise<void> {
    try {
      const changed = await this.scan()
      const sig = this.signature(Date.now())
      if (changed || sig !== this.lastSig) {
        this.lastSig = sig
        if (this.initialized) this.scheduleAgentsEmit()
      }
    } catch {
      // Discovery and tailing are best-effort; the next pass retries.
    }
  }

  private signature(now: number): string {
    let s = ''
    for (const st of this.agents.values()) s += `${st.id}:${this.statusOf(st, now)};`
    if (this.fsAgent) s += `fs:${this.statusOf(this.fsAgent, now)};`
    return s
  }

  private async scan(): Promise<boolean> {
    const now = Date.now()
    const cutoff = now - this.maxAgeMs
    const candidates = await this.discover(now, cutoff)

    // A tracked file that discovery did not list this pass stays tracked while it is fresh.
    const listed = new Set(candidates.map((c) => c.file))
    for (const tf of [...this.files.values()]) {
      if (listed.has(tf.file)) continue
      const st = await statFresh(tf.file, cutoff)
      if (st) candidates.push({ file: tf.file, source: tf.source, agentId: tf.agentId, parentId: tf.parentId, ...st })
      else this.dropFile(tf.file)
    }

    let changed = false
    for (;;) {
      const round = await this.readRound(candidates)
      // Across files, apply in timestamp order so Write-vs-edit and token deltas see history in order.
      round.batch.sort((a, b) => (a.p.ts ?? 0) - (b.p.ts ?? 0))
      const emit = this.initialized
      for (const { tf, p } of round.batch) this.applyParsed(tf, p, emit)
      changed = changed || round.batch.length > 0
      if (!round.more || round.bytes === 0 || this.stopRequested) break
      await yieldToEventLoop()
    }

    // Rejections are kept only while their file is still a candidate; a file that comes back is checked again.
    const live = new Set(candidates.map((c) => c.file))
    for (const f of [...this.rejected]) if (!live.has(f)) this.rejected.delete(f)
    return changed
  }

  /**
   * One bounded pass over the candidates: reads each changed or partly read file until the round's
   * byte budget is spent. `more` says a later round has bytes to read.
   */
  private async readRound(candidates: Candidate[]): Promise<{ batch: Array<{ tf: TrackedFile; p: ParsedLine }>; bytes: number; more: boolean }> {
    const batch: Array<{ tf: TrackedFile; p: ParsedLine }> = []
    let budget = READ_ROUND_BYTES
    let bytes = 0
    for (const c of candidates) {
      if (budget <= 0) break
      if (this.rejected.has(c.file)) continue
      let tf = this.files.get(c.file)
      if (!tf) {
        if (c.source === 'codex') {
          const cwd = await peekCodexCwd(c.file)
          if (cwd !== undefined && !isWithinRepo(cwd, this.repoRoot)) {
            this.rejected.add(c.file)
            continue
          }
        }
        tf = {
          file: c.file,
          source: c.source,
          agentId: c.agentId,
          parentId: c.parentId,
          idFixed: c.source !== 'codex',
          metaChecks: 0,
          backlog: false
        }
        this.files.set(c.file, tf)
      }
      if (tf.source === 'claude-sub' && tf.metaDescription === undefined && tf.metaChecks < 3) {
        tf.metaChecks++
        tf.metaDescription = await this.readMetaDescription(tf.file)
      }
      // Unchanged size and mtime (one stat, no open): nothing to read.
      if (tf.size === c.size && tf.mtimeMs === c.mtimeMs && !tf.backlog) continue

      const res = await this.tailer.readChunk(c.file, { maxBytes: budget })
      budget -= res.bytes
      bytes += res.bytes
      tf.size = c.size
      tf.mtimeMs = c.mtimeMs
      tf.backlog = res.more
      if (res.lines.length === 0) continue
      const parsed = this.parseLines(tf, res.lines)
      if (parsed === null) {
        this.rejected.add(c.file)
        this.files.delete(c.file)
        this.tailer.forget(c.file)
        continue
      }
      for (const p of parsed) batch.push({ tf, p })
    }
    const more = budget <= 0 || candidates.some((c) => this.files.get(c.file)?.backlog === true)
    return { batch, bytes, more }
  }

  /** Stops tracking a transcript. An agent with no transcript left in the window is forgotten too. */
  private dropFile(file: string): void {
    const tf = this.files.get(file)
    this.files.delete(file)
    this.tailer.forget(file)
    if (!tf) return
    for (const other of this.files.values()) if (other.agentId === tf.agentId) return
    this.agents.delete(tf.agentId)
  }

  /** Parses new lines of one file. Returns null when the file's session cwd is outside the repo. */
  private parseLines(tf: TrackedFile, lines: string[]): ParsedLine[] | null {
    const out: ParsedLine[] = []
    let lastTs = 0
    for (const line of lines) {
      const ctx: ParseCtx = { repoRoot: this.repoRoot, agentId: tf.agentId, cwd: tf.cwd }
      const p = tf.source === 'codex' ? parseCodexLine(line, ctx) : parseClaudeLine(line, ctx)
      if (!p) continue
      if (tf.source === 'codex' && p.sessionId && !tf.idFixed) {
        tf.agentId = p.sessionId
        tf.idFixed = true
      }
      if (p.cwd !== undefined) {
        const inside = isWithinRepo(p.cwd, this.repoRoot)
        if (tf.cwd === undefined && !inside) return null
        if (inside) tf.cwd = p.cwd
      }
      if (p.ts === undefined) p.ts = lastTs
      else lastTs = p.ts
      out.push(p)
    }
    return out
  }

  private applyParsed(tf: TrackedFile, p: ParsedLine, emit: boolean): void {
    const ts = p.ts ?? Date.now()
    const st = this.agentFor(tf, ts)
    if (tf.cwd) st.cwd = tf.cwd
    if (p.model) st.model = p.model
    if (p.userText !== undefined && st.promptName === undefined && st.isSub) {
      st.promptName = snippet(p.userText, 40)
    }
    st.startedAt = Math.min(st.startedAt, ts)
    st.lastActiveAt = Math.max(st.lastActiveAt, ts)

    if (p.usage) this.addClaudeUsage(st, p.usage)
    if (p.totalUsage) this.addCodexTotals(st, p.totalUsage)

    for (const ev of p.events) {
      this.applyEvent(st, { ...ev, agentId: st.id }, emit, true)
    }
  }

  private agentFor(tf: TrackedFile, ts: number): AgentState {
    let st = this.agents.get(tf.agentId)
    if (!st) {
      const kind: AgentKind = tf.source === 'codex' ? 'codex' : 'claude-code'
      st = newState(tf.agentId, kind, tf.cwd ?? this.repoRoot, ts, tf.parentId, tf.source === 'claude-sub')
      this.agents.set(tf.agentId, st)
    }
    if (st.metaDescription === undefined && tf.metaDescription) st.metaDescription = tf.metaDescription
    return st
  }

  private addClaudeUsage(st: AgentState, u: MessageUsage): void {
    const cur: Usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }
    const prev = st.usageByMsg.get(u.messageId) ?? zeroUsage()
    const delta = diffUsage(cur, prev)
    st.usageByMsg.set(u.messageId, cur)
    this.addTokens(st, delta, u.model ?? st.model)
  }

  private addCodexTotals(st: AgentState, t: TotalUsage): void {
    const cur: Usage = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: 0 }
    const prev = st.codexTotals
    // First totals or a counter reset: the whole value is new. Otherwise only the growth counts.
    const d = !prev || anyBelow(cur, prev) ? cur : diffUsage(cur, prev)
    st.codexTotals = cur
    // Codex input includes cached tokens; bill them as cache reads, the rest as fresh input.
    const delta: Usage = {
      input: Math.max(0, d.input - d.cacheRead),
      output: d.output,
      cacheRead: d.cacheRead,
      cacheWrite: 0
    }
    this.addTokens(st, delta, t.model ?? st.model)
  }

  private addTokens(st: AgentState, delta: Usage, model: string | undefined): void {
    if (!hasTokens(delta)) return
    st.tokens.input += delta.input
    st.tokens.output += delta.output
    st.tokens.cacheRead += delta.cacheRead
    st.tokens.cacheWrite += delta.cacheWrite
    st.costUsd += costUsd(model, delta)
  }

  private applyEvent(st: AgentState, ev: AgentEvent, emit: boolean, fromAgent: boolean): void {
    // Edits made in a dispatched worktree land on the main checkout's building.
    if (ev.file) ev.file = stripSkylineWorktree(ev.file)
    if (ev.type === 'create' && ev.file && this.knownFiles.has(ev.file)) ev.type = 'edit'

    if (ev.file) {
      const fileEvent = ev.type === 'read' || ev.type === 'edit' || ev.type === 'create' || ev.type === 'delete'
      if (fileEvent) st.files.add(ev.file)
      st.currentFile = ev.file
      this.knownFiles.add(ev.file)
      if (fromAgent) this.recordTouch(ev.file, ev.ts)
    }

    switch (ev.type) {
      case 'read':
        st.reads++
        st.lastAction = `Read ${ev.file ?? ev.text ?? ''}`.trim()
        break
      case 'edit':
      case 'create':
      case 'delete': {
        st.edits++
        const verb = ev.type === 'edit' ? 'Edit' : ev.type === 'create' ? 'Write' : 'Delete'
        st.lastAction = ev.file ? `${verb} ${ev.file}` : verb
        break
      }
      case 'command':
        st.commands++
        st.lastAction = `Bash: ${ev.text ?? ''}`
        break
      case 'message':
        if (ev.text) st.lastMessage = snippet(ev.text, 280)
        break
      case 'spawn':
        st.lastAction = `Spawn: ${ev.text ?? ''}`
        break
      default:
        break
    }

    st.lastType = ev.type
    st.lastEventTs = Math.max(st.lastEventTs, ev.ts)
    st.lastActiveAt = Math.max(st.lastActiveAt, ev.ts)

    this.events.push(ev)
    if (this.events.length > MAX_EVENTS + 5_000) this.events = this.events.slice(this.events.length - MAX_EVENTS)
    if (emit) this.emit('event', ev)
  }

  private touchedNear(rel: string, ts: number): boolean {
    const list = this.touches.get(rel)
    if (!list) return false
    return list.some((t) => Math.abs(t - ts) <= FS_WINDOW_MS)
  }

  private recordTouch(rel: string, ts: number): void {
    let list = this.touches.get(rel)
    if (!list) {
      list = []
      this.touches.set(rel, list)
    }
    list.push(ts)
    if (list.length > TOUCH_HISTORY) list.splice(0, list.length - TOUCH_HISTORY)
  }

  private flushFs(rel: string): void {
    const p = this.pendingFs.get(rel)
    if (!p) return
    this.pendingFs.delete(rel)
    if (this.touchedNear(rel, p.ts)) return
    const type: AgentEventType = p.kind === 'add' ? 'create' : p.kind === 'unlink' ? 'delete' : 'edit'
    const ev: AgentEvent = { id: `fs:${rel}:${p.ts}:${p.kind}`, agentId: FS_AGENT_ID, type, ts: p.ts, file: rel }
    if (!this.fsAgent) this.fsAgent = newState(FS_AGENT_ID, 'unknown', this.repoRoot, p.ts)
    this.applyEvent(this.fsAgent, ev, this.initialized, false)
    if (this.initialized) this.scheduleAgentsEmit()
  }

  /** Transcripts for this repo modified at or after `cutoff`. */
  private async discover(now: number, cutoff: number): Promise<Candidate[]> {
    const out: Listed[] = []

    const projectDirs = await claudeProjectDirsFor(this.repoRoot, this.claudeHome)
    for (const dir of projectDirs) {
      for (const e of await readDirSafe(dir)) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ file: path.join(dir, e.name), source: 'claude', agentId: e.name.slice(0, -'.jsonl'.length) })
        } else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, 'subagents')
          for (const f of await readDirSafe(sub)) {
            if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
            const base = f.name.slice(0, -'.jsonl'.length)
            out.push({
              file: path.join(sub, f.name),
              source: 'claude-sub',
              agentId: base.startsWith('agent-') ? base.slice('agent-'.length) : base,
              parentId: e.name
            })
          }
        }
      }
    }

    const full = now - this.lastCodexFull >= CODEX_FULL_SCAN_MS
    if (full) this.lastCodexFull = now
    for (const dayDir of await this.codexDayDirs(now, full)) {
      for (const f of await readDirSafe(dayDir)) {
        if (f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) {
          out.push({
            file: path.join(dayDir, f.name),
            source: 'codex',
            agentId: f.name.slice(0, -'.jsonl'.length)
          })
        }
      }
    }
    const stats = await Promise.all(out.map((c) => statFresh(c.file, cutoff)))
    const fresh: Candidate[] = []
    out.forEach((c, i) => {
      const st = stats[i]
      if (st) fresh.push({ ...c, ...st })
    })
    return fresh
  }

  /**
   * Codex day directories (sessions/YYYY/MM/DD). A full walk prunes days older than the cutoff;
   * otherwise only the days inside the window are listed.
   */
  private async codexDayDirs(now: number, full: boolean): Promise<string[]> {
    const root = path.join(this.codexHome, 'sessions')
    const cutoff = now - this.maxAgeMs - DAY_MS
    const out: string[] = []
    const pad = (n: number): string => String(n).padStart(2, '0')
    if (full) {
      for (const y of (await readDirSafe(root)).filter((d) => d.isDirectory()).map((d) => d.name)) {
        for (const m of (await readDirSafe(path.join(root, y))).filter((d) => d.isDirectory()).map((d) => d.name)) {
          for (const d of (await readDirSafe(path.join(root, y, m))).filter((x) => x.isDirectory()).map((x) => x.name)) {
            const day = new Date(Number(y), Number(m) - 1, Number(d)).getTime()
            if (!Number.isNaN(day) && day < cutoff) continue
            out.push(path.join(root, y, m, d))
          }
        }
      }
      return out
    }
    const days = Math.ceil(this.maxAgeMs / DAY_MS) + 2
    const seen = new Set<string>()
    for (let i = 0; i <= days; i++) {
      const dt = new Date(now - i * DAY_MS)
      const local = path.join(root, String(dt.getFullYear()), pad(dt.getMonth() + 1), pad(dt.getDate()))
      const utc = path.join(root, String(dt.getUTCFullYear()), pad(dt.getUTCMonth() + 1), pad(dt.getUTCDate()))
      for (const p of [local, utc]) {
        if (!seen.has(p)) {
          seen.add(p)
          out.push(p)
        }
      }
    }
    return out
  }

  private async readMetaDescription(file: string): Promise<string | undefined> {
    const metaFile = file.replace(/\.jsonl$/, '.meta.json')
    try {
      const j = JSON.parse(await fsp.readFile(metaFile, 'utf8')) as { description?: unknown }
      return typeof j.description === 'string' && j.description.trim() ? j.description.trim() : undefined
    } catch {
      return undefined
    }
  }

  private relOf(p: string): string | undefined {
    if (typeof p !== 'string' || p.trim() === '') return undefined
    // Absolute paths are made relative; relative ones are taken as repo-relative.
    const rel = relativeWithin(p, this.repoRoot)
    return rel ? stripSkylineWorktree(rel) : undefined
  }

  private statusOf(st: AgentState, now: number): AgentStatus {
    if (st.lastType && now - st.lastEventTs <= ACTIVE_MS) {
      switch (st.lastType) {
        case 'edit':
        case 'create':
        case 'delete':
          return 'editing'
        case 'read':
          return 'reading'
        case 'command':
          return 'running'
        case 'end':
          return 'done'
        default:
          return 'thinking'
      }
    }
    return now - st.lastActiveAt <= IDLE_MS ? 'idle' : 'done'
  }

  private nameOf(st: AgentState): string {
    if (st.id === FS_AGENT_ID) return 'Unattributed'
    const short = st.id.slice(0, 6)
    if (st.isSub) return st.metaDescription || st.promptName || `Claude · ${short}`
    return st.kind === 'codex' ? `Codex · ${short}` : `Claude · ${short}`
  }

  private toInfo(st: AgentState, now: number): AgentInfo {
    return {
      id: st.id,
      kind: st.kind,
      name: this.nameOf(st),
      model: st.model,
      parentId: st.parentId,
      cwd: st.cwd,
      startedAt: st.startedAt,
      lastActiveAt: st.lastActiveAt,
      status: this.statusOf(st, now),
      currentFile: st.currentFile,
      lastAction: st.lastAction,
      lastMessage: st.lastMessage,
      tokens: { ...st.tokens },
      costUsd: st.costUsd,
      filesTouched: [...st.files],
      edits: st.edits,
      reads: st.reads,
      commands: st.commands,
      color: agentColor(st.id)
    }
  }

  private scheduleAgentsEmit(): void {
    if (this.agentsTimer || !this.running) return
    this.agentsTimer = setTimeout(() => {
      this.agentsTimer = undefined
      if (this.running) this.emit('agents', this.getAgents())
    }, AGENTS_DEBOUNCE_MS)
  }

  private cancelAgentsTimer(): void {
    if (this.agentsTimer) clearTimeout(this.agentsTimer)
    this.agentsTimer = undefined
  }

  private kick(): void {
    if (!this.running || this.kickTimer) return
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined
      void this.queueRefresh()
    }, KICK_DEBOUNCE_MS)
  }

  private startWatchers(): void {
    const watchDir = (dir: string): void => {
      try {
        const w = watch(dir, { recursive: true }, () => this.kick())
        w.on('error', () => undefined)
        this.watchers.push(w)
      } catch {
        // Missing directory or unsupported platform: polling covers it.
      }
    }
    watchDir(path.join(this.claudeHome, 'projects'))
    watchDir(path.join(this.codexHome, 'sessions'))
  }
}
