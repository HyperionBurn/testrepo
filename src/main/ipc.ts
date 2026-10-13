import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { eventChannel, IPC, type EventChannel } from '@shared/ipc'
import type {
  AgentEvent,
  AgentInfo,
  Digest,
  DispatchRequest,
  GitCommit,
  LlmStatus,
  RecentSession,
  RepoSnapshot
} from '@shared/types'
import { dispatchAgent, runningDispatched, stopDispatched } from './agents/dispatch'
import { listRecentSessions } from './agents/recent'
import { RepoSession } from './session'
import { addRecent, getSettings, modelsDir } from './store'
import { readRepoText } from './repo/read'
import type { LocalLlm } from './llm/local'

const EVENT_BUDGET_PER_SEC = 200
const HISTORY_DEFAULT = 1500
const HISTORY_MAX = 5000

let mainWin: BrowserWindow | undefined
let session: RepoSession | undefined
let openSeq = 0
let llm: LocalLlm | undefined
let llmLoading: Promise<LocalLlm> | undefined

// ---- push to renderer -----------------------------------------------------------------

function send(channel: EventChannel, payload: unknown): void {
  const win = mainWin
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(eventChannel(channel), payload)
}

// 'event' is the chatty channel. Up to EVENT_BUDGET_PER_SEC go out immediately; the rest collapse
// into one pending event (the latest) that is sent when the one-second window rolls over.
let evWindowStart = 0
let evCount = 0
let evDeferred: AgentEvent | undefined
let evTimer: ReturnType<typeof setTimeout> | undefined

function sendEvent(e: AgentEvent): void {
  const now = Date.now()
  if (now - evWindowStart >= 1000) {
    evWindowStart = now
    evCount = 0
  }
  if (evCount < EVENT_BUDGET_PER_SEC) {
    evCount++
    evDeferred = undefined // a fresher event supersedes a pending one
    send('event', e)
    return
  }
  evDeferred = e
  if (!evTimer) evTimer = setTimeout(flushDeferredEvent, Math.max(0, evWindowStart + 1000 - Date.now()))
}

function flushDeferredEvent(): void {
  evTimer = undefined
  const e = evDeferred
  evDeferred = undefined
  if (!e) return
  const now = Date.now()
  if (now - evWindowStart >= 1000) {
    evWindowStart = now
    evCount = 0
  }
  evCount++
  send('event', e)
}

function attach(s: RepoSession): void {
  s.on('repo', (snap: RepoSnapshot) => send('repo', snap))
  s.on('agents', (a: AgentInfo[]) => send('agents', a))
  s.on('event', (e: AgentEvent) => sendEvent(e))
  s.on('history', (c: GitCommit[]) => send('history', c))
}

// ---- session lifecycle ----------------------------------------------------------------

function disposeSession(): void {
  const current = session
  session = undefined
  current?.dispose()
  if (evTimer) clearTimeout(evTimer)
  evTimer = undefined
  evDeferred = undefined
}

function requireSession(): RepoSession {
  if (!session) throw new Error('No repository is open')
  return session
}

// ---- LLM (loaded lazily so a broken node-llama-cpp cannot take the app down) --------------

async function getLlm(): Promise<LocalLlm> {
  if (llm) return llm
  if (!llmLoading) {
    llmLoading = import('./llm/local')
      .then((mod) => {
        const instance = new mod.LocalLlm({ modelsDir: modelsDir() })
        instance.on('status', (s: LlmStatus) => send('llm', s))
        // A digest that finished after digest() had already answered with the heuristic.
        instance.on('digest', (d: Digest) => send('digest', d))
        llm = instance
        return instance
      })
      .finally(() => {
        llmLoading = undefined
      })
  }
  return llmLoading
}

