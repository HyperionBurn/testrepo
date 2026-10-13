// RepoSession: everything that lives while one repository is open. Owns the snapshot, the file
// watcher, the git-dir watcher, the agent hub and cached git history. Emits 'repo' (debounced),
// 'history' (after a git refresh), 'agents' and 'event'.
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import type { AgentEvent, AgentInfo, FileNode, GitCommit, RepoSnapshot } from '../shared/types'
import { AgentHub } from './agents/hub'
import { churnCounts, currentBranch, getHistory, gitDirOf, HISTORY_LIMIT, isGitRepo } from './repo/git'
import { GitWatcher } from './repo/git-watch'
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
  /** Files sorted by path, copied from `files`. Rebuilt lazily after any change to `files`. */
  private sortedFiles?: FileNode[]
  private isGit = false
  private readonly watcher: RepoWatcher
  private gitWatcher?: GitWatcher
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
    // dispose() can run during any await below: each step checks it before starting anything new.
    if (this.disposed) return
    // Watch before scanning so nothing changed during the scan is missed. Change handling is queued
    // behind the initial scan, so every change applies to a loaded snapshot.
    this.watcher.on('change', (c: FsChange) => this.onChange(c))
    this.watcher.start()
    await this.enqueue(() => this.loadSnapshot())
    if (this.disposed) return
    // The city opens on the scan alone. git log (the slow part on large repos) runs next, queued behind
    // the scan: refreshGit fills in churn and history, then emits 'history' and 'repo'.
    void this.enqueue(() => this.refreshGit()).catch(() => undefined)
    await this.startGitWatch()
    if (this.disposed) return

    this.hub.on('agents', (a: AgentInfo[]) => {
      if (!this.disposed) this.emit('agents', a)
    })
    this.hub.on('event', (e: AgentEvent) => {
      if (!this.disposed) this.emit('event', e)
    })
    // Loads in the background: open() does not wait for the agent history.
    this.hub.start().catch(() => undefined)
  }

  /** Watches HEAD, refs and the reflog; a change re-reads history after a short quiet period. */
  private async startGitWatch(): Promise<void> {
    if (!this.isGit || this.disposed) return
    const gitDir = await gitDirOf(this.root)
    if (!gitDir || this.disposed) return
    const gw = new GitWatcher(gitDir)
    gw.on('change', () => {
      if (!this.disposed) void this.enqueue(() => this.refreshGit()).catch(() => undefined)
    })
    this.gitWatcher = gw
    await gw.start()
  }

  private async loadSnapshot(): Promise<void> {
    // An empty history keeps scanRepo from running git log; churn arrives with refreshGit.
    const snap = await scanRepo(this.root, { history: [] })
    if (this.disposed) return
    for (const f of snap.files) this.files.set(f.path, f)
    this.sortedFiles = undefined
    this.name = snap.name
    this.branch = snap.branch
    this.scannedAt = snap.scannedAt
  }

  get displayName(): string {
    return this.name
  }

  getSnapshot(): RepoSnapshot {
    if (!this.sortedFiles) {
      this.sortedFiles = [...this.files.values()]
        .map((f) => ({ ...f }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    }
    // A shallow copy of the array: callers get their own list, and IPC clones the nodes.
    return { root: this.root, name: this.name, branch: this.branch, files: this.sortedFiles.slice(), scannedAt: this.scannedAt }
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
    this.gitWatcher?.removeAllListeners()
    this.gitWatcher?.stop().catch(() => undefined)
    this.gitWatcher = undefined
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
    this.sortedFiles = undefined
    this.scheduleRepoEmit()
  }

  /**
   * Re-reads history after HEAD, a branch or the reflog moved: fresh churn counts on every file,
   * then 'history' and 'repo'. An empty read keeps the cache, so a failed git call cannot wipe it.
   */
  private async refreshGit(): Promise<void> {
    if (this.disposed) return
    const history = await getHistory(this.root, Math.max(HISTORY_LIMIT, this.history.length))
    if (this.disposed || history.length === 0) return
    this.history = history
    this.churn.clear()
    for (const [p, n] of churnCounts(history)) this.churn.set(p, n)
    for (const f of this.files.values()) f.commits = this.churn.get(f.path) ?? 0
    this.sortedFiles = undefined
    this.branch = (await currentBranch(this.root)) ?? this.branch
    if (this.disposed) return
    this.emit('history', history.slice())
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
