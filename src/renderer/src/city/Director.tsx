// Director mode runtime: when to cut to the next shot and where the camera is each frame. CameraRig calls update()
// once per frame and applies the view it gets back; null means the orbit controls own the camera. The choice of
// shot and the geometry live in shots.ts. Test hook: window.__skylineDirectorStep(dt) advances the director clock.
import type { CityLayout } from '@shared/types'
import type { NeighborhoodIndex } from '@shared/layout'
import { useSky } from '../state/store'
import { visCenter, visHeight } from './geom'
import { getDroneVec } from './registry'
import { requestGrab } from './capture'
import { FS_AGENT } from './data'
import type { FramePose, Vec3 } from './framing'
import {
  chooseKind,
  clamp01,
  districtBoxes,
  lerpView,
  mulberry32,
  planShot,
  shotView,
  summarize,
  type ActiveAgent,
  type DistrictBox,
  type Memory,
  type Scene,
  type ShotKind,
  type ShotSpec,
  type View
} from './shots'

/** Quiet time the user must leave before the director takes over. */
export const IDLE_S = 3
/** After any interaction with the camera the director stays out of the way this long. */
export const PAUSE_S = 8
/** Length of the eased hand-over between two shots. */
export const BLEND_S = 1.2
/** The clock advances in steps of this size, so a long step still cuts shots in order. */
const CHUNK_S = 0.25
/** A real frame longer than this (a hidden tab, a stalled renderer) counts as this long. */
const MAX_FRAME_S = 1
const HISTORY_MAX = 8

/** What CameraRig passes each frame. `current` is the camera as it is now, the start of any hand-over. */
export interface DirectorFrame {
  dt: number;
  on: boolean;
  reduced: boolean;
  /** False while another move (a fly-to) owns the camera. */
  allowed: boolean;
  current: View;
  frame: FramePose;
}

interface Shot {
  spec: ShotSpec;
  start: number;
  end: number;
  from: View;
}

interface Geo {
  layout: CityLayout;
  hoods: NeighborhoodIndex;
  boxes: DistrictBox[];
  spots: Map<string, { c: Vec3; top: number }>;
}

let geo: Geo | null = null

/** Neighbourhood squares and building centres of the current layout. Cached until the layout or its index changes. */
function geometryFor(layout: CityLayout, hoods: NeighborhoodIndex): Geo {
  if (geo && geo.layout === layout && geo.hoods === hoods) return geo
  const spots = new Map<string, { c: Vec3; top: number }>()
  const items: { path: string; x: number; z: number; w: number; d: number; top: number }[] = []
  for (const b of layout.buildings) {
    const top = visHeight(b, layout)
    spots.set(b.path, { c: visCenter(b, layout), top })
    items.push({ path: b.path, x: b.x, z: b.z, w: b.w, d: b.d, top })
  }
  geo = { layout, hoods, boxes: districtBoxes(items, (p) => hoods.keyOf.get(p)), spots }
  return geo
}

/** The scene the planner reads, or null when there is nothing to direct (no repo, a capture, a replay or time-lapse). */
function buildScene(now: number): Scene | null {
  const s = useSky.getState()
  if (s.capture !== null || s.mode !== 'live' || !s.repo || !s.layout || !s.hoods) return null
  const g = geometryFor(s.layout, s.hoods)
  const keyOf = s.hoods.keyOf
  const summary = summarize(s.events, now, (f) => keyOf.get(f))
  const agents: ActiveAgent[] = []
  for (const a of s.agents) {
    if (a.id === FS_AGENT || a.status === 'idle' || a.status === 'done') continue
    const spot = a.currentFile ? g.spots.get(a.currentFile) : undefined
    agents.push({ id: a.id, status: a.status, building: spot?.c, top: spot?.top })
  }
  return { now, summary, boxes: g.boxes, agents }
}

function cloneView(v: View): View {
  return { pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, look: { x: v.look.x, y: v.look.y, z: v.look.z }, fovBump: v.fovBump }
}

/** Handheld wobble: a small translation of the whole view (position and look together), scaled to the distance. */
function shake(v: View, c: number): View {
  const dist = Math.hypot(v.look.x - v.pos.x, v.look.y - v.pos.y, v.look.z - v.pos.z)
  const a = Math.min(0.35, 0.002 * dist)
  const ox = a * (Math.sin(1.7 * c) + 0.5 * Math.sin(3.3 * c + 2))
  const oy = a * 0.6 * Math.sin(2.3 * c + 1)
  const oz = a * (Math.cos(1.9 * c) + 0.5 * Math.sin(2.9 * c + 0.4))
  return {
    pos: { x: v.pos.x + ox, y: v.pos.y + oy, z: v.pos.z + oz },
    look: { x: v.look.x + ox, y: v.look.y + oy, z: v.look.z + oz },
    fovBump: v.fovBump
  }
}

function unitXZ(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z)
  return l < 1e-6 ? { x: 0, z: 1 } : { x: x / l, z: z / l }
}

/** Smoothstep: eased from 0 to 1. */
const smooth = (u: number): number => u * u * (3 - 2 * u)

