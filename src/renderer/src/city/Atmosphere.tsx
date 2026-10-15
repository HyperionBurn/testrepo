// Atmosphere: warm city haze. Ground-level haze layers lit orange by the street lights (additive, drifting), a thin
// mid-level haze that picks up the horizon colour, a stratified light-scatter dome around the city whose strength
// follows the lit-window density, and high thin cloud sheets lit from below by the city. Colours and strengths come
// from the shared time-of-day uniforms (Sky.tsx). Six draw calls. All motion is in the shaders on the shared clock
// skyTime, so reduced motion (which freezes that clock) makes it all static.
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, BackSide, PlaneGeometry, ShaderMaterial, SphereGeometry } from 'three'
import { useSky } from '../state/store'
import { DOME_VERT, NOISE_GLSL, colorU, levelU, skyTime } from './Sky'
import { NIGHT_MIX_GLSL, lightingUniforms } from './lighting'

const HAZE_GROUND_FRAG = `
uniform float uTime;
uniform float uScale;
uniform float uSpeed;
uniform float uAlpha;
uniform float uSeed;
uniform vec3 uHaze;
uniform float uNight;
varying vec3 vW;
${NOISE_GLSL}${NIGHT_MIX_GLSL}
void main() {
  vec2 p = vW.xz;
  float t = uTime * uSpeed;
  float n = fbm3(vec3(p * uScale + vec2(t, -0.6 * t), uSeed)) * 0.75
    + fbm3(vec3(p * uScale * 2.6 - vec2(1.7 * t, 0.0), uSeed + 5.0)) * 0.25;
  float bank = smoothstep(0.42, 0.8, n);
  // Street light pools: the haze is brightest over the core and thins out toward the far city. It is kept faint so the
  // asphalt between the lots stays near black, and it fades out with a long exponential tail (no visible edge).
  float lit = exp(-length(p) * 0.008);
  float edge = exp(-length(p) / 260.0);
  // Sodium haze over the streets is night only; by day the ground haze is a faint veil.
  float lamp = mix(0.1, 1.0, nightMix(uNight));
  gl_FragColor = vec4(uHaze * (0.35 + 0.65 * lit), 0.5 * bank * uAlpha * lit * edge * lamp);
}`

const HAZE_MID_FRAG = `
uniform float uTime;
uniform float uScale;
uniform float uSpeed;
uniform float uAlpha;
uniform float uSeed;
uniform vec3 uHorizon;
uniform vec3 uFog;
varying vec3 vW;
${NOISE_GLSL}
void main() {
  vec2 p = vW.xz;
  float t = uTime * uSpeed;
  float n = fbm3(vec3(p * uScale + vec2(-t, 0.4 * t), uSeed));
  float bank = smoothstep(0.45, 0.8, n);
  float r = length(p);
  // Warm horizon colour all over the city (a blue-grey fog ring showed as a hard blue ring from above), fading out
  // with a long exponential tail so the plane never shows an edge.
  vec3 col = mix(uHorizon, uFog, 0.25 + 0.25 * smoothstep(300.0, 900.0, r));
  float edge = exp(-r / 340.0);
  gl_FragColor = vec4(col, bank * uAlpha * edge);
}`

const SCATTER_FRAG = `
uniform float uTime;
uniform vec3 uHaze;
uniform float uScatter;
uniform float uDensity;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uFog;
uniform vec3 uKey;
varying vec3 vDir;
${NOISE_GLSL}${NIGHT_MIX_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float az = atan(d.z, d.x);
  // Stratified: thin bright layers in the scattering, as in long-exposure city photos.
  float strat = 0.55 + 0.45 * sin(h * 70.0 + fbm3(vec3(cos(az), sin(az), h * 3.0) * 1.4) * 5.0);
  float glow = exp(-max(h, 0.0) * 4.5) * smoothstep(-0.04, 0.03, h);
  // Night: light-pollution scatter in the street haze colour. Day: a faint veil, warmest toward the sun.
  float night = nightMix(uNight);
  float sunUp = smoothstep(0.0, 0.05, uSunDir.y);
  float fwd = pow(max(dot(d, uSunDir), 0.0), 4.0) * sunUp;
  vec3 lit = mix(uFog * 0.9 + uKey * fwd * 0.6, uHaze, night);
  float amt = glow * strat * uScatter * uDensity * (0.22 * night + 0.12 + 0.2 * fwd * (1.0 - night));
  gl_FragColor = vec4(lit * amt, 1.0);
}`

