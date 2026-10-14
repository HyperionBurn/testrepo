// Letterbox bars for director mode: glass strips across the top and bottom that slide in and out with the mode.
// Pointer-free, and hidden while a capture stages the camera (the bars are not in the recorded canvas anyway).
import type { CSSProperties } from 'react'
import { useSky } from '../state/store'

const BAR_H = '6%'

export function DirectorBars() {
  const on = useSky((s) => s.director && s.capture === null)
  const reduced = useSky((s) => s.reducedMotion)
  const base: CSSProperties = {
    position: 'fixed',
    left: 0,
    right: 0,
    height: BAR_H,
    pointerEvents: 'none',
    zIndex: 40,
    background: 'linear-gradient(180deg, rgba(5, 7, 13, 0.9), rgba(5, 7, 13, 0.78))',
    boxShadow: '0 0 28px rgba(0, 0, 0, 0.6)',
    transition: reduced ? 'none' : 'transform 0.9s cubic-bezier(0.2, 0.7, 0.2, 1)'
  }
  return (
    <>
      <div aria-hidden="true" style={{ ...base, top: 0, transform: on ? 'translateY(0)' : 'translateY(-100%)' }} />
      <div aria-hidden="true" style={{ ...base, bottom: 0, transform: on ? 'translateY(0)' : 'translateY(100%)' }} />
    </>
  )
}
