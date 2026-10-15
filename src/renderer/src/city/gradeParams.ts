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
  curve: number // strength of the gentle S-curve on display values (0 = linear)
  bloom: { intensity: number; threshold: number; radius: number }
  halation: { intensity: number; threshold: number; radius: number }
  ao: { intensity: number; radius: number; falloff: number } // N8AO contact shadows (intensity 0 = off)
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
  halationRadius: [0.6, 1] as const,
  curve: [0, 0.6] as const,
  aoIntensity: [0, 3] as const,
  aoRadius: [1, 6] as const,
  aoFalloff: [0.2, 3] as const
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
    },
    curve: clamp(p.curve, L.curve),
    ao: {
      intensity: clamp(p.ao.intensity, L.aoIntensity),
      radius: clamp(p.ao.radius, L.aoRadius),
      falloff: clamp(p.ao.falloff, L.aoFalloff)
    }
  }
}

// Photographic, not video-game: deep blue-black blacks, a soft shoulder on the highlights, bloom only for the
// brightest windows and lamps, a whisper of halation and grain, and no chromatic aberration.
const BASE: GradeParams = {
  lift: [0.005, 0.007, 0.015],
  shadowTint: [0.84, 0.95, 1.1],
  highTint: [1.06, 1.0, 0.9],
  split: 0.08,
  sat: 1.0,
  warmSat: 0.12,
  grain: 0.006,
  ca: 0,
  vignette: 0.4,
  curve: 0.35,
  bloom: { intensity: 0.8, threshold: 0.85, radius: 0.6 },
  halation: { intensity: 0.12, threshold: 0.7, radius: 0.8 },
  ao: { intensity: 2, radius: 3, falloff: 1 }
}

/** The grade for each time of day. Night lifts toward brown, dawn toward lilac. */
export const GRADES: Record<TimeOfDay, GradeParams> = {
  blue: BASE,
  night: {
    ...BASE,
    lift: [0.006, 0.006, 0.012],
    shadowTint: [0.8, 0.92, 1.1],
    highTint: [1.1, 1.0, 0.86],
    split: 0.1,
    warmSat: 0.2,
    bloom: { intensity: 0.9, threshold: 0.8, radius: 0.6 },
    halation: { intensity: 0.18, threshold: 0.7, radius: 0.8 }
  },
  dawn: {
    ...BASE,
    lift: [0.008, 0.007, 0.014],
    shadowTint: [0.9, 0.92, 1.08],
    highTint: [1.06, 1.0, 0.92],
    split: 0.06,
    halation: { intensity: 0.1, threshold: 0.7, radius: 0.8 }
  }
}

/**
 * Degradation steps, applied when the frame rate drops. Level 1 drops the ambient occlusion, level 2 the halation,
 * level 3 the grain and the chromatic aberration, level 4 shrinks the bloom radius. Capture always passes level 0.
 */
export function degradeGrade(p: GradeParams, level: number): GradeParams {
  const q: GradeParams = { ...p, bloom: { ...p.bloom }, halation: { ...p.halation }, ao: { ...p.ao } }
  if (level >= 1) q.ao = { ...q.ao, intensity: 0 }
  if (level >= 2) q.halation = { ...q.halation, intensity: 0 }
  if (level >= 3) {
    q.grain = 0
    q.ca = 0
  }
  if (level >= 4) q.bloom.radius = Math.min(q.bloom.radius, 0.4)
  return q
}

/** The number of degradation steps (0 = full quality). */
export const MAX_DEGRADE_LEVEL = 4
