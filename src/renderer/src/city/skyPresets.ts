// Time-of-day presets for the sky, the haze and the scene light. Pure data and maths (no three.js), so the
// interpolation can be tested. Sky.tsx turns a blended result into shared shader uniforms every frame.
import { DAWN_LILAC, DAWN_PEACH, FOG_BLUE, FOG_DAWN, FOG_NIGHT, HAZE_WARM, HORIZON, HORIZON_PINK, MID_BLUE, NIGHT_BROWN, NIGHT_GLOW, NIGHT_ZENITH, TEAL_DUSK, ZENITH } from './palette'

export const TIMES_OF_DAY = ['blue', 'night', 'dawn'] as const
export type TimeOfDay = (typeof TIMES_OF_DAY)[number]
export const DEFAULT_TIME_OF_DAY: TimeOfDay = 'blue'

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  blue: 'Blue hour',
  night: 'Night',
  dawn: 'Dawn'
}

/** Colours a preset sets. Each one becomes a shared Color uniform (see Sky.tsx). */
export const COLOR_KEYS = [
  'zenith', 'mid', 'teal', 'horizon', 'bandA', 'bandB', 'below', 'wisp', 'fog', 'haze',
  'cloudLow', 'cloudHigh', 'hemiSky', 'hemiGround', 'key'
] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

/** Scalars a preset sets: how strong each layer is. */
export const LEVEL_KEYS = ['star', 'moon', 'band', 'wisps', 'sheets', 'hazeAmt', 'scatter', 'hemi', 'keyI'] as const
export type LevelKey = (typeof LEVEL_KEYS)[number]

export interface SkyPreset {
  colors: Record<ColorKey, string>
  levels: Record<LevelKey, number>
}

/** A preset with its colours converted to sRGB 0..1 triples, ready to blend. */
export interface ResolvedPreset {
  colors: Record<ColorKey, [number, number, number]>
  levels: Record<LevelKey, number>
}

export const PRESETS: Record<TimeOfDay, SkyPreset> = {
  // Blue hour, after the NYC dusk reference: deep navy zenith, teal mid-sky, orange to pink horizon band.
  blue: {
    colors: {
      zenith: ZENITH,
      mid: MID_BLUE,
      teal: TEAL_DUSK,
      horizon: HORIZON,
      bandA: HORIZON,
      bandB: HORIZON_PINK,
      below: '#1a1d2c',
      wisp: '#f6b58a',
      fog: FOG_BLUE,
      haze: HAZE_WARM,
      cloudLow: '#ff9a6a',
      cloudHigh: '#c46f9a',
      hemiSky: '#5b7cff',
      hemiGround: '#1a1412',
      key: '#cfe0ff'
    },
    levels: { star: 0.3, moon: 0.55, band: 1, wisps: 0.8, sheets: 0.7, hazeAmt: 0.7, scatter: 0.5, hemi: 0.5, keyI: 0.9 }
  },
  // Night, after the Empire State reference: near-black zenith, warm brown-orange light pollution at the horizon.
  night: {
    colors: {
      zenith: NIGHT_ZENITH,
      mid: '#0a0a0f',
      teal: '#1c1a1c',
      horizon: NIGHT_GLOW,
      bandA: '#ffb050',
      bandB: '#e0803a',
      below: '#0a0806',
      wisp: '#8a5a34',
      fog: NIGHT_BROWN,
      haze: HAZE_WARM,
      cloudLow: '#7a4a2a',
      cloudHigh: '#3a2a22',
      hemiSky: '#3a2a22',
      hemiGround: '#100c08',
      key: '#ffd9a8'
    },
    levels: { star: 0.12, moon: 0.2, band: 1.9, wisps: 0.4, sheets: 0.5, hazeAmt: 1, scatter: 0.9, hemi: 0.35, keyI: 0.45 }
  },
  // Dawn: cool lilac overhead, peach at the horizon.
  dawn: {
    colors: {
      zenith: DAWN_LILAC,
      mid: '#8a86c0',
      teal: '#c8a4c8',
      horizon: DAWN_PEACH,
      bandA: '#ffb98a',
      bandB: '#f0a0b0',
      below: '#7a5a6a',
      wisp: '#ffd2b0',
      fog: FOG_DAWN,
      haze: '#ffb070',
      cloudLow: '#ffb08a',
      cloudHigh: '#b08ab8',
      hemiSky: '#8f9cd8',
      hemiGround: '#3a2a30',
      key: '#ffd7b8'
    },
    levels: { star: 0.1, moon: 0.35, band: 0.9, wisps: 0.9, sheets: 0.8, hazeAmt: 0.8, scatter: 0.7, hemi: 0.55, keyI: 1 }
  }
}

