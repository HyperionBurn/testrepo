// File watcher for one repo. Emits forward-slash, repo-relative paths; ignores build and VCS folders.
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { isIgnoredRel } from './ignore'

export type FsChangeKind = 'add' | 'change' | 'unlink'
export interface FsChange {
  rel: string
  kind: FsChangeKind
}

export class RepoWatcher extends EventEmitter {
  private readonly root: string
  private watcher?: FSWatcher

  constructor(root: string) {
    super()
    this.root = path.resolve(root)
  }

  /** Starts watching (idempotent). Emits 'change' with an FsChange for every file add, change or unlink. */
  start(): void {
    if (this.watcher) return
    const root = this.root
    const w = watch(root, {
      ignored: (p: string) => {
        const rel = path.relative(root, p)
        return rel !== '' && isIgnoredRel(rel)
      },
      ignoreInitial: true,
      // A symlink can point outside the repo (or into .git). Watch the link itself, never its target.
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    w.on('add', (p) => this.report(p, 'add'))
    w.on('change', (p) => this.report(p, 'change'))
    w.on('unlink', (p) => this.report(p, 'unlink'))
    w.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err)
    })
    this.watcher = w
  }

  async stop(): Promise<void> {
    const w = this.watcher
    this.watcher = undefined
    if (w) await w.close()
  }

  private report(abs: string, kind: FsChangeKind): void {
    const rel = path.relative(this.root, abs).split(path.sep).join('/')
    if (rel === '' || isIgnoredRel(rel)) return
    const change: FsChange = { rel, kind }
    this.emit('change', change)
  }
}
