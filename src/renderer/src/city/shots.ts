// Director mode: which shot to take next, and where the camera sits for each shot. Pure: plain numbers and small
// objects, no three.js, React or store, so the choices and the geometry are unit-tested. Director.tsx feeds it
// the live scene every frame and applies the views it returns.
import type { AgentStatus, AgentEventType } from '@shared/types'
import type { FramePose, Vec3 } from './framing'

export type ShotKind = 'orbit' | 'follow' | 'crane' | 'reveal' | 'flythrough'

/** A camera pose to render: where it sits, what it looks at, and a field-of-view bump in degrees. */
export interface View {
  pos: Vec3;
  look: Vec3;
  fovBump: number;
}

/** Recent-activity window for district scores and the quiet check. */
export const ACTIVITY_WINDOW_MS = 20_000
/** An agent that edited in the last STREAK_RECENT_MS, and not in the STREAK_LOOKBACK_MS before that, is starting a streak. */
export const STREAK_RECENT_MS = 4_000
export const STREAK_LOOKBACK_MS = 16_000
export const MIN_SHOT_S = 6
export const MAX_SHOT_S = 12
/** A fly-through needs this many active agents (drones) and two of them working far enough apart to cross a city. */
export const FLY_MIN_DRONES = 3
const FLY_MIN_SPAN = 24
/** Shots that must not come back within this many seconds of their last cut. */
export const COOLDOWN_S: Record<ShotKind, number> = { orbit: 0, follow: 8, crane: 14, reveal: 0, flythrough: 25 }

const FOLLOW_BACK = 14
const FOLLOW_UP = 5
/** A fly-through skims the street, but never lower than this, and clears the roofs it passes by FLY_CLEAR. */
const FLY_MIN_Y = 6
const FLY_MAX_Y = 40
const FLY_CLEAR = 3
const FLY_SAMPLES = 16
const FLY_LOOK_DROP = 1.3
const CRANE_START_Y = 3
const MIN_CAMERA_Y = 2.5
const TWO_PI = Math.PI * 2

/** An event as the shot logic reads it. Store events satisfy this. */
export interface EventSample {
  agentId: string;
  type: AgentEventType | string;
  ts: number;
  file?: string;
}

/** A live agent (not idle or done) and where it is working, when that file is a building. */
export interface ActiveAgent {
  id: string;
  status: AgentStatus;
  /** Centre of the building the agent is on. */
  building?: Vec3;
  /** Roof height of that building. */
  top?: number;
}

/** A neighbourhood, as a square on the ground: its centre, half-size, roof height and building count. */
export interface DistrictBox {
  key: string;
  cx: number;
  cz: number;
  half: number;
  top: number;
  count: number;
}

export interface Summary {
  /** Every event in the activity window. */
  total: number;
  /** Events in the window per neighbourhood key. */
  counts: Map<string, number>;
  /** An agent whose edits just started after a quiet stretch, if any. */
  streakAgent: string | null;
}

/** A building's footprint and roof height, for keeping a fly-through clear of the roofs it passes. */
export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  top: number;
}

export interface Scene {
  now: number;
  summary: Summary;
  boxes: DistrictBox[];
  agents: ActiveAgent[];
  footprints?: readonly Footprint[];
}

export interface Memory {
  kind: ShotKind;
  /** Director clock, seconds, at the cut. */
  at: number;
}

interface ShotBase {
  kind: ShotKind;
  /** Seconds the shot lasts before the next cut. */
  dur: number;
  theta0: number;
}
export interface OrbitSpec extends ShotBase {
  kind: 'orbit';
  center: Vec3;
  radius: number;
  phi: number;
  spin: number;
}
export interface FollowSpec extends ShotBase {
  kind: 'follow';
  agentId: string;
  building: Vec3;
}
export interface CraneSpec extends ShotBase {
  kind: 'crane';
  center: Vec3;
  dir: { x: number; z: number };
  drift: number;
  r0: number;
  r1: number;
  phi0: number;
  phi1: number;
}
export interface RevealSpec extends ShotBase {
  kind: 'reveal';
}
export interface FlySpec extends ShotBase {
  kind: 'flythrough';
  from: Vec3;
  to: Vec3;
  /** Height of the camera along the pass: clear of the roofs it passes, bounded below by FLY_MIN_Y. */
  y: number;
}
export type ShotSpec = OrbitSpec | FollowSpec | CraneSpec | RevealSpec | FlySpec

/** Live inputs of a frame: the drone a follow shot tracks, its chase direction, and the framed city pose. */
export interface LiveInputs {
  drone?: Vec3;
  /** Unit direction on the ground from the building towards the chase camera. */
  back: { x: number; z: number };
  frame: FramePose;
}

export function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t))
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const degToRad = (d: number): number => (d * Math.PI) / 180

