// Small React hooks shared by HUD components.
import { useEffect, useRef, useState } from 'react'

/** Current time, refreshed on an interval. Used for relative timestamps and sparkline windows. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Runs `fn` on every animation frame while `active`, passing the frame delta in ms (capped at 64). */
export function useFrame(active: boolean, fn: (dtMs: number) => void): void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dt = Math.min(64, t - last)
      last = t
      fnRef.current(dt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
}
