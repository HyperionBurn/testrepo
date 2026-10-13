// Capture controls: the title-bar menu (snapshot, flyover) and the progress pill shown while a capture runs.
import { useEffect, useRef, useState } from 'react'
import { captureBusy, FLYOVER_SECONDS, recordFlyover, takeSnapshot, useCapture } from '../lib/capture'
import { IconCamera, IconChevronDown, IconImage, IconVideo } from './icons'

export function CaptureMenu() {
  const [open, setOpen] = useState(false)
  const busy = useCapture((s) => s.busy)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn: () => Promise<void>) => {
    setOpen(false)
    if (!captureBusy()) void fn()
  }

  return (
    <div className="capture no-drag" ref={wrap}>
      <button
        className="capsule capsule--ghost capsule--sm"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Capture the city (S snapshot, Shift+S flyover)"
      >
        <IconCamera size={13} />
        <span className="muted">Capture</span>
        <IconChevronDown size={11} />
      </button>
      {open && (
        <div className="capture-menu glass-strong" role="menu">
          <button className="capture-menu__item" role="menuitem" onClick={() => run(takeSnapshot)}>
            <span className="capture-menu__icon">
              <IconImage size={15} />
            </span>
            <span className="capture-menu__text">
              <span className="capture-menu__title">Snapshot</span>
              <span className="capture-menu__sub">PNG with stats card, copied to clipboard</span>
            </span>
            <kbd className="kbd">S</kbd>
          </button>
          <button className="capture-menu__item" role="menuitem" onClick={() => run(recordFlyover)}>
            <span className="capture-menu__icon">
              <IconVideo size={15} />
            </span>
            <span className="capture-menu__text">
              <span className="capture-menu__title">Flyover video ({FLYOVER_SECONDS}s)</span>
              <span className="capture-menu__sub">WebM orbit, Esc cancels</span>
            </span>
            <kbd className="kbd">⇧S</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

const RING_R = 9
const RING_C = 2 * Math.PI * RING_R

/** Shown while a capture runs: a progress ring for the flyover, a spinner while a snapshot renders. */
export function CapturePill() {
  const busy = useCapture((s) => s.busy)
  const progress = useCapture((s) => s.progress)
  const seconds = useCapture((s) => s.seconds)
  if (!busy) return null
  const flying = busy === 'flyover'
  const left = Math.max(0, Math.ceil(seconds * (1 - progress)))
  return (
    <div className="capture-pill glass-strong" role="status" aria-live="polite">
      <svg className={`capture-pill__ring${flying ? '' : ' capture-pill__ring--spin'}`} width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={RING_R} className="capture-pill__track" />
        <circle
          cx="11"
          cy="11"
          r={RING_R}
          className="capture-pill__bar"
          strokeDasharray={RING_C}
          strokeDashoffset={flying ? RING_C * (1 - progress) : RING_C * 0.7}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span className="capture-pill__label">{flying ? `Recording flyover · ${left}s` : 'Rendering snapshot…'}</span>
      {flying && <span className="capture-pill__hint">Esc to cancel</span>}
    </div>
  )
}
