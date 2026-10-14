// Pure helpers for the agent FX (drones, construction sites, bursts, popups). No three.js here, so the
// lifecycle rules, formatting and formation maths stay unit-testable in node.
import type { AgentInfo, CityLayout } from '@shared/types'

export const LINGER_S = 20          // a construction site stays up this long after its last edit
export const DISMANTLE_S = 3        // then its props sink for this long before it is removed
export const MAX_SITES = 12         // concurrent construction sites; beyond this a building only gets its cage
export const SITE_CONES_MIN = 4
export const SITE_CONES_MAX = 8
export const FENCE_MAX = 12
export const MAX_POPUPS = 12        // live cost/token popups
export const POPUP_LIFE_S = 1.4
export const POPUP_GAP_S = 0.6      // minimum time between popups for one agent
export const POPUP_MIN_COST = 0.001 // USD increase that earns a cost popup
export const POPUP_MIN_TOKENS = 50  // token increase that earns a token popup

export interface V2 { x: number; z: number }
export interface V3 { x: number; y: number; z: number }

export type CommandKind = 'commit' | 'test' | 'other'
export type TestResult = 'pass' | 'fail' | 'unknown'

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1)
  return 1 - u * u * u
}

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** Deterministic value in [0, 1) from a string and a salt. */
export function unitHash(s: string, salt = 0): number {
  let h = (hashStr(s) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Small seeded generator (mulberry32) for effect jitter; returns values in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function wrapAngle(a: number): number {
  const two = Math.PI * 2
  return ((((a + Math.PI) % two) + two) % two) - Math.PI
}

/** Yaw that points a ship's nose (local -Z) along the horizontal velocity. */
export function headingOf(vx: number, vz: number): number {
  return Math.atan2(-vx, -vz)
}

/** Roll target for a yaw rate (rad/s): banks into the turn, capped. */
export function bankTarget(yawRate: number): number {
  return clamp((0 - yawRate) * 0.3, -0.6, 0.6)
}

/** Trail hysteresis: starts when a drone is within 8 units of its target, stays on until it drifts past 25. */
export function trailOn(gap: number, wasOn: boolean): boolean {
  return wasOn ? gap < 25 : gap < 8
}

/**
 * Loose formation around a parent: escort k of n circles the parent at a wobbling radius and height.
 * Writes into out and returns it.
 */
export function formationOffset(k: number, n: number, t: number, phase: number, out: V3): V3 {
  const count = Math.max(1, n)
  const a = (k / count) * Math.PI * 2 + t * 0.22 + phase
  const r = 3.2 + 0.45 * Math.sin(t * 0.4 + phase * 2)
  out.x = Math.cos(a) * r
  out.z = Math.sin(a) * r
  out.y = 1.4 + 0.5 * Math.sin(t * 1.3 + k * 1.7 + phase)
  return out
}

export function formatCost(usd: number): string {
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0
  if (v === 0) return '$0.00'
  return v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`
}

/** New tokens an agent has spent: input plus output plus cache writes. Cache reads are left out (they dominate and are not new work). */
export function tokenTotal(t: AgentInfo['tokens'] | undefined): number {
  if (!t) return 0
  return (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0)
}

export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M tok`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k tok`
  return `${Math.round(v)} tok`
}

const COMMIT_RE = /git commit|git push/i
const TEST_RE = /test|vitest|jest|pytest/i
const FAIL_RE = /\b(fail(ed|ing|ure|s)?|error|not ok)\b|✗|✖/i
const PASS_RE = /\b(pass(ed|es|ing)?|ok|success(ful)?)\b|✓|✔/i

/** Command kind from a command snippet. A test command's result is read from its text when the text says so. */
export function classifyCommand(text: string | undefined): { kind: CommandKind; result: TestResult } {
  const t = text ?? ''
  if (COMMIT_RE.test(t)) return { kind: 'commit', result: 'unknown' }
  if (TEST_RE.test(t)) {
    if (FAIL_RE.test(t)) return { kind: 'test', result: 'fail' }
    if (PASS_RE.test(t)) return { kind: 'test', result: 'pass' }
    return { kind: 'test', result: 'unknown' }
  }
  return { kind: 'other', result: 'unknown' }
}

/** Particles in an edit burst: scales with the lines added, between 10 and 60. */
export function burstCount(lines: number | undefined): number {
  const l = clamp(lines ?? 0, 0, 400)
  return Math.round(Math.min(60, 10 + 2.5 * Math.sqrt(l)))
}

export function popupText(kind: 'cost' | 'tok', delta: number): string {
  return kind === 'cost' ? `+${formatCost(delta)}` : `+${formatTokens(delta)}`
}

// ---------------------------------------------------------------------------------------------
// Construction site lifecycle: active while edits keep coming, dismantled LINGER_S after the last edit.

export type SiteStage = 'active' | 'dismantle' | 'gone'
export interface SiteState { stage: SiteStage; lastEdit: number; dismantleAt: number }

export function newSite(now: number): SiteState {
  return { stage: 'active', lastEdit: now, dismantleAt: 0 }
}

/** An edit on a site that is still standing puts it back to active (a site already gone is replaced, not revived). */
export function touchSite(_s: SiteState, now: number): SiteState {
  return { stage: 'active', lastEdit: now, dismantleAt: 0 }
}

/** Advances the lifecycle to `now`. Returns the same object when nothing changed. */
export function stepSite(s: SiteState, now: number): SiteState {
  let r = s
  if (r.stage === 'active' && now - r.lastEdit >= LINGER_S) {
    r = { stage: 'dismantle', lastEdit: r.lastEdit, dismantleAt: r.lastEdit + LINGER_S }
  }
  if (r.stage === 'dismantle' && now - r.dismantleAt >= DISMANTLE_S) {
    r = { stage: 'gone', lastEdit: r.lastEdit, dismantleAt: r.dismantleAt }
  }
  return r
}

/** 0 while standing, rising to 1 as the props sink into the ground, 1 once gone. */
export function sinkOf(s: SiteState, now: number): number {
  if (s.stage === 'active') return 0
  if (s.stage === 'gone') return 1
  const p = clamp((now - s.dismantleAt) / DISMANTLE_S, 0, 1)
  return p * p
}

export function canAdmitSite(liveCount: number): boolean {
  return liveCount < MAX_SITES
}

/**
 * A point on the rectangle around a footprint (min corner at the origin, size w x d) inset by margin m,
 * at arc length s from its top-left corner. yaw is the tangent direction (atan2(tx, tz)), so a model whose
 * long axis is +Z lines up with the edge. Writes into out.
 */
export function perimeterAt(w: number, d: number, m: number, s: number, out: V2 & { yaw: number }): typeof out {
  const W = w + 2 * m
  const D = d + 2 * m
  const P = 2 * (W + D)
  const u = ((s % P) + P) % P
  if (u < W) {
    out.x = -m + u; out.z = -m; out.yaw = Math.PI / 2
  } else if (u < W + D) {
    const v = u - W
    out.x = w + m; out.z = -m + v; out.yaw = 0
  } else if (u < 2 * W + D) {
    const v = u - W - D
    out.x = w + m - v; out.z = d + m; out.yaw = -Math.PI / 2
  } else {
    const v = u - 2 * W - D
    out.x = -m; out.z = d + m - v; out.yaw = Math.PI
  }
  return out
}

export function perimeterLength(w: number, d: number, m: number): number {
  return 2 * (w + 2 * m + d + 2 * m)
}

// ---------------------------------------------------------------------------------------------
// Popups: a fixed pool, recycling the oldest when full.

export interface PopupSlotLike { active: boolean; age: number }

/** Index of the slot to use next: the first free one, else the oldest live one. */
export function pickPopupSlot(slots: readonly PopupSlotLike[]): number {
  let oldest = 0
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    if (!s) continue
    if (!s.active) return i
    if (s.age > (slots[oldest]?.age ?? -1)) oldest = i
  }
  return oldest
}

// ---------------------------------------------------------------------------------------------
// Layout helpers shared by the FX (no three.js).

/** Centre and half-size of the top-level district holding a file. Null when unknown. */
export function districtBox(layout: CityLayout | null, file: string | undefined): { x: number; z: number; r: number } | null {
  if (!layout || !file) return null
  const top = file.split('/')[0]
  const d = layout.districts.find((x) => x.depth === 1 && x.name === top)
  if (!d) return null
  return { x: d.x + d.w / 2, z: d.z + d.d / 2, r: Math.max(d.w, d.d) / 2 }
}