const CLOUD_FRAG = `
uniform float uTime;
uniform vec3 uCloudLow;
uniform vec3 uCloudHigh;
uniform float uSheets;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float band = smoothstep(0.12, 0.3, h) * (1.0 - smoothstep(0.55, 0.85, h));
  // Stretched horizontally so the cover reads as thin sheets, drifting very slowly.
  vec3 p = vec3(d.x, d.y * 0.45, d.z) * 3.2 + vec3(uTime * 0.01, 0.0, uTime * 0.006);
  float cloud = smoothstep(0.5, 0.85, fbm3(p));
  // Lit from below by the city: the underside glows warm orange, higher up it turns mauve.
  float under = 1.0 - smoothstep(0.1, 0.5, h);
  vec3 tint = mix(uCloudLow, uCloudHigh, smoothstep(0.2, 0.6, h));
  gl_FragColor = vec4(tint * (0.45 + 0.55 * under), cloud * band * 0.22 * uSheets);
}`

const FOG_BANKS = [
  { y: 0.8, scale: 0.0075, speed: 0.012, alpha: 0.09, seed: 1.3 },
  { y: 1.8, scale: 0.0055, speed: -0.008, alpha: 0.06, seed: 7.9 },
  { y: 3.0, scale: 0.0105, speed: 0.02, alpha: 0.04, seed: 14.2 }
] as const

const MID_BANKS = [
  { y: 22, scale: 0.0045, speed: 0.006, alpha: 0.07, seed: 3.7 },
  { y: 40, scale: 0.0032, speed: -0.004, alpha: 0.05, seed: 11.4 }
] as const

function makeGroundHaze(b: (typeof FOG_BANKS)[number]): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uScale: { value: b.scale },
      uSpeed: { value: b.speed },
      uAlpha: { value: b.alpha },
      uSeed: { value: b.seed },
      uHaze: colorU.haze,
      uNight: lightingUniforms.uNight
    },
    vertexShader: `varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: HAZE_GROUND_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
}

function makeMidHaze(b: (typeof MID_BANKS)[number]): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uScale: { value: b.scale },
      uSpeed: { value: b.speed },
      uAlpha: { value: b.alpha },
      uSeed: { value: b.seed },
      uHorizon: colorU.horizon,
      uFog: colorU.fog
    },
    vertexShader: `varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: HAZE_MID_FRAG,
    transparent: true,
    depthWrite: false
  })
}

export function Atmosphere() {
  const ground = useMemo(() => FOG_BANKS.map((b) => ({ y: b.y, mat: makeGroundHaze(b) })), [])
  const mid = useMemo(() => MID_BANKS.map((b) => ({ y: b.y, mat: makeMidHaze(b) })), [])
  const bankGeo = useMemo(() => new PlaneGeometry(1500, 1500), [])
  const scatterMat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uHaze: colorU.haze,
      uFog: colorU.fog,
      uKey: colorU.key,
      uSunDir: lightingUniforms.uSunDir,
      uNight: lightingUniforms.uNight,
      uScatter: levelU.scatter,
      uDensity: { value: 0.6 }
    },
    vertexShader: DOME_VERT,
    fragmentShader: SCATTER_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])
  const scatterGeo = useMemo(() => new SphereGeometry(880, 48, 24), [])
  const cloudMat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uCloudLow: colorU.cloudLow,
      uCloudHigh: colorU.cloudHigh,
      uSheets: levelU.sheets
    },
    vertexShader: DOME_VERT,
    fragmentShader: CLOUD_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false
  }), [])
  const cloudGeo = useMemo(() => new SphereGeometry(870, 48, 24), [])

  // Lit window density drives the scatter: a dense city glows more. Clamped so a small repo still has a glow.
  useFrame(() => {
    const n = useSky.getState().layout?.buildings.length ?? 0
    scatterMat.uniforms.uDensity!.value = Math.min(1, Math.max(0.3, n / 350))
  })

  useEffect(() => () => {
    for (const b of ground) b.mat.dispose()
    for (const b of mid) b.mat.dispose()
    bankGeo.dispose()
    scatterMat.dispose()
    scatterGeo.dispose()
    cloudMat.dispose()
    cloudGeo.dispose()
  }, [ground, mid, bankGeo, scatterMat, scatterGeo, cloudMat, cloudGeo])

  return (
    <>
      {ground.map((b) => (
        <mesh
          key={`g${b.y}`}
          geometry={bankGeo}
          material={b.mat}
          position={[0, b.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          frustumCulled={false}
          renderOrder={-2}
        />
      ))}
      <mesh geometry={scatterGeo} material={scatterMat} frustumCulled={false} renderOrder={-3} />
      <mesh geometry={cloudGeo} material={cloudMat} frustumCulled={false} renderOrder={-3} />
      {mid.map((b) => (
        <mesh
          key={`m${b.y}`}
          geometry={bankGeo}
          material={b.mat}
          position={[0, b.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          frustumCulled={false}
          renderOrder={-1}
        />
      ))}
    </>
  )
}
