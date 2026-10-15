// Photographic grade as one postprocessing effect: lifted blacks (deep blue-black, never crushed), split toning
// (cool shadows, warm highlights), a gentle S-curve for a soft shoulder, a warm-weighted saturation boost and very
// light animated film grain. Mounted by Effects.tsx after tone mapping, so it
// works on display-referred values. Parameters come from gradeParams.ts, clamped to its limits.
import { Effect } from 'postprocessing'
import { Uniform, Vector3, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import { clampGrade, type GradeParams } from './gradeParams'

const GRADE_FRAG = `
uniform float uTime;
uniform float uAnimate;
uniform vec3 uLift;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uSplit;
uniform float uSat;
uniform float uWarmSat;
uniform float uGrain;
uniform float uCurve;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  // Lift: the blacks keep a little blue-brown colour instead of crushing to pure black.
  c = uLift + c * (1.0 - uLift);
  // Split toning: cool shadows, warm highlights, both weighted by luminance.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float shadow = 1.0 - smoothstep(0.02, 0.4, l);
  float high = smoothstep(0.45, 0.95, l);
  c *= mix(vec3(1.0), uShadowTint, shadow * uSplit);
  c *= mix(vec3(1.0), uHighTint, high * uSplit);
  // Gentle S-curve: contrast in the mids, a soft shoulder on the highlights, blacks left where they are.
  vec3 k = clamp(c, 0.0, 1.0);
  c = mix(c, k * k * (3.0 - 2.0 * k), uCurve);
  // Saturation: lamps and windows (warm, red over blue) gain more than the neutral walls.
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float warm = clamp(c.r - c.b, 0.0, 1.0);
  c = mix(vec3(l), c, uSat + uWarmSat * warm);
  // Grain: lighter in the highlights, animated by uTime (uAnimate is 0 under reduced motion).
  float t = uTime * uAnimate;
  float g = hash12(gl_FragCoord.xy + vec2(fract(t * 0.37) * 311.0, fract(t * 0.11) * 173.0)) - 0.5;
  c += g * uGrain * (1.0 - 0.6 * smoothstep(0.4, 1.0, l));
  outputColor = vec4(max(c, 0.0), inputColor.a);
}`

export class GradeEffect extends Effect {
  private animate = true

  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      uniforms: new Map<string, Uniform>([
        ['uTime', new Uniform(0)],
        ['uAnimate', new Uniform(1)],
        ['uLift', new Uniform(new Vector3())],
        ['uShadowTint', new Uniform(new Vector3(1, 1, 1))],
        ['uHighTint', new Uniform(new Vector3(1, 1, 1))],
        ['uSplit', new Uniform(0)],
        ['uSat', new Uniform(1)],
        ['uWarmSat', new Uniform(0)],
        ['uGrain', new Uniform(0)],
        ['uCurve', new Uniform(0)]
      ])
    })
  }

  /** Writes a (clamped) grade into the uniforms. animate = false freezes the grain (reduced motion). */
  apply(params: GradeParams, animate: boolean): void {
    const p = clampGrade(params)
    const u = this.uniforms
    this.animate = animate
    u.get('uAnimate')!.value = animate ? 1 : 0
    u.get('uLift')!.value.set(...p.lift)
    u.get('uShadowTint')!.value.set(...p.shadowTint)
    u.get('uHighTint')!.value.set(...p.highTint)
    u.get('uSplit')!.value = p.split
    u.get('uSat')!.value = p.sat
    u.get('uWarmSat')!.value = p.warmSat
    u.get('uGrain')!.value = p.grain
    u.get('uCurve')!.value = p.curve
  }

  update(_renderer: WebGLRenderer, _inputBuffer: WebGLRenderTarget, deltaTime = 0): void {
    if (this.animate) this.uniforms.get('uTime')!.value += deltaTime
  }
}
