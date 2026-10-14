// Grade parameters for the post-processing chain (Grade.tsx, Effects.tsx). Pure: presets, clamps and the
// degradation steps live here so the tests can check them without a renderer.
import type { TimeOfDay } from './skyPresets'

export type Rgb = [number, number, number]

export interface GradeParams {
  lift: Rgb // added to the blacks (never crushed to pure black)
  shadowTint: Rgb // multiplier in the shadows (cool)
  highTint: Rgb // multiplier in the highlights (warm)
  split: number // strength of the split tone
  sat: number // global saturation (1 = unchanged)
  warmSat: number // extra saturation for warm light
  grain: number // film grain amplitude, peak-to-peak fraction
  ca: number // chromatic aberration offset at the frame edge (UV units)
  vignette: number // darkness of the vignette
  bloom: { intensity: number; threshold: number; radius: number }
  halation: { intensity: number; threshold: number; radius: number }
}

/** Hard limits. Anything outside is clamped, so a preset edit cannot push the image past the brief. */
export const GRADE_LIMITS = {
  lift: [0, 0.05] as const,
  tint: [0.7, 1.3] as const,
  split: [0, 0.2] as const,
  sat: [0.9, 1.3] as const,
  warmSat: [0, 0.4] as const,
  grain: [0, 0.03] as const,
  ca: [0, 0.0006] as const,
  vignette: [0, 0.8] as const,
  bloomIntensity: [0.6, 1.6] as const,
  bloomThreshold: [0.6, 0.9] as const,
  bloomRadius: [0.3, 1] as const,
  halationIntensity: [0, 0.6] as const,
  halationThreshold: [0.3, 0.8] as const,
  halationRadius: [0.6, 1] as const
}

function clamp(v: number, [lo, hi]: readonly [number, number]): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function clampRgb(c: Rgb, range: readonly [number, number]): Rgb {
  return [clamp(c[0], range), clamp(c[1], range), clamp(c[2], range)]
}

/** Returns a copy of p with every value inside GRADE_LIMITS. */
export function clampGrade(p: GradeParams): GradeParams {
  const L = GRADE_LIMITS
  return {
    lift: clampRgb(p.lift, L.lift),
    shadowTint: clampRgb(p.shadowTint, L.tint),
    highTint: clampRgb(p.highTint, L.tint),
    split: clamp(p.split, L.split),
    sat: clamp(p.sat, L.sat),
    warmSat: clamp(p.warmSat, L.warmSat),
    grain: clamp(p.grain, L.grain),
    ca: clamp(p.ca, L.ca),
    vignette: clamp(p.vignette, L.vignette),
    bloom: {
      intensity: clamp(p.bloom.intensity, L.bloomIntensity),
      threshold: clamp(p.bloom.threshold, L.bloomThreshold),
      radius: clamp(p.bloom.radius, L.bloomRadius)
    },
    halation: {
      intensity: clamp(p.halation.intensity, L.halationIntensity),
      threshold: clamp(p.halation.threshold, L.halationThreshold),
      radius: clamp(p.halation.radius, L.halationRadius)
    }
  }
}

const BASE: GradeParams = {
  lift: [0.01, 0.012, 0.022],
  shadowTint: [0.82, 0.95, 1.12],
  highTint: [1.1, 1.0, 0.86],
  split: 0.1,
  sat: 1.04,
  warmSat: 0.22,
  grain: 0.02,
  ca: 0.0005,
  vignette: 0.5,
  bloom: { intensity: 1.2, threshold: 0.75, radius: 0.7 },
  halation: { intensity: 0.35, threshold: 0.5, radius: 0.95 }
}

/** The grade for each time of day. Night lifts toward brown, dawn toward lilac. */
export const GRADES: Record<TimeOfDay, GradeParams> = {
  blue: BASE,
  night: {
    ...BASE,
    lift: [0.012, 0.01, 0.016],
    shadowTint: [0.8, 0.92, 1.1],
    highTint: [1.12, 1.0, 0.84],
    split: 0.12,
    sat: 1.0,
    warmSat: 0.3,
    halation: { intensity: 0.5, threshold: 0.5, radius: 0.95 }
  },
  dawn: {
    ...BASE,
    lift: [0.02, 0.014, 0.024],
    shadowTint: [0.9, 0.92, 1.08],
    highTint: [1.08, 1.0, 0.9],
    split: 0.07,
    sat: 1.0,
    warmSat: 0.12,
    halation: { intensity: 0.25, threshold: 0.5, radius: 0.9 }
  }
}

/**
 * Degradation steps, applied when the frame rate drops: level 1 drops the halation pass, level 2 drops the grain
 * and the chromatic aberration, level 3 shrinks the bloom radius. Capture always passes level 0.
 */
export function degradeGrade(p: GradeParams, level: number): GradeParams {
  const q: GradeParams = { ...p, bloom: { ...p.bloom }, halation: { ...p.halation } }
  if (level >= 1) q.halation = { ...q.halation, intensity: 0 }
  if (level >= 2) {
    q.grain = 0
    q.ca = 0
  }
  if (level >= 3) q.bloom.radius = Math.min(q.bloom.radius, 0.4)
  return q
}

/** The number of degradation steps (0 = full quality). */
export const MAX_DEGRADE_LEVEL = 3
