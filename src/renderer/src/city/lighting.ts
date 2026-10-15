// Scene light for each time of day: one sun (a DirectionalLight that casts shadows), one sky-fill ambient term and the
// night mix that drives the window emissive. Pure data and maths (no React, no three renderer), so the presets can be
// tested. Sun.tsx turns the state into a light and shadow camera; materials read the shared uniforms below by reference.
//
// Conventions (world frame, y up): x east, z south, so north is -z (avenues run along -z).
//  - sunDir is the unit direction FROM the scene TO the sun. Negative y means the sun is below the horizon.
//  - sunColor / sunIntensity are the DirectionalLight colour and intensity. uSunColor carries their product.
//  - ambient / ambientIntensity are the sky fill. uAmbient carries their product.
import { Color, Vector3, type Material } from 'three'

export type TimeOfDay = 'golden' | 'blue' | 'night' | 'dawn'

export interface LightingState {
  /** 0 = day, 1 = full night. Drives the window emissive mix and the shader night tint. */
  night: number
  /** Unit vector from the scene towards the sun. */
  sunDir: Vector3
  sunColor: Color
  /** DirectionalLight intensity (0 means no sun, and the shadow map is switched off). */
  sunIntensity: number
  /** Sky fill colour (linear) and its strength. */
  ambient: Color
  ambientIntensity: number
  /** Multiplier on window and lamp emissive. */
  emissiveGain: number
}

/**
 * Shared uniform objects. Materials put these into shader.uniforms by reference, so one write in applyLighting reaches
 * every material. uSunColor = sunColor * sunIntensity and uAmbient = ambient * ambientIntensity (both linear).
 */
export const lightingUniforms: {
  uNight: { value: number }
  uSunDir: { value: Vector3 }
  uSunColor: { value: Color }
  uAmbient: { value: Color }
  uEmissiveGain: { value: number }
} = {
  uNight: { value: 0 },
  uSunDir: { value: new Vector3(0, 1, 0) },
  uSunColor: { value: new Color(0, 0, 0) },
  uAmbient: { value: new Color(0, 0, 0) },
  uEmissiveGain: { value: 1 }
}

/**
 * The night gate: 0 by day, 1 at night. Every night-only light (lamps, halos, searchlights, lit windows, beacons)
 * scales by it, so the daytime sky never shows them. Same curve as the GLSL nightMix below.
 */
export function nightGate(night: number): number {
  const t = Math.min(1, Math.max(0, (night - 0.35) / 0.35))
  return t * t * (3 - 2 * t)
}

/** GLSL twin of nightGate. A shader that uses it declares `uniform float uNight;` and passes lightingUniforms.uNight. */
export const NIGHT_MIX_GLSL = `
float nightMix(float n) {
  float t = clamp((n - 0.35) / 0.35, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`

/**
 * Gates a built-in material (MeshBasic, Points, Line) by the night mix: the output is dayFloor by day and full strength
 * at night. Patches the fragment shader once, so it costs no per-frame work and reads lightingUniforms.uNight live.
 */
export function gateNightMaterial<M extends Material>(mat: M, dayFloor: number): M {
  const floor = Math.min(1, Math.max(0, dayFloor)).toFixed(3)
  mat.customProgramCacheKey = () => `night-gate-${floor}`
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = lightingUniforms.uNight
    shader.fragmentShader = shader.fragmentShader
      .replace('void main()', `uniform float uNight;\n${NIGHT_MIX_GLSL}\nvoid main()`)
      .replace(
        '#include <opaque_fragment>',
        `{ float gNight = mix(${floor}, 1.0, nightMix(uNight)); outgoingLight *= gNight; diffuseColor.a *= gNight; }\n#include <opaque_fragment>`
      )
  }
  return mat
}

