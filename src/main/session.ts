// RepoSession: everything that lives while one repository is open. Owns the snapshot, the file
// watcher, the agent hub and cached git history. Emits 'repo' (debounced), 'agents' and 'event'.
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import type { AgentEvent, AgentInfo, FileNode, GitCommit, RepoSnapshot } from '../shared/types'
import { AgentHub } from './agents/hub'
import { churnCounts, getHistory, HISTORY_LIMIT, isGitRepo } from './repo/git'
import { scanFile, scanRepo } from './repo/scan'
import { RepoWatcher, type FsChange } from './repo/watch'

const REPO_EMIT_DEBOUNCE_MS = 500
/** Upper bound on how long a steady stream of changes can postpone the 'repo' emit. */
const REPO_EMIT_MAX_WAIT_MS = 2000

export interface RepoSessionOptions {
  claudeHome?: string
  codexHome?: string
}

export class RepoSession extends EventEmitter {
  readonly root: string
  private name: string
  private branch?: string
  private scannedAt = 0
  private readonly files = new Map<string, FileNode>()
  private readonly churn = new Map<string, number>()
  private history: GitCommit[] = []
  private isGit = false
  private readonly watcher: RepoWatcher
  private readonly hub: AgentHub
  private queue: Promise<void> = Promise.resolve()
  private emitTimer?: ReturnType<typeof setTimeout>
  private firstPendingAt?: number
  private disposed = false

  private constructor(root: string, opts: RepoSessionOptions) {
    super()
    this.root = root
    this.name = path.basename(root) || root
    this.watcher = new RepoWatcher(root)
    this.hub = new AgentHub({ repoRoot: root, claudeHome: opts.claudeHome, codexHome: opts.codexHome })
  }

  /** Scans the repo, starts the watcher and the agent hub. The hub loads in the background. */
  static async open(root: string, opts: RepoSessionOptions = {}): Promise<RepoSession> {
    const session = new RepoSession(path.resolve(root), opts)
    await session.init()
    return session
  }

  private async init(): Promise<void> {
    this.isGit = await isGitRepo(this.root)
    this.history = await getHistory(this.root, HISTORY_LIMIT)
    // Watch before scanning so nothing changed during the scan is missed. Change handling is queued
    // behind the initial scan, so every change applies to a loaded snapshot.
    this.watcher.on('change', (c: FsChange) => this.onChange(c))
    this.watcher.start()
    await this.enqueue(() => this.loadSnapshot())

    this.hub.on('agents', (a: AgentInfo[]) => {
      if (!this.disposed) this.emit('agents', a)
    })
    this.hub.on('event', (e: AgentEvent) => {
      if (!this.disposed) this.emit('event', e)
    })
    this.hub.start().catch(() => undefined)
  }

  private async loadSnapshot(): Promise<void> {
    for (const [p, n] of churnCounts(this.history)) this.churn.set(p, n)
    const snap = await scanRepo(this.root, { history: this.history })
    if (this.disposed) return
    for (const f of snap.files) this.files.set(f.path, f)
    this.name = snap.name
    this.branch = snap.branch
    this.scannedAt = snap.scannedAt
  }

  get displayName(): string {
    return this.name
  }

  getSnapshot(): RepoSnapshot {
    const files = [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { root: this.root, name: this.name, branch: this.branch, files: files.map((f) => ({ ...f })), scannedAt: this.scannedAt }
  }

  getAgents(): AgentInfo[] {
    return this.hub.getAgents()
  }

  getEvents(sinceTs?: number): AgentEvent[] {
    return this.hub.getEvents(sinceTs)
  }

  /** Commit history, newest first. Served from the cache when it covers `limit`. */
  async getHistory(limit = HISTORY_LIMIT): Promise<GitCommit[]> {
    if (limit <= this.history.length || this.history.length < HISTORY_LIMIT) return this.history.slice(0, limit)
    const longer = await getHistory(this.root, limit)
    if (longer.length > this.history.length) this.history = longer
    return longer.slice(0, limit)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.watcher.removeAllListeners()
    this.watcher.stop().catch(() => undefined)
    this.hub.removeAllListeners()
    this.hub.stop()
    this.removeAllListeners()
  }

  // ---- internals ---------------------------------------------------------------

  private onChange(change: FsChange): void {
    if (this.disposed) return
    this.hub.noteFsChange(change.rel, change.kind)
    void this.enqueue(() => this.applyChange(change)).catch(() => undefined)
  }

  /** Runs tasks one at a time, in order. The returned promise settles with the task's own result. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async applyChange(change: FsChange): Promise<void> {
    if (this.disposed) return
    const { rel, kind } = change
    if (kind === 'unlink') {
      if (!this.files.delete(rel)) return
    } else {
      const node = await scanFile(this.root, rel, {
        knownPaths: new Set(this.files.keys()),
        churn: this.history.length > 0 ? this.churn : undefined,
        git: this.isGit
      })
      if (this.disposed) return
      if (node) this.files.set(rel, node)
      else if (!this.files.delete(rel)) return
    }
    this.scheduleRepoEmit()
  }

  private scheduleRepoEmit(): void {
    if (this.disposed) return
    const now = Date.now()
    if (this.firstPendingAt === undefined) this.firstPendingAt = now
    if (this.emitTimer) clearTimeout(this.emitTimer)
    const untilMax = this.firstPendingAt + REPO_EMIT_MAX_WAIT_MS - now
    this.emitTimer = setTimeout(() => this.flushRepo(), Math.max(0, Math.min(REPO_EMIT_DEBOUNCE_MS, untilMax)))
  }

  private flushRepo(): void {
    this.emitTimer = undefined
    this.firstPendingAt = undefined
    if (!this.disposed) this.emit('repo', this.getSnapshot())
  }
}