export function isTimeOfDay(v: unknown): v is TimeOfDay {
  return typeof v === 'string' && (TIMES_OF_DAY as readonly string[]).includes(v)
}

/** The next preset in the cycle blue, night, dawn, blue (the T key). */
export function nextTimeOfDay(t: TimeOfDay): TimeOfDay {
  const i = TIMES_OF_DAY.indexOf(t)
  return TIMES_OF_DAY[(i + 1) % TIMES_OF_DAY.length] ?? DEFAULT_TIME_OF_DAY
}

/** Parses #rrggbb into sRGB 0..1 (mirrors palette.hexToRgb, kept local so this module stays a leaf). */
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function resolvePreset(p: SkyPreset): ResolvedPreset {
  const colors = {} as Record<ColorKey, [number, number, number]>
  for (const k of COLOR_KEYS) colors[k] = hexRgb(p.colors[k])
  return { colors, levels: { ...p.levels } }
}

/** A blank resolved preset to blend into (one allocation, reused every frame). */
export function emptyResolved(): ResolvedPreset {
  const colors = {} as Record<ColorKey, [number, number, number]>
  for (const k of COLOR_KEYS) colors[k] = [0, 0, 0]
  const levels = {} as Record<LevelKey, number>
  for (const k of LEVEL_KEYS) levels[k] = 0
  return { colors, levels }
}

/** Smooth ease in and out, t clamped to 0..1. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Writes the blend of a and b at t (0 = a, 1 = b) into out. Colours mix per channel; levels mix linearly. */
export function blendInto(out: ResolvedPreset, a: ResolvedPreset, b: ResolvedPreset, t: number): ResolvedPreset {
  const k = Math.min(1, Math.max(0, t))
  for (const key of COLOR_KEYS) {
    const ca = a.colors[key]
    const cb = b.colors[key]
    const o = out.colors[key]
    o[0] = ca[0] + (cb[0] - ca[0]) * k
    o[1] = ca[1] + (cb[1] - ca[1]) * k
    o[2] = ca[2] + (cb[2] - ca[2]) * k
  }
  for (const key of LEVEL_KEYS) out.levels[key] = a.levels[key] + (b.levels[key] - a.levels[key]) * k
  return out
}

/**
 * A transition between two presets. Sky.tsx advances it each frame with the frame delta and reads `current`.
 * With duration 0 (reduced motion) the change lands on the next frame.
 */
export class PresetTransition {
  readonly current: ResolvedPreset = emptyResolved()
  private from: ResolvedPreset = emptyResolved()
  private to: ResolvedPreset = emptyResolved()
  private elapsed = 0
  private duration = 0
  target: TimeOfDay

  constructor(initial: TimeOfDay, readonly seconds = 2) {
    this.target = initial
    const r = resolvePreset(PRESETS[initial])
    this.snap(r)
  }

  private snap(r: ResolvedPreset): void {
    blendInto(this.current, r, r, 0)
    this.from = r
    this.to = r
    this.elapsed = 0
    this.duration = 0
  }

  /** Starts a change to `next`, from wherever the sky is right now. */
  setTarget(next: TimeOfDay, animate: boolean): void {
    if (next === this.target) return
    this.target = next
    const from = emptyResolved()
    blendInto(from, this.current, this.current, 0)
    this.from = from
    this.to = resolvePreset(PRESETS[next])
    this.elapsed = 0
    this.duration = animate ? this.seconds : 0
  }

  /** Advances by dt seconds and refreshes `current`. Returns true while the sky is still moving. */
  step(dt: number): boolean {
    if (this.duration === 0) {
      // No animation (reduced motion): a pending change lands in this frame.
      if (this.from === this.to) return false
      blendInto(this.current, this.to, this.to, 0)
      this.from = this.to
      return true
    }
    this.elapsed = Math.min(this.duration, this.elapsed + Math.min(dt, 0.1))
    blendInto(this.current, this.from, this.to, easeInOut(this.elapsed / this.duration))
    if (this.elapsed >= this.duration) {
      this.duration = 0
      this.from = this.to
      return false
    }
    return true
  }
}