/** Small deterministic PRNG (mulberry32): a function returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Point at distance r from c on a sphere: the same convention as three's Spherical (y up). */
export function sphere(c: Vec3, r: number, phi: number, theta: number): Vec3 {
  const sp = Math.sin(phi)
  return { x: c.x + r * sp * Math.sin(theta), y: c.y + r * Math.cos(phi), z: c.z + r * sp * Math.cos(theta) }
}

function view(pos: Vec3, look: Vec3, fovBump: number): View {
  return { pos: { x: pos.x, y: Math.max(MIN_CAMERA_Y, pos.y), z: pos.z }, look: { ...look }, fovBump }
}

/**
 * Neighbourhood squares from the buildings: centre, half-size (of the bounding square), tallest roof and count.
 * Sorted by building count, largest first, ties by key. `keyOf` gives a building's neighbourhood key.
 */
export function districtBoxes(
  items: readonly { path: string; x: number; z: number; w: number; d: number; top: number }[],
  keyOf: (path: string) => string | undefined
): DistrictBox[] {
  const groups = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; top: number; count: number }>()
  for (const b of items) {
    const key = keyOf(b.path)
    if (key === undefined) continue
    const g = groups.get(key)
    const x0 = b.x
    const x1 = b.x + b.w
    const z0 = b.z
    const z1 = b.z + b.d
    if (!g) {
      groups.set(key, { minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: b.top, count: 1 })
    } else {
      g.minX = Math.min(g.minX, x0)
      g.maxX = Math.max(g.maxX, x1)
      g.minZ = Math.min(g.minZ, z0)
      g.maxZ = Math.max(g.maxZ, z1)
      g.top = Math.max(g.top, b.top)
      g.count++
    }
  }
  const out: DistrictBox[] = []
  for (const [key, g] of groups) {
    out.push({
      key,
      cx: (g.minX + g.maxX) / 2,
      cz: (g.minZ + g.maxZ) / 2,
      half: Math.max(6, (Math.max(g.maxX - g.minX, g.maxZ - g.minZ)) / 2),
      top: g.top,
      count: g.count
    })
  }
  return out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Counts the events of the last ACTIVITY_WINDOW_MS per neighbourhood, and finds an agent starting an edit streak.
 * `events` are in ascending ts order (the store keeps them so); the scan stops at the window's edge.
 */
export function summarize(events: readonly EventSample[], now: number, districtOf: (file: string) => string | undefined): Summary {
  const counts = new Map<string, number>()
  const recent = new Map<string, number>()
  const older = new Map<string, number>()
  let total = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e) continue
    if (e.ts < now - ACTIVITY_WINDOW_MS) break
    total++
    if (e.file) {
      const key = districtOf(e.file)
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (e.type === 'edit' && e.ts >= now - STREAK_LOOKBACK_MS) {
      const m = e.ts >= now - STREAK_RECENT_MS ? recent : older
      m.set(e.agentId, (m.get(e.agentId) ?? 0) + 1)
    }
  }
  let streakAgent: string | null = null
  let best = 0
  for (const [id, n] of recent) {
    if (older.has(id)) continue
    if (n > best || (n === best && streakAgent !== null && id < streakAgent)) {
      best = n
      streakAgent = id
    }
  }
  return { total, counts, streakAgent }
}

/** Agents that are editing a file with a known building. */
export function editTargets(agents: readonly ActiveAgent[]): ActiveAgent[] {
  return agents.filter((a) => a.status === 'editing' && a.building !== undefined)
}

/**
 * Height for a pass from a to b (ground coordinates): just above the tallest roof the straight line crosses or grazes,
 * never below FLY_MIN_Y and never above FLY_MAX_Y (a pass through a very tall block is taken at the ceiling).
 */
export function flyHeight(a: Vec3, b: Vec3, footprints: readonly Footprint[]): number {
  let roof = 0
  for (let i = 0; i <= FLY_SAMPLES; i++) {
    const u = i / FLY_SAMPLES
    const px = lerp(a.x, b.x, u)
    const pz = lerp(a.z, b.z, u)
    for (const f of footprints) {
      if (f.top <= roof) continue
      const m = 1.5
      if (px >= f.x - m && px <= f.x + f.w + m && pz >= f.z - m && pz <= f.z + f.d + m) roof = f.top
    }
  }
  return Math.min(FLY_MAX_Y, Math.max(FLY_MIN_Y, roof + FLY_CLEAR))
}

/** The two active agents' buildings that are farthest apart (on the ground), if there are enough drones and they are far apart. */
export function flyPair(agents: readonly ActiveAgent[]): [Vec3, Vec3] | null {
  if (agents.length < FLY_MIN_DRONES) return null
  const pts: Vec3[] = []
  for (const a of agents) if (a.building) pts.push(a.building)
  let best: [Vec3, Vec3] | null = null
  let bestD = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]
      const b = pts[j]
      if (!a || !b) continue
      const d = Math.hypot(a.x - b.x, a.z - b.z)
      if (d > bestD) {
        bestD = d
        best = [a, b]
      }
    }
  }
  return bestD >= FLY_MIN_SPAN ? best : null
}

