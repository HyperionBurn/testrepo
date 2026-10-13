// Cross-component actions that talk to window.skyline and the stores.
import type { Settings } from '@shared/types'
import { useSky, type Mode } from '../state/store'
import { useUi } from './ui'
import { errorText, toast } from './toast'

let openSeq = 0

/** Runs a SkylineAPI call and turns failures into a single toast. Returns undefined on failure. */
export async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    toast.error(label, errorText(e))
    return undefined
  }
}

/** Scans a repo and loads agents, events and history into the store. Newest open wins. */
export async function openRepoPath(root: string): Promise<boolean> {
  const api = window.skyline
  const ui = useUi.getState()
  const seq = ++openSeq
  ui.setScanning(true, 'Surveying the city…')
  try {
    const snap = await api.openRepo(root)
    if (seq !== openSeq) return false
    const s = useSky.getState()
    if (s.repo?.root !== snap.root) {
      // A different repo: drop state that belonged to the previous one.
      s.select(null)
      s.focusAgent(null)
      s.setEvents([])
      s.setCommits([])
      s.setAgents([])
    }
    s.setRepo(snap)
    const [agents, events, commits] = await Promise.allSettled([
      api.getAgents(),
      api.getEvents(),
      api.getHistory()
    ])
    if (seq !== openSeq) return true
    const next = useSky.getState()
    if (agents.status === 'fulfilled') next.setAgents(agents.value)
    if (events.status === 'fulfilled') next.setEvents(events.value)
    if (commits.status === 'fulfilled') next.setCommits(commits.value)
    const failed = [agents, events, commits].filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      const reason = failed[0]?.status === 'rejected' ? errorText(failed[0].reason) : ''
      toast.error('Some city data did not load', reason)
    }
    return true
  } catch (e) {
    toast.error('Could not open repository', errorText(e))
    return false
  } finally {
    if (seq === openSeq) ui.setScanning(false)
  }
}

/** Native folder picker, then open. */
export async function pickAndOpen(): Promise<void> {
  const path = await attempt('Could not open the folder picker', () => window.skyline.pickFolder())
  if (path) await openRepoPath(path)
}

/** Reads settings for the welcome screen. Returns null if unavailable. */
export async function loadSettings(): Promise<Settings | null> {
  const s = await attempt('Settings unavailable', () => window.skyline.getSettings())
  return s ?? null
}

/** Switches mode and seeds the matching cursor so the scrubber starts somewhere sensible. */
export function setMode(mode: Mode): void {
  const s = useSky.getState()
  if (mode === 'live') {
    s.setReplayTs(null)
    s.setGitTs(null)
  } else if (mode === 'replay' && s.replayTs === null) {
    s.setReplayTs(s.events[0]?.ts ?? Date.now())
  } else if (mode === 'git' && s.gitTs === null) {
    const oldest = s.commits.length ? s.commits[s.commits.length - 1]?.ts : undefined
    s.setGitTs(oldest ?? Date.now())
  }
  s.setMode(mode)
}

/** Opens the most recent repo at startup when the main process offers one. */
export async function autoOpenOnStart(): Promise<void> {
  const api = window.skyline as typeof window.skyline & { autoOpen?: () => Promise<string | null> }
  if (typeof api.autoOpen !== 'function') return
  const path = await attempt('Could not restore the last repository', () => api.autoOpen!())
  if (path) await openRepoPath(path)
}
