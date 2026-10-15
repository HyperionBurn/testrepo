// Floating cost and token popups ("+$0.01 · 1.5k tok") that rise from a drone when its spend grows. One merged line
// per agent per POPUP_MERGE_S window (Drones.tsx), at most MAX_VISIBLE_POPUPS on screen (the oldest yields), each
// fading quickly. A fixed pool of drei Html elements, moved and restyled imperatively each frame: no draw calls and no
// React renders. A shot hides them unless it asked for tags.
import { useEffect, useState } from 'react'
import { Html } from '@react-three/drei'
import type { Object3D } from 'three'
import { fxCtx, onFx, registerCounter, registerFx, type FxEvent, type FxSystem } from './fx/core'
import { MAX_POPUPS, MAX_VISIBLE_POPUPS, POPUP_LIFE_S, pickPopupSlot, popupAlpha, popupToRetire } from './fx/model'
import { shotLayers } from './capture'

interface Slot {
  active: boolean
  age: number
  x: number
  y: number
  z: number
  text: string
  color: string
  shown: string
  group: Object3D | null
  el: HTMLDivElement | null
}

export class PopupSystem implements FxSystem {
  readonly slots: Slot[] = []
  private unsub: (() => void) | null = null
  private unreg: (() => void) | null = null
  private unstat: (() => void) | null = null

  constructor() {
    for (let i = 0; i < MAX_POPUPS; i++) {
      this.slots.push({ active: false, age: 0, x: 0, y: 0, z: 0, text: '', color: '#fff', shown: '', group: null, el: null })
    }
  }

  /** Starts listening for popup events and registers for stepping. Idempotent. */
  start(): void {
    if (this.unsub) return
    this.unsub = onFx((e) => this.onEvent(e))
    this.unreg = registerFx(this)
    this.unstat = registerCounter('popups', () => this.slots.filter((s) => s.active).length)
  }

  dispose(): void {
    this.unsub?.()
    this.unreg?.()
    this.unstat?.()
    this.unsub = null
    this.unreg = null
  }

  attach(i: number, group: Object3D | null, el: HTMLDivElement | null): void {
    const s = this.slots[i]
    if (!s) return
    if (group) s.group = group
    if (el) s.el = el
  }

  private onEvent(e: FxEvent): void {
    if (e.type !== 'popup' || fxCtx.reduced) return
    const retire = popupToRetire(this.slots, MAX_VISIBLE_POPUPS)
    if (retire >= 0) {
      const old = this.slots[retire]
      if (old) {
        old.active = false
        if (old.group) old.group.visible = false
      }
    }
    const i = pickPopupSlot(this.slots)
    const s = this.slots[i]
    if (!s) return
    s.active = true
    s.age = 0
    s.x = e.x
    s.y = e.y
    s.z = e.z
    s.text = e.text
    s.color = e.color
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) {
        if (s.group?.visible) s.group.visible = false
        continue
      }
      s.age += dt
      if (s.age >= POPUP_LIFE_S) {
        s.active = false
        if (s.group) s.group.visible = false
        continue
      }
      const u = s.age / POPUP_LIFE_S
      const show = shotLayers().tags
      if (s.group) {
        s.group.visible = show
        s.group.position.set(s.x, s.y + s.age * 1.1, s.z)
      }
      const el = s.el
      if (el) {
        if (s.shown !== s.text) {
          el.textContent = s.text
          el.style.color = s.color
          s.shown = s.text
        }
        el.style.opacity = show ? popupAlpha(u).toFixed(3) : '0'
        el.style.transform = `scale(${(1 + 0.12 * (1 - u)).toFixed(3)})`
      }
    }
  }
}

export function FxPopups() {
  const [sys] = useState(() => new PopupSystem())
  useEffect(() => {
    sys.start()
    return () => sys.dispose()
  }, [sys])
  return (
    <>
      {Array.from({ length: MAX_POPUPS }, (_, i) => (
        <group key={i} ref={(g) => sys.attach(i, g, null)} visible={false}>
          <Html center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
            <div className="fx-pop" ref={(el) => sys.attach(i, null, el)} />
          </Html>
        </group>
      ))}
    </>
  )
}
