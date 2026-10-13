// Watches the parts of a git dir that move when HEAD, a branch or the history changes. It is separate
// from the repo watcher, which ignores .git. Emits one 'change' after a quiet period.
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'

export const GIT_REFRESH_DEBOUNCE_MS = 1000
const READY_SETTLE_MS = 100

/** Paths under a git dir whose changes mean HEAD, a ref or the reflog moved. */
export function gitWatchTargets(gitDir: string): string[] {
  return [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'packed-refs'),
    path.join(gitDir, 'refs'),
    path.join(gitDir, 'logs', 'HEAD')
  ]
}

export class GitWatcher extends EventEmitter {
  private readonly gitDir: string
  private readonly debounceMs: number
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private ready?: Promise<void>

  constructor(gitDir: string, debounceMs: number = GIT_REFRESH_DEBOUNCE_MS) {
    super()
    this.gitDir = gitDir
    this.debounceMs = debounceMs
  }

  /** Starts watching (idempotent). Resolves once the watcher is ready, so changes made after it resolves are seen. */
  start(): Promise<void> {
    if (this.ready) return this.ready
    const w = watch(gitWatchTargets(this.gitDir), { ignoreInitial: true })
    const bump = (): void => this.bump()
    w.on('add', bump)
    w.on('change', bump)
    w.on('unlink', bump)
    w.on('addDir', bump)
    w.on('unlinkDir', bump)
    w.on('error', () => undefined)
    this.watcher = w
    // chokidar reports 'ready' before nested folders (refs/heads, refs/tags) are armed, so give them a
    // moment; a ref written in that gap would otherwise be missed.
    this.ready = new Promise<void>((resolve) => w.once('ready', () => setTimeout(resolve, READY_SETTLE_MS)))
    return this.ready
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const w = this.watcher
    this.watcher = undefined
    this.ready = undefined
    if (w) await w.close()
  }

  private bump(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit('change')
    }, this.debounceMs)
  }
}