export class Director {
  private clock = 0
  private queued = 0
  private lastInput = -Infinity
  private pausedUntil = -Infinity
  private shot: Shot | null = null
  private history: Memory[] = []
  /** Follow shots: the ground direction from the building to the camera, eased as the drone moves. */
  private back = { x: 0, z: 1 }
  private readonly rand = mulberry32(Date.now() >>> 0 || 1)

  /** The user touched the camera controls: the director steps aside for PAUSE_S. */
  noteInput(): void {
    this.lastInput = this.clock
    this.pausedUntil = this.clock + PAUSE_S
  }

  /** Another move (a selection, a fly-to, a frame) took the camera: the director steps aside for PAUSE_S. */
  pause(): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock + PAUSE_S)
  }

  /** Test hook: queues `dt` seconds of director time, applied on the next update. */
  step(dt: number): void {
    this.queued += Math.max(0, dt)
  }

  /**
   * Advances the director by the frame time (plus any queued steps) and returns the view to render, or null when the
   * orbit controls should own the camera (director off, user hands on, nothing to show).
   */
  update(f: DirectorFrame): View | null {
    const scene = f.on && !f.reduced && f.allowed ? buildScene(Date.now()) : null
    const ready = (): boolean => scene !== null && this.clock - this.lastInput >= IDLE_S && this.clock >= this.pausedUntil
    let remaining = Math.min(Math.max(0, f.dt), MAX_FRAME_S) + this.queued
    this.queued = 0
    while (remaining > 1e-9) {
      const c = Math.min(CHUNK_S, remaining)
      remaining -= c
      this.clock += c
      if (!scene || !ready()) {
        this.shot = null
        continue
      }
      if (!this.shot || this.clock >= this.shot.end) this.cut(scene, f.current)
    }
    if (!scene || !ready()) {
      this.shot = null
      return null
    }
    if (!this.shot) this.cut(scene, f.current)
    return this.evaluate(f, scene)
  }

  private cut(scene: Scene, from: View, forced?: ShotKind): void {
    const kind = forced ?? chooseKind(scene, this.history, this.clock, this.rand)
    const spec = planShot(kind, scene, this.rand)
    this.history.push({ kind: spec.kind, at: this.clock })
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX)
    if (spec.kind === 'follow') {
      const d = getDroneVec(spec.agentId)
      this.back = d ? unitXZ(d.x - spec.building.x, d.z - spec.building.z) : { x: 0, z: 1 }
    }
    this.shot = { spec, start: this.clock, end: this.clock + spec.dur, from: cloneView(from) }
  }

  private evaluate(f: DirectorFrame, scene: Scene): View | null {
    let shot = this.shot
    if (!shot) return null
    const drone = shot.spec.kind === 'follow' ? getDroneVec(shot.spec.agentId) : undefined
    if (shot.spec.kind === 'follow' && drone) this.steerBack(drone, shot.spec.building)
    let v = shotView(shot.spec, this.clock - shot.start, { drone, back: this.back, frame: f.frame })
    if (!v) {
      // The shot cannot be shown any more (its drone is gone): cut to the reveal from here.
      this.cut(scene, f.current, 'reveal')
      shot = this.shot
      v = shot ? shotView(shot.spec, 0, { back: this.back, frame: f.frame }) : null
      if (!shot || !v) return null
    }
    const u = clamp01((this.clock - shot.start) / BLEND_S)
    let out = u >= 1 ? v : lerpView(shot.from, v, smooth(u))
    const c = this.clock
    out = { pos: out.pos, look: out.look, fovBump: out.fovBump + 0.8 * Math.sin(0.31 * c) + 0.35 * Math.sin(0.9 * c + 1.3) }
    if (!f.reduced) out = shake(out, c)
    return out
  }

  /** Eases the chase direction towards the drone's side of its building. */
  private steerBack(d: Vec3, b: Vec3): void {
    const dx = d.x - b.x
    const dz = d.z - b.z
    if (Math.hypot(dx, dz) < 1) return
    const u = unitXZ(dx, dz)
    this.back = unitXZ(this.back.x * 0.94 + u.x * 0.06, this.back.z * 0.94 + u.z * 0.06)
  }

  /** For the debug hook and tests: where the director is. */
  debug(): { clock: number; kind: ShotKind | null; lastInput: number; pausedUntil: number; history: ShotKind[] } {
    return {
      clock: this.clock,
      kind: this.shot?.spec.kind ?? null,
      lastInput: this.lastInput,
      pausedUntil: this.pausedUntil,
      history: this.history.map((m) => m.kind)
    }
  }
}

/** The one director the city runs. CameraRig drives it. */
export const director = new Director()

declare global {
  interface Window {
    __skylineDirectorStep?: (dt: number) => void;
    __skylineDirector?: () => unknown;
    __skylineDirectorGrab?: () => Promise<HTMLCanvasElement>;
  }
}

if (typeof window !== 'undefined') {
  window.__skylineDirectorStep = (dt: number) => director.step(dt)
  window.__skylineDirector = () => director.debug()
  // Test hook: a copy of the city canvas taken inside the next frame, whatever the camera is doing (no capture state).
  window.__skylineDirectorGrab = () => requestGrab(window.devicePixelRatio || 1)
}