/** Sun direction from a compass bearing (degrees clockwise from north) and an elevation above the horizon. */
function sunFrom(bearingDeg: number, elevationDeg: number): Vector3 {
  const b = (bearingDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  const ce = Math.cos(e)
  // East is +x, and north is -z.
  return new Vector3(Math.sin(b) * ce, Math.sin(e), -Math.cos(b) * ce).normalize()
}

function state(p: {
  night: number
  bearing: number
  elevation: number
  sunColor: string
  sunIntensity: number
  ambient: string
  ambientIntensity: number
  emissiveGain: number
}): LightingState {
  return {
    night: p.night,
    sunDir: sunFrom(p.bearing, p.elevation),
    sunColor: new Color(p.sunColor),
    sunIntensity: p.sunIntensity,
    ambient: new Color(p.ambient),
    ambientIntensity: p.ambientIntensity,
    emissiveGain: p.emissiveGain
  }
}

/**
 * The lighting of each preset. Golden hour is the default: a low sun from the WSW (bearing 247.5) so the shadows rake
 * east along the streets. Dawn has the sun rising in the ENE. Blue hour and night have the sun below the horizon.
 */
export function presetLighting(t: TimeOfDay): LightingState {
  switch (t) {
    case 'golden':
      return state({
        night: 0, bearing: 247.5, elevation: 10, sunColor: '#ffb36b', sunIntensity: 3.2,
        ambient: '#8fb6d8', ambientIntensity: 0.45, emissiveGain: 0.3
      })
    case 'blue':
      return state({
        night: 0.65, bearing: 285, elevation: -8, sunColor: '#cfe0ff', sunIntensity: 0,
        ambient: '#3b4f8a', ambientIntensity: 0.5, emissiveGain: 0.9
      })
    case 'night':
      return state({
        night: 1, bearing: 250, elevation: -25, sunColor: '#ffd9a8', sunIntensity: 0,
        ambient: '#3a2a22', ambientIntensity: 0.25, emissiveGain: 1.25
      })
    case 'dawn':
      return state({
        night: 0.3, bearing: 80, elevation: 7, sunColor: '#ffa06a', sunIntensity: 2.4,
        ambient: '#9a8fd0', ambientIntensity: 0.5, emissiveGain: 0.5
      })
  }
}

/** Shortest-path interpolation of two angles (radians). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/** A blank state to blend into (one allocation, reused every frame). */
export function emptyLighting(): LightingState {
  return {
    night: 0, sunDir: new Vector3(0, 1, 0), sunColor: new Color(0, 0, 0), sunIntensity: 0,
    ambient: new Color(0, 0, 0), ambientIntensity: 0, emissiveGain: 1
  }
}

/**
 * Writes the blend of a and b at t (0 = a, 1 = b) into out. The sun sweeps its azimuth the short way round and
 * interpolates its elevation, so the direction stays unit length. Colours mix in linear space.
 */
export function blendLightingInto(out: LightingState, a: LightingState, b: LightingState, t: number): LightingState {
  const k = Math.min(1, Math.max(0, t))
  const lerp = (x: number, y: number) => x + (y - x) * k
  const az = lerpAngle(Math.atan2(a.sunDir.x, a.sunDir.z), Math.atan2(b.sunDir.x, b.sunDir.z), k)
  const el = lerp(Math.asin(clamp1(a.sunDir.y)), Math.asin(clamp1(b.sunDir.y)))
  const ce = Math.cos(el)
  out.night = lerp(a.night, b.night)
  out.sunDir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce)
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, k)
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity)
  out.ambient.copy(a.ambient).lerp(b.ambient, k)
  out.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity)
  out.emissiveGain = lerp(a.emissiveGain, b.emissiveGain)
  return out
}

/** Blends two lighting states at t into a new state. See blendLightingInto. */
export function lerpLighting(a: LightingState, b: LightingState, t: number): LightingState {
  return blendLightingInto(emptyLighting(), a, b, t)
}

/**
 * A transition between two presets, like PresetTransition for the sky. Sun.tsx advances it each frame with the frame
 * delta and applies `current`. With animate = false the change lands on the next step.
 */
export class LightingTransition {
  readonly current: LightingState
  private from: LightingState
  private to: LightingState
  private elapsed = 0
  private duration = 0
  target: TimeOfDay

  constructor(initial: TimeOfDay, readonly seconds = 2) {
    this.target = initial
    this.current = presetLighting(initial)
    this.to = presetLighting(initial)
    this.from = this.to
  }

  /** Starts a change to `next`, from wherever the light is right now. */
  setTarget(next: TimeOfDay, animate: boolean): void {
    if (next === this.target) return
    this.target = next
    this.from = blendLightingInto(emptyLighting(), this.current, this.current, 0)
    this.to = presetLighting(next)
    this.elapsed = 0
    this.duration = animate ? this.seconds : 0
  }

  /** Advances by dt seconds and refreshes `current`. Returns true while the light is still moving. */
  step(dt: number): boolean {
    if (this.duration === 0) {
      if (this.from === this.to) return false
      blendLightingInto(this.current, this.to, this.to, 0)
      this.from = this.to
      return true
    }
    this.elapsed = Math.min(this.duration, this.elapsed + Math.min(Math.max(dt, 0), 0.1))
    const k = this.elapsed / this.duration
    blendLightingInto(this.current, this.from, this.to, k * k * (3 - 2 * k))
    if (this.elapsed >= this.duration) {
      this.duration = 0
      this.from = this.to
      return false
    }
    return true
  }
}

function clamp1(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

/** Writes a state into the shared uniforms. Call once per frame while a transition is running. */
export function applyLighting(s: LightingState): void {
  const u = lightingUniforms
  u.uNight.value = s.night
  u.uSunDir.value.copy(s.sunDir).normalize()
  u.uSunColor.value.copy(s.sunColor).multiplyScalar(s.sunIntensity)
  u.uAmbient.value.copy(s.ambient).multiplyScalar(s.ambientIntensity)
  u.uEmissiveGain.value = s.emissiveGain
}
