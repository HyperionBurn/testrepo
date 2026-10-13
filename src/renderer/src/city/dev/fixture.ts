// Demo data for the city: a ~400-file fake repo with nested districts, mixed languages and imports,
// plus three simulated agents that move around it. Used for demos, screenshots and tests.
// Importing this module registers window.__skylineDemo().
import type { AgentEvent, AgentInfo, AgentKind, FileNode, GitCommit, RepoSnapshot } from '@shared/types'
import { langFromPath } from '@shared/lang'
import { agentColor } from '@shared/color'
import { useSky } from '../../state/store'

type Store = typeof useSky

declare global {
  interface Window {
    __skylineDemo?: () => void;
    /** The renderer store, for debugging and screenshots. */
    __skylineStore?: typeof useSky;
  }
}

/** Small deterministic PRNG (mulberry32), so every run builds the same fake repo. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'agent', 'store', 'view', 'panel', 'util', 'hook', 'layout', 'theme', 'parser', 'watcher', 'scan', 'git',
  'hub', 'drone', 'camera', 'glass', 'list', 'card', 'graph', 'index', 'model', 'cache', 'event', 'queue',
  'render', 'shader', 'bridge', 'config', 'types', 'session', 'tail', 'diff', 'feed', 'timeline', 'inspector',
  'dock', 'palette', 'router', 'logger', 'client', 'server', 'schema', 'token', 'pricing', 'digest', 'llm'
]

const DIRS: { dir: string; files: number; exts: string[] }[] = [
  { dir: 'src/main/agents', files: 14, exts: ['ts'] },
  { dir: 'src/main/repo', files: 10, exts: ['ts'] },
  { dir: 'src/main', files: 6, exts: ['ts'] },
  { dir: 'src/preload', files: 3, exts: ['ts'] },
  { dir: 'src/shared', files: 12, exts: ['ts'] },
  { dir: 'src/shared/__tests__', files: 8, exts: ['ts'] },
  { dir: 'src/renderer/src/city', files: 22, exts: ['ts', 'tsx'] },
  { dir: 'src/renderer/src/city/dev', files: 3, exts: ['ts'] },
  { dir: 'src/renderer/src/state', files: 4, exts: ['ts'] },
  { dir: 'src/renderer/src/hud', files: 30, exts: ['tsx', 'ts'] },
  { dir: 'src/renderer/src/hud/inspector', files: 10, exts: ['tsx'] },
  { dir: 'src/renderer/src/styles', files: 3, exts: ['css'] },
  { dir: 'tests', files: 16, exts: ['ts', 'py'] },
  { dir: 'scripts', files: 6, exts: ['mjs', 'sh', 'py'] },
  { dir: 'docs', files: 9, exts: ['md'] },
  { dir: 'resources', files: 3, exts: ['json', 'yaml'] },
  { dir: '.github/workflows', files: 3, exts: ['yml'] },
  { dir: 'packages/core/src', files: 40, exts: ['ts', 'rs'] },
  { dir: 'packages/core/src/llm', files: 14, exts: ['ts', 'cpp'] },
  { dir: 'packages/web/app/components', files: 36, exts: ['tsx', 'css'] },
  { dir: 'packages/web/app/api', files: 22, exts: ['ts', 'sql', 'go'] },
  { dir: 'services/worker', files: 18, exts: ['go', 'py'] },
  { dir: 'services/worker/pkg', files: 14, exts: ['go'] },
  { dir: 'vendor/ui', files: 20, exts: ['js', 'html'] }
]

const ROOT_FILES = ['README.md', 'SPEC.md', 'package.json', 'tsconfig.json', 'electron.vite.config.ts', 'Makefile', 'Dockerfile']

export const FIXTURE_ROOT = '/home/demo/skyline-demo'

export function makeFixtureRepo(): RepoSnapshot {
  const r = rng(20260613)
  const now = Date.now()
  const paths: { path: string; dir: string }[] = []
  for (const d of DIRS) {
    for (let i = 0; i < d.files; i++) {
      const word = WORDS[Math.floor(r() * WORDS.length)] ?? 'file'
      const ext = d.exts[Math.floor(r() * d.exts.length)] ?? 'ts'
      paths.push({ path: `${d.dir}/${word}-${i}.${ext}`, dir: d.dir })
    }
  }
  for (const f of ROOT_FILES) paths.push({ path: f, dir: '' })

  const byDir = new Map<string, string[]>()
  for (const p of paths) {
    const list = byDir.get(p.dir) ?? []
    list.push(p.path)
    byDir.set(p.dir, list)
  }
  const codeFiles = paths.map((p) => p.path).filter((p) => /\.(ts|tsx|js|py|go)$/.test(p))

  const files: FileNode[] = paths.map(({ path, dir }) => {
    const roll = r()
    let loc = Math.round(Math.exp(2 + r() * 3.6))
    if (roll < 0.04) loc *= 4
    const imports: string[] = []
    if (/\.(ts|tsx|js|py|go)$/.test(path)) {
      const same = (byDir.get(dir) ?? []).filter((x) => x !== path)
      const n = Math.floor(r() * 4)
      for (let k = 0; k < n; k++) {
        const pool = r() < 0.6 && same.length > 0 ? same : codeFiles
        const pick = pool[Math.floor(r() * pool.length)]
        if (pick && pick !== path && !imports.includes(pick)) imports.push(pick)
      }
    }
    return {
      path,
      lang: langFromPath(path),
      loc,
      bytes: loc * 34,
      mtime: now - Math.floor(r() * 30 * 86400000),
      imports,
      commits: 1 + Math.floor(r() * 20)
    }
  })

  return { root: FIXTURE_ROOT, name: 'skyline-demo', branch: 'main', files, scannedAt: now }
}

/** Git history for the time-lapse: each commit touches a few files from a slowly growing prefix of the repo. */
export function makeFixtureHistory(repo: RepoSnapshot, commitCount = 60): GitCommit[] {
  const r = rng(7)
  const order = repo.files.map((f) => f.path)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const a = order[i] ?? ''
    order[i] = order[j] ?? ''
    order[j] = a
  }
  const start = Date.now() - commitCount * 2 * 86400000
  const commits: GitCommit[] = []
  // Commit i introduces the next slice of the shuffled files, so every file appears in history
  // and the time-lapse shows the whole city growing from the ground up.
  const slice = Math.ceil(order.length / commitCount)
  for (let i = 0; i < commitCount; i++) {
    const files: GitCommit['files'] = []
    const fresh = order.slice(i * slice, (i + 1) * slice)
    const older = Math.min(order.length, i * slice)
    const touchedOld = older > 0 ? 1 + Math.floor(r() * 2) : 0
    for (const path of [...fresh, ...Array.from({ length: touchedOld }, () => order[Math.floor(r() * older)] ?? '')]) {
      if (!path || files.some((f) => f.path === path)) continue
      files.push({ path, added: 1 + Math.floor(r() * 80), removed: Math.floor(r() * 30) })
    }
    commits.push({
      hash: Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0'),
      ts: start + i * 2 * 86400000,
      author: 'demo',
      subject: `demo commit ${i + 1}`,
      files
    })
  }
  return commits.reverse() // newest first, like the main process
}