/** The shots this scene can take. Reveal always; the others need the matching activity or agents. */
export function eligibleKinds(scene: Scene): ShotKind[] {
  const out: ShotKind[] = ['reveal']
  const hasBoxes = scene.boxes.length > 0
  if (hasBoxes) out.push('orbit')
  if (hasBoxes && scene.agents.length > 0) out.push('crane')
  if (editTargets(scene.agents).length > 0) out.push('follow')
  if (flyPair(scene.agents)) out.push('flythrough')
  return out
}

/** Relative chance of each shot. Quiet scenes lean on the reveal; a new edit streak pulls towards follow. */
function weight(k: ShotKind, scene: Scene, quiet: boolean, streakHit: boolean): number {
  if (quiet) return k === 'reveal' ? 8 : k === 'orbit' ? 1 : k === 'crane' ? 0.5 : 0
  switch (k) {
    case 'reveal':
      return 1
    case 'orbit':
      return 3
    case 'crane':
      return 2
    case 'follow':
      return streakHit ? 12 : 3
    case 'flythrough':
      return 3
  }
}

function weightedPick(items: readonly { k: ShotKind; w: number }[], rand: () => number): ShotKind {
  const total = items.reduce((s, x) => s + x.w, 0)
  let r = rand() * total
  for (const it of items) {
    r -= it.w
    if (r < 0) return it.k
  }
  return items[items.length - 1]?.k ?? 'reveal'
}

/**
 * The next shot. Never the one just shown, never one still cooling down; falls back to whatever is left so a cut
 * always happens. `clock` is the director clock in seconds, the same units as Memory.at.
 */
export function chooseKind(scene: Scene, history: readonly Memory[], clock: number, rand: () => number): ShotKind {
  const eligible = eligibleKinds(scene)
  const last = history[history.length - 1]?.kind
  const quiet = scene.summary.total === 0
  const streakHit = scene.summary.streakAgent !== null
    && editTargets(scene.agents).some((a) => a.id === scene.summary.streakAgent)
  const cooling = new Set(history.filter((m) => clock - m.at < COOLDOWN_S[m.kind]).map((m) => m.kind))
  const weighted = eligible.map((k) => ({ k, w: weight(k, scene, quiet, streakHit) })).filter((x) => x.w > 0)
  let pool = weighted.filter((x) => x.k !== last && !cooling.has(x.k))
  if (pool.length === 0) pool = weighted.filter((x) => x.k !== last)
  if (pool.length === 0) pool = weighted
  if (pool.length === 0) return 'reveal'
  return weightedPick(pool, rand)
}

/** The neighbourhood with the most events in the window; with no events, the one with the most buildings. */
export function busiestBox(scene: Scene): DistrictBox | undefined {
  let best: DistrictBox | undefined
  let bestCount = -1
  for (const b of scene.boxes) {
    const c = scene.summary.counts.get(b.key) ?? 0
    if (c > bestCount) {
      best = b
      bestCount = c
    }
  }
  return best
}

const EMPTY_BOX: DistrictBox = { key: '', cx: 0, cz: 0, half: 20, top: 10, count: 0 }

/**
 * Shot parameters, chosen once at the cut. Dynamic parts (drone position, framed pose) are read in shotView.
 * Kinds without their inputs fall back to reveal, which needs none.
 */
