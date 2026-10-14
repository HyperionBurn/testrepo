// FX plumbing: a registry of systems stepped together (so window.__skylineFxStep can fast-forward them
// deterministically), a small event bus, and the relay that turns fresh store events into FX events.
import type { Camera } from 'three'
import type { CityLayout } from '@shared/types'
import { useSky } from '../../state/store'
import { agentHex } from '../data'
import { classifyCommand, type CommandKind, type TestResult } from './model'

export interface FxCtx {
  /** FX clock in seconds: advances with every step, including fast-forwarded ones. */
  time: number
  dt: number
  camera: Camera | null
  /** Drawing buffer height in device pixels (for world-size points). */
  pxHeight: number
  layout: CityLayout | null
  reduced: boolean
}

export interface FxSystem {
  update(dt: number, ctx: FxCtx): void
}

export const fxCtx: FxCtx = { time: 0, dt: 0, camera: null, pxHeight: 800, layout: null, reduced: false }

const systems = new Set<FxSystem>()
const counters = new Map<string, () => number>()

/** Registers a live count for the diagnostics hook (window.__skylineFxStats). */
export function registerCounter(name: string, read: () => number): () => void {
  counters.set(name, read)
  return () => {
    if (counters.get(name) === read) counters.delete(name)
  }
}

/** Live counts of every FX pool, for tests and screenshots. */
export function fxStats(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, read] of counters) out[k] = read()
  return out
}

/** Registers a system to be stepped every frame. Returns the unregister function. */
export function registerFx(s: FxSystem): () => void {
  systems.add(s)
  return () => {
    systems.delete(s)
  }
}

/** Advances the FX clock and every registered system by dt. Frame-rate independent: callers pass fixed steps to fast-forward. */
export function stepFx(dt: number, camera: Camera | null, pxHeight: number): void {
  const st = useSky.getState()
  fxCtx.time += dt
  fxCtx.dt = dt
  if (camera) fxCtx.camera = camera
  fxCtx.pxHeight = pxHeight
  fxCtx.layout = st.layout
  fxCtx.reduced = st.reducedMotion
  for (const s of systems) s.update(dt, fxCtx)
}

export type FxEvent =
  | { type: 'touch'; agentId: string; file: string; kind: 'edit' | 'create'; lines: number; color: string; agent: boolean }
  | { type: 'command'; agentId: string; kind: CommandKind; result: TestResult; file?: string; color: string }
  | { type: 'popup'; agentId: string; text: string; color: string; x: number; y: number; z: number }

const listeners = new Set<(e: FxEvent) => void>()

export function onFx(l: (e: FxEvent) => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function emitFx(e: FxEvent): void {
  for (const l of listeners) l(e)
}

/** Events older than this at relay start are history, not activity, and get no FX. */
const FRESH_MS = 1500
const SEEN_CAP = 20000
const seen = new Set<string>()
let cutoff = 0

/** Starts relaying fresh live events from the store into the FX bus. Returns the stop function. */
export function startRelay(): () => void {
  cutoff = Date.now() - FRESH_MS
  seen.clear()
  const unsub = useSky.subscribe((s, prev) => {
    if (s.events !== prev.events) relay(s)
  })
  return () => {
    unsub()
    seen.clear()
  }
}

function relay(s: ReturnType<typeof useSky.getState>): void {
  if (s.mode !== 'live' || s.reducedMotion) return
  if (seen.size > SEEN_CAP) seen.clear()
  // Events are ascending by ts, so new ones sit at the tail. Walk back only through the recent window.
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i]
    if (!e) continue
    if (e.ts < cutoff) break
    if (seen.has(e.id)) continue
    seen.add(e.id)
    if (e.type === 'edit' || e.type === 'create') {
      if (!e.file) continue
      const lines = (e.linesAdded ?? 0) + (e.linesRemoved ?? 0)
      emitFx({
        type: 'touch',
        agentId: e.agentId,
        file: e.file,
        kind: e.type,
        lines,
        color: agentHex(e.agentId, s.agents),
        agent: e.agentId !== 'fs'
      })
    } else if (e.type === 'command') {
      const c = classifyCommand(e.text)
      if (c.kind === 'other') continue
      const agent = s.agents.find((a) => a.id === e.agentId)
      emitFx({
        type: 'command',
        agentId: e.agentId,
        kind: c.kind,
        result: c.result,
        file: agent?.currentFile,
        color: agentHex(e.agentId, s.agents)
      })
    }
  }
}
