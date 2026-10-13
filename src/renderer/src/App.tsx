// Root: the city fills the window; the HUD floats above it. Owns startup, keyboard map and focus-driven digest.
import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react'
import { bootstrapSky, useSky } from './state/store'
import { useUi } from './lib/ui'
import { autoOpenOnStart, pickAndOpen, setMode } from './lib/actions'
import { TitleBar } from './hud/TitleBar'
import { Welcome, Scanning } from './hud/Welcome'
import { AgentDock } from './hud/AgentDock'
import { Inspector } from './hud/Inspector'
import { Timeline } from './hud/Timeline'
import { CommandBar } from './hud/CommandBar'
import { DispatchSheet } from './hud/DispatchSheet'
import { DigestCard } from './hud/DigestCard'
import { Toasts } from './hud/Toasts'

// The 3D scene is code-split. If it fails to load or throws, the window keeps a static gradient.
const CityCanvas = lazy(() => import('./city/CityCanvas'))

const DIGEST_AFTER_AWAY_MS = 10 * 60_000

class CityBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[skyline] city failed to render', error)
  }

  render(): ReactNode {
    return this.state.failed ? <div className="city-fallback" /> : this.props.children
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Escape closes the top-most overlay, then clears the selection, then the agent focus. */
function handleEscape(): void {
  const ui = useUi.getState()
  const s = useSky.getState()
  if (ui.palette) ui.setPalette(false)
  else if (ui.dispatch) ui.setDispatch(false)
  else if (ui.digest) ui.closeDigest()
  else if (s.selectedPath) s.select(null)
  else if (s.focusAgentId) s.focusAgent(null)
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

  if (mod && key === 'k') {
    e.preventDefault()
    const ui = useUi.getState()
    ui.setPalette(!ui.palette)
    return
  }
  if (mod && key === 'o') {
    e.preventDefault()
    void pickAndOpen()
    return
  }
  if (key === 'Escape') {
    handleEscape()
    return
  }
  if (mod || isTyping(e.target)) return

  const ui = useUi.getState()
  // Overlays own their keys while open.
  if (ui.palette || ui.dispatch || ui.digest) return

  const s = useSky.getState()
  let handled = true
  switch (key) {
    case 'd':
      if (s.repo) ui.setDispatch(true)
      break
    case 'g':
      if (s.repo) ui.openDigest(Date.now() - 3_600_000)
      break
    case 'i':
      s.toggleImports()
      break
    case 'f':
      s.select(null)
      break
    case '1':
      setMode('live')
      break
    case '2':
      setMode('replay')
      break
    case '3':
      setMode('git')
      break
    default:
      handled = false
  }
  // Cancel the keystroke so it does not also land in a field that a shortcut just focused.
  if (handled) e.preventDefault()
}

let autoOpened = false

export function App() {
  const repo = useSky((s) => s.repo)
  const reducedMotion = useSky((s) => s.reducedMotion)
  const scanning = useUi((s) => s.scanning)

  // Subscriptions to main-process events. Returns the disposer; StrictMode runs this twice in dev.
  useEffect(() => bootstrapSky(window.skyline), [])

  useEffect(() => {
    if (!autoOpened) {
      autoOpened = true
      void autoOpenOnStart()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'full'
  }, [reducedMotion])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Digest on return: if the window was away for more than ten minutes, offer what happened meanwhile.
  useEffect(() => {
    let blurredAt: number | null = null
    const onBlur = () => {
      blurredAt = Date.now()
    }
    const onFocus = () => {
      const since = blurredAt
      blurredAt = null
      if (since !== null && Date.now() - since > DIGEST_AFTER_AWAY_MS && useSky.getState().repo) {
        useUi.getState().openDigest(since)
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return (
    <>
      <div className="city-layer">
        <CityBoundary>
          <Suspense fallback={<div className="city-fallback" />}>
            <CityCanvas />
          </Suspense>
        </CityBoundary>
      </div>

      <div className="hud">
        <TitleBar />
        {repo && <AgentDock />}
        {repo && <Inspector />}
        {repo && <Timeline />}
        {!repo && scanning && <Scanning />}
        {!repo && !scanning && <Welcome />}

        <Toasts />
        <DigestOverlayGate />
        <PaletteGate />
        <DispatchGate />
      </div>
    </>
  )
}

function PaletteGate() {
  const open = useUi((s) => s.palette)
  return open ? <CommandBar /> : null
}

function DispatchGate() {
  const open = useUi((s) => s.dispatch)
  return open ? <DispatchSheet /> : null
}

function DigestOverlayGate() {
  const open = useUi((s) => s.digest)
  return open ? <DigestCard /> : null
}