export function planShot(kind: ShotKind, scene: Scene, rand: () => number): ShotSpec {
  const dur = MIN_SHOT_S + rand() * (MAX_SHOT_S - MIN_SHOT_S)
  const theta0 = rand() * TWO_PI
  const reveal: RevealSpec = { kind: 'reveal', dur, theta0 }
  switch (kind) {
    case 'orbit': {
      const box = busiestBox(scene)
      if (!box) return reveal
      return {
        kind: 'orbit',
        dur,
        theta0,
        center: { x: box.cx, y: box.top * 0.35, z: box.cz },
        radius: Math.min(120, Math.max(34, box.half * 2.2 + 30)),
        phi: degToRad(90 - (35 + rand() * 10)),
        spin: (rand() < 0.5 ? -1 : 1) * 0.12
      }
    }
    case 'follow': {
      const targets = editTargets(scene.agents)
      const streak = targets.find((a) => a.id === scene.summary.streakAgent)
      const pick = streak ?? targets[Math.floor(rand() * targets.length)]
      if (!pick?.building) return reveal
      return { kind: 'follow', dur, theta0, agentId: pick.id, building: pick.building }
    }
    case 'crane': {
      if (scene.boxes.length === 0) return reveal
      // Among the three most active neighbourhoods, so the rise lands on the busy part of the city.
      const ranked = [...scene.boxes].sort((a, b) => (scene.summary.counts.get(b.key) ?? 0) - (scene.summary.counts.get(a.key) ?? 0))
      const top = ranked.slice(0, 3)
      const box = top[Math.floor(rand() * top.length)] ?? EMPTY_BOX
      const a = rand() * TWO_PI
      return {
        kind: 'crane',
        dur,
        theta0,
        center: { x: box.cx, y: CRANE_START_Y, z: box.cz },
        dir: { x: Math.cos(a), z: Math.sin(a) },
        drift: box.half * 0.6,
        r0: 24,
        r1: Math.min(110, Math.max(50, box.half * 2.2 + 40)),
        phi0: degToRad(78),
        phi1: degToRad(48)
      }
    }
    case 'flythrough': {
      const pair = flyPair(scene.agents)
      if (!pair) return reveal
      const [a, b] = rand() < 0.5 ? pair : [pair[1], pair[0]]
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
      const ux = (b.x - a.x) / len
      const uz = (b.z - a.z) / len
      // Start and end just outside the two buildings, so the camera does not open inside one.
      const from = { x: a.x + ux * 4, y: 0, z: a.z + uz * 4 }
      const to = { x: b.x - ux * 4, y: 0, z: b.z - uz * 4 }
      return { kind: 'flythrough', dur, theta0, from, to, y: flyHeight(from, to, scene.footprints ?? []) }
    }
    case 'reveal':
      return reveal
  }
  return reveal
}

/**
 * Where the camera is at `t` seconds into a shot. Null when the shot can no longer be shown (its drone is gone),
 * so the caller cuts to another shot.
 */
export function shotView(spec: ShotSpec, t: number, live: LiveInputs): View | null {
  const u = clamp01(t / spec.dur)
  switch (spec.kind) {
    case 'orbit':
      return view(sphere(spec.center, spec.radius, spec.phi, spec.theta0 + spec.spin * t), spec.center, 0)
    case 'follow': {
      const d = live.drone
      if (!d) return null
      // Chase: behind the drone as seen from its building, a little above, with a slow sway, looking at the building.
      const sway = 0.25 * Math.sin(0.25 * t + spec.theta0)
      const bx = live.back.x
      const bz = live.back.z
      const cs = Math.cos(sway)
      const sn = Math.sin(sway)
      const pos = { x: d.x + (bx * cs - bz * sn) * FOLLOW_BACK, y: d.y + FOLLOW_UP, z: d.z + (bx * sn + bz * cs) * FOLLOW_BACK }
      return view(pos, spec.building, 0)
    }
    case 'crane': {
      const p = easeInOut(u)
      const dd = lerp(-spec.drift, spec.drift, p)
      const look = { x: spec.center.x + spec.dir.x * dd, y: lerp(CRANE_START_Y, CRANE_START_Y + 4, p), z: spec.center.z + spec.dir.z * dd }
      const r = lerp(spec.r0, spec.r1, p)
      const phi = lerp(spec.phi0, spec.phi1, p)
      return view(sphere(look, r, phi, spec.theta0 + 0.35 * p), look, 0)
    }
    case 'reveal': {
      const f = live.frame
      const r = f.radius * (1 + 0.03 * u)
      const target = { x: f.target.x, y: f.target.y, z: f.target.z }
      return view(sphere(target, r, f.phi, f.theta + 0.05 * u), target, 0)
    }
    case 'flythrough': {
      // Fastest mid-shot. The look point runs ahead of the camera along the street.
      const s = 0.5 - 0.5 * Math.cos(Math.PI * u)
      const ahead = Math.min(1, s + 0.12)
      const pos = { x: lerp(spec.from.x, spec.to.x, s), y: spec.y, z: lerp(spec.from.z, spec.to.z, s) }
      const look = { x: lerp(spec.from.x, spec.to.x, ahead), y: spec.y - FLY_LOOK_DROP, z: lerp(spec.from.z, spec.to.z, ahead) }
      return view(pos, look, 9 * Math.sin(Math.PI * u))
    }
  }
  return null
}

/** Linear blend of two views (position, look and fov bump). Returns a new view. */
export function lerpView(a: View, b: View, e: number): View {
  return {
    pos: { x: lerp(a.pos.x, b.pos.x, e), y: lerp(a.pos.y, b.pos.y, e), z: lerp(a.pos.z, b.pos.z, e) },
    look: { x: lerp(a.look.x, b.look.x, e), y: lerp(a.look.y, b.look.y, e), z: lerp(a.look.z, b.look.z, e) },
    fovBump: lerp(a.fovBump, b.fovBump, e)
  }
}