interface Persona { id: string; kind: AgentKind; name: string; parentId?: string; dir: string }

const ROSTER: Persona[] = [
  { id: 'claude-7f3a21', kind: 'claude-code', name: 'Claude · 7f3a21', dir: 'src/main/agents' },
  { id: 'codex-b19c04', kind: 'codex', name: 'Codex · b19c04', dir: 'src/renderer/src/hud' },
  { id: 'claude-sub-e52d', kind: 'claude-code', name: 'Explore · scan', parentId: 'claude-7f3a21', dir: 'packages/core/src' }
]

let stopCurrent: (() => void) | null = null

/**
 * Simulates agents moving between files: reads, edits and thinking pauses every ~1.6 s, an occasional
 * unattributed filesystem edit, and files created and later deleted (to show construction and sinking).
 * Returns a stop function.
 */
export function startFakeAgents(store: Store): () => void {
  stopCurrent?.()
  const r = rng(99)
  const started = Date.now()
  const touched = new Map<string, Set<string>>()
  const counts = new Map<string, { reads: number; edits: number; file?: string; status: AgentInfo['status'] }>()
  const timers: ReturnType<typeof setTimeout>[] = []
  const generated: string[] = []
  let tick = 0

  const pick = (dir: string, files: FileNode[]): string | undefined => {
    const inDir = files.filter((f) => f.path.startsWith(dir + '/'))
    const pool = r() < 0.7 && inDir.length > 0 ? inDir : files
    return pool[Math.floor(r() * pool.length)]?.path
  }

  const emit = (agentId: string, type: AgentEvent['type'], file: string | undefined, ts: number): void => {
    store.getState().pushEvent({
      id: `${agentId}-${ts}-${Math.floor(r() * 1e9)}`,
      agentId,
      type,
      ts,
      file,
      linesAdded: type === 'edit' ? 1 + Math.floor(r() * 12) : undefined,
      linesRemoved: type === 'edit' ? Math.floor(r() * 5) : undefined
    })
  }

  const publishAgents = (): void => {
    const repo = store.getState().repo
    const now = Date.now()
    const list: AgentInfo[] = ROSTER.map((p) => {
      const c = counts.get(p.id) ?? { reads: 0, edits: 0, status: 'idle' as AgentInfo['status'] }
      const files = [...(touched.get(p.id) ?? [])]
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        parentId: p.parentId,
        model: 'claude-sonnet',
        cwd: repo?.root ?? FIXTURE_ROOT,
        startedAt: started,
        lastActiveAt: now,
        status: c.status,
        currentFile: c.file,
        lastAction: c.file ? `${c.status === 'editing' ? 'Edit' : 'Read'} ${c.file}` : undefined,
        tokens: { input: 1200 * (tick + 1), output: 300 * (tick + 1), cacheRead: 9000 * (tick + 1), cacheWrite: 0 },
        costUsd: 0.01 * (tick + 1),
        filesTouched: files,
        edits: c.edits,
        reads: c.reads,
        commands: 0,
        color: agentColor(p.id)
      }
    })
    store.getState().setAgents(list)
  }

  const interval = setInterval(() => {
    const s = store.getState()
    const repo = s.repo
    if (!repo || repo.files.length === 0) return
    tick++
    const now = Date.now()

    for (const p of ROSTER) {
      const roll = r()
      const set = touched.get(p.id) ?? new Set<string>()
      touched.set(p.id, set)
      const c = counts.get(p.id) ?? { reads: 0, edits: 0, status: 'idle' as AgentInfo['status'] }
      counts.set(p.id, c)
      if (roll < 0.18) {
        c.status = 'thinking'
        continue
      }
      if (roll < 0.45) {
        // A reading burst across a few files.
        c.status = 'reading'
        for (let k = 0; k < 2; k++) {
          const f = pick(p.dir, repo.files)
          if (!f) continue
          c.file = f
          c.reads++
          set.add(f)
          emit(p.id, 'read', f, now + k * 120)
        }
        continue
      }
      const f = pick(p.dir, repo.files)
      if (!f) continue
      c.file = f
      c.status = 'editing'
      c.reads++
      set.add(f)
      emit(p.id, 'read', f, now)
      timers.push(setTimeout(() => {
        c.edits++
        set.add(f)
        emit(p.id, 'edit', f, Date.now())
      }, 700))
    }

    // Unattributed changes from a human or another tool: heat only, no drone.
    if (tick % 4 === 0) {
      const f = pick('src', repo.files)
      if (f) emit('fs', 'edit', f, now)
    }

    // A new file appears in the HUD folder, then is removed later.
    if (tick % 16 === 0) {
      const path = `src/renderer/src/hud/generated-${generated.length + 1}.tsx`
      generated.push(path)
      const latest = store.getState().repo
      if (latest) {
        const node: FileNode = { path, lang: langFromPath(path), loc: 40 + Math.floor(r() * 180), bytes: 2000, mtime: now, imports: [] }
        store.getState().setRepo({ ...latest, files: [...latest.files, node], scannedAt: now })
        emit('claude-7f3a21', 'create', path, now)
      }
    }
    if (tick % 24 === 0 && generated.length > 0) {
      const path = generated.shift()
      const latest = store.getState().repo
      if (path && latest) {
        store.getState().setRepo({ ...latest, files: latest.files.filter((f) => f.path !== path), scannedAt: now })
        emit('claude-7f3a21', 'delete', path, now)
      }
    }

    publishAgents()
  }, 1600)

  const stop = (): void => {
    clearInterval(interval)
    for (const t of timers) clearTimeout(t)
    if (stopCurrent === stop) stopCurrent = null
  }
  stopCurrent = stop
  publishAgents()
  return stop
}

/** Loads the demo repo, history and agents into the store. Callable from the devtools console. */
function runDemo(): void {
  const repo = makeFixtureRepo()
  useSky.getState().setRepo(repo)
  useSky.getState().setCommits(makeFixtureHistory(repo))
  startFakeAgents(useSky)
}

window.__skylineDemo = runDemo
window.__skylineStore = useSky
