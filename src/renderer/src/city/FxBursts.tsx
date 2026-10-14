// Event bursts: an edit throws a ground shockwave in the agent's colour and an upward spray scaled by the lines
// added; a commit or push lights a firework above the city; a test run sends a pulsing wave across its district
// (green pass, red fail, cyan when the result is not known). Pooled: one Points and one instanced ring mesh.
import { useEffect, useState } from 'react'
import { Color } from 'three'
import { findBuilding } from '@shared/layout'
import type { CityLayout } from '@shared/types'
import { visCenter, visHeight } from './geom'
import { fxCtx, onFx, registerCounter, registerFx, type FxEvent, type FxSystem } from './fx/core'
import { getParticles, getRings } from './fx/pools'
import { burstCount, makeRng, districtBox } from './fx/model'

const PASS = new Color('#30d158')
const FAIL = new Color('#ff453a')
const UNKNOWN = new Color('#64d2ff')
const GOLD = new Color('#ffd60a')
const WHITE = new Color('#ffffff')

/** A scheduled effect: a firework burst or a ring, fired at time `at`. */
interface Pending {
  live: boolean
  at: number
  kind: 'burst' | 'ring' | 'sphere'
  x: number
  y: number
  z: number
  r0: number
  r1: number
  dur: number
  count: number
  color: Color
  strength: number
}

const MAX_PENDING = 24

export class BurstDirector implements FxSystem {
  private readonly pending: Pending[] = []
  private readonly rnd = makeRng(9001)
  private unsub: (() => void) | null = null
  private unreg: (() => void) | null = null
  private unstat: (() => void) | null = null
  private unstat2: (() => void) | null = null

  constructor() {
    for (let i = 0; i < MAX_PENDING; i++) {
      this.pending.push({
        live: false, at: 0, kind: 'burst', x: 0, y: 0, z: 0, r0: 0, r1: 0, dur: 1, count: 0, color: new Color(), strength: 1
      })
    }
  }

  /** Starts listening for events and registers for stepping. Idempotent. */
  start(): void {
    if (this.unsub) return
    this.unsub = onFx((e) => this.onEvent(e))
    this.unreg = registerFx(this)
    this.unstat = registerCounter('rings', () => getRings().activeCount())
    this.unstat2 = registerCounter('particles', () => getParticles().activeCount())
  }

  dispose(): void {
    this.unsub?.()
    this.unreg?.()
    this.unstat?.()
    this.unstat2?.()
    this.unsub = null
    this.unreg = null
  }

  private schedule(at: number): Pending | null {
    for (const p of this.pending) {
      if (!p.live) {
        p.live = true
        p.at = at
        return p
      }
    }
    return null
  }

  private onEvent(e: FxEvent): void {
    if (fxCtx.reduced) return
    const L = fxCtx.layout
    const now = fxCtx.time
    if (e.type === 'touch') {
      const b = L ? findBuilding(L, e.file) : undefined
      if (!L || !b) return
      const c = visCenter(b, L)
      const top = visHeight(b, L)
      const col = new Color(e.color)
      const r = Math.max(b.w, b.d) / 2 + 0.6
      getRings().spawn(c.x, c.z, r, r + 12, 1.2, col, 0.9)
      // The spray: more lines, more particles. New files also get a white flash.
      getParticles().burst(c.x, top * 0.7, c.z, burstCount(e.lines), 5 + Math.min(4, e.lines / 40), 0.9, col, 1.1, -6, this.rnd)
      if (e.kind === 'create') getParticles().burst(c.x, top, c.z, 14, 4, 0.9, WHITE, 0.9, -4, this.rnd)
      return
    }
    if (e.type === 'command') {
      const box = districtBox(L, e.file)
      const cx = box?.x ?? 0
      const cz = box?.z ?? 0
      if (e.kind === 'commit') {
        // A firework above the city: three bursts, staggered, over the agent's district.
        const top = maxHeight(L)
        const palette = [GOLD, WHITE, new Color(e.color)]
        for (let k = 0; k < 3; k++) {
          const p = this.schedule(now + k * 0.35)
          if (!p) break
          p.kind = 'sphere'
          p.x = cx + (this.rnd() - 0.5) * 16
          p.y = top + 10 + this.rnd() * 8
          p.z = cz + (this.rnd() - 0.5) * 16
          p.count = 64
          p.color.copy(palette[k % palette.length] ?? WHITE)
        }
        return
      }
      if (e.kind === 'test') {
        const r = box ? box.r * 1.2 + 4 : 24
        const col = e.result === 'pass' ? PASS : e.result === 'fail' ? FAIL : UNKNOWN
        for (let k = 0; k < 2; k++) {
          const p = this.schedule(now + k * 0.45)
          if (!p) break
          p.kind = 'ring'
          p.x = cx
          p.y = 0
          p.z = cz
          p.r0 = 2
          p.r1 = r
          p.dur = 2.2
          p.strength = k === 0 ? 1 : 0.6
          p.color.copy(col)
        }
      }
      return
    }
    if (e.type === 'popup') {
      // Popups are the popup system's job; the director ignores them.
      return
    }
  }

  update(_dt: number, ctx: { time: number; layout: CityLayout | null }): void {
    for (const p of this.pending) {
      if (!p.live || p.at > ctx.time) continue
      p.live = false
      if (p.kind === 'ring') {
        getRings().spawn(p.x, p.z, p.r0, p.r1, p.dur, p.color, p.strength)
      } else if (p.kind === 'sphere') {
        emitSphere(p.x, p.y, p.z, p.count, p.color, this.rnd)
      }
    }
  }
}

function emitSphere(x: number, y: number, z: number, count: number, color: Color, rnd: () => number): void {
  const pool = getParticles()
  for (let i = 0; i < count; i++) {
    // Uniform direction on the sphere, then a random speed: a clean shell of sparks.
    const u = rnd() * 2 - 1
    const a = rnd() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const sp = 6 + rnd() * 3
    pool.emit(x, y, z, Math.cos(a) * s * sp, u * sp, Math.sin(a) * s * sp, color, 0.5 + rnd() * 0.3, 1.2 + rnd() * 0.7, -4.5)
  }
}

/** Height a firework must clear: the tallest rendered building, with a margin. */
function maxHeight(L: CityLayout | null): number {
  if (!L) return 20
  let m = 0
  for (const b of L.buildings) m = Math.max(m, visHeight(b, L))
  return Math.max(20, m + 8)
}

/** Mounts the shared particle and ring objects, and runs the event director. */
export function FxBursts() {
  const [director] = useState(() => new BurstDirector())
  useEffect(() => {
    director.start()
    return () => director.dispose()
  }, [director])
  return (
    <>
      <primitive object={getRings().object} />
      <primitive object={getParticles().object} />
    </>
  )
}