// ---- files ------------------------------------------------------------------------------

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${what} is required`)
  return v
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.floor(v)))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- handlers -----------------------------------------------------------------------------

/** Wires ipcMain handlers. Called once, after the main window is created. */
export function registerIpc(win: BrowserWindow): void {
  mainWin = win

  // Window chrome (custom titlebar buttons)
  ipcMain.handle(IPC.winMin, () => {
    win.minimize()
  })
  ipcMain.handle(IPC.winMax, () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.winClose, () => {
    win.close()
  })

  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.openRepo, async (_e, root: unknown): Promise<RepoSnapshot> => {
    const abs = path.resolve(asString(root, 'Repository path'))
    const st = await fsp.stat(abs).catch(() => null)
    if (!st?.isDirectory()) throw new Error(`Not a folder: ${abs}`)

    // The previous repo stops emitting right away. A later open supersedes this one.
    disposeSession()
    const seq = ++openSeq
    const settings = getSettings()
    const next = await RepoSession.open(abs, { claudeHome: settings.claudeDir, codexHome: settings.codexDir })
    if (seq !== openSeq) {
      next.dispose()
      throw new Error('Repository open was superseded by a newer request')
    }
    session = next
    attach(next)
    addRecent(abs)
    return next.getSnapshot()
  })

  ipcMain.handle(IPC.getAgents, (): AgentInfo[] => session?.getAgents() ?? [])

  ipcMain.handle(IPC.getEvents, (_e, sinceTs: unknown): AgentEvent[] => {
    const since = typeof sinceTs === 'number' && Number.isFinite(sinceTs) ? sinceTs : undefined
    return session?.getEvents(since) ?? []
  })

  ipcMain.handle(IPC.getHistory, async (_e, limit: unknown): Promise<GitCommit[]> => {
    if (!session) return []
    return session.getHistory(clampInt(limit, 1, HISTORY_MAX, HISTORY_DEFAULT))
  })

  ipcMain.handle(IPC.readFile, async (_e, rel: unknown): Promise<string> => {
    return readRepoText(requireSession().root, asString(rel, 'Path'))
  })

  ipcMain.handle(IPC.dispatch, async (_e, req: unknown): Promise<{ agentId: string }> => {
    const root = requireSession().root
    const r = (typeof req === 'object' && req !== null ? req : {}) as Partial<DispatchRequest>
    if (r.kind !== 'claude-code' && r.kind !== 'codex') throw new Error('Unknown agent kind')
    const result = await dispatchAgent(
      root,
      {
        kind: r.kind,
        prompt: typeof r.prompt === 'string' ? r.prompt : '',
        worktree: r.worktree === true
      },
      { logDir: path.join(app.getPath('userData'), 'logs') }
    )
    return { agentId: result.agentId }
  })

  ipcMain.handle(IPC.stopAgent, async (_e, agentId: unknown): Promise<void> => {
    await stopDispatched(asString(agentId, 'Agent id'))
  })

  ipcMain.handle(IPC.llmStatus, async (): Promise<LlmStatus> => {
    try {
      return (await getLlm()).status()
    } catch (err) {
      return { state: 'error', error: errorText(err) }
    }
  })

  ipcMain.handle(IPC.llmDownload, async (): Promise<void> => {
    await (await getLlm()).download()
  })

  ipcMain.handle(IPC.digest, async (_e, sinceTs: unknown): Promise<Digest> => {
    const since = typeof sinceTs === 'number' && Number.isFinite(sinceTs) ? sinceTs : 0
    const s = session
    const events = s?.getEvents(since) ?? []
    const agents = s?.getAgents() ?? []
    // A fresh id per request: the renderer drops a late 'digest' event that answers an older request.
    return (await getLlm()).digest(events, agents, s?.displayName ?? 'repository', randomUUID())
  })

  ipcMain.handle(IPC.explain, async (_e, rel: unknown): Promise<string> => {
    const s = requireSession()
    const p = asString(rel, 'Path')
    const content = await readRepoText(s.root, p)
    return (await getLlm()).explain(p, content, s.displayName)
  })

  ipcMain.handle(IPC.getSettings, () => getSettings())

  ipcMain.handle(IPC.listSessions, async (): Promise<RecentSession[]> => {
    const settings = getSettings()
    return listRecentSessions({ claudeHome: settings.claudeDir, codexHome: settings.codexDir })
  })

  ipcMain.handle(IPC.autoOpen, (): string | null => process.env.SKYLINE_OPEN || null)

  ipcMain.handle(IPC.saveCapture, async (_e, data: unknown, suggestedName: unknown, copy: unknown): Promise<string | null> => {
    return saveCapture(win, data, suggestedName, copy === true)
  })
}

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024

/**
 * Saves a capture after a save dialog. Under SKYLINE_CAPTURE_DIR (tests) it writes straight there.
 * PNGs can also go to the clipboard. The dialog is skipped for the file manager reveal in test mode.
 */
async function saveCapture(win: BrowserWindow, data: unknown, suggestedName: unknown, copy: boolean): Promise<string | null> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('Capture is empty')
  if (data.byteLength > MAX_CAPTURE_BYTES) throw new Error('Capture is too large')
  const name = asString(suggestedName, 'File name').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim()
  const base = path.basename(name) || 'Skyline-capture'
  const ext = path.extname(base).toLowerCase()
  const isImage = ext === '.png'
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)

  const testDir = process.env.SKYLINE_CAPTURE_DIR
  let target: string
  if (testDir) {
    await fsp.mkdir(testDir, { recursive: true })
    target = path.join(testDir, base)
  } else {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath(isImage ? 'pictures' : 'videos'), base),
      filters: isImage ? [{ name: 'PNG image', extensions: ['png'] }] : [{ name: 'WebM video', extensions: ['webm'] }]
    })
    if (result.canceled || !result.filePath) return null
    target = result.filePath
  }

  await fsp.writeFile(target, buf)
  if (copy && isImage) {
    const image = nativeImage.createFromBuffer(buf)
    if (!image.isEmpty()) clipboard.writeImage(image)
  }
  if (!testDir) shell.showItemInFolder(target)
  return target
}

/**
 * Stops the open session and the LLM. Called on app quit, which waits for the returned promise (see quit.ts).
 * Dispatched agents are user work and keep running; their pids are logged so they can be found afterwards.
 */
export async function disposeIpc(): Promise<void> {
  for (const r of runningDispatched()) {
    console.info(`[skyline] leaving ${r.kind} agent ${r.id} running, pid ${r.pid ?? 'unknown'}, cwd ${r.cwd}`)
  }
  disposeSession()
  const instance = llm
  llm = undefined
  await instance?.dispose()
}
