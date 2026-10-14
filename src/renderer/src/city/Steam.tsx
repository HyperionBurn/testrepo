// Steam plumes: rooftop vents and street manholes along the avenues (roofs.ts plans about 120 emitters). Each emitter
// puffs six soft sprites that rise 3 to 5 units, drift with a global wind and widen as they go. The puffs are
// additive points animated entirely in the vertex shader, so there is one draw call and no per-frame JS per puff.
// Near the street the steam is lit warm orange; higher up it turns bluish-white. Reduced motion freezes the puffs
// where they are.
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three'
import { useSky } from '../state/store'
import { hash01 } from './signs'
import { skylineCounts, steamFor, type SteamEmitter } from './roofs'

/** Puffs per emitter. Each emitter cycles through its puffs at staggered phases. */
export const PUFFS_PER_EMITTER = 6
/** Global wind, world units per unit of rise: steam leans east and a little south. */
export const WIND: readonly [number, number] = [0.55, 0.22]

const STEAM_VERT = `
uniform float uTime;
uniform vec2 uWind;
uniform float uPx;
attribute float aSeed;
attribute float aPhase;
attribute float aRoof;
varying float vA;
varying float vT;
varying float vY;
void main() {
  float life = 9.0 + aSeed * 5.0;
  float t = fract(uTime / life + aPhase);
  float rise = mix(3.0, 5.0, aSeed) * (aRoof > 0.5 ? 0.9 : 1.0);
  vec3 p = position;
  p.y += t * rise;
  // Wind leans the plume more the higher it gets, with a slow wobble on top.
  p.xz += uWind * t * rise;
  p.x += sin(uTime * 0.6 + aSeed * 40.0 + t * 3.0) * 0.25 * t;
  p.z += cos(uTime * 0.5 + aSeed * 31.0 + t * 2.0) * 0.25 * t;
  float size = mix(0.7, 3.0, t) * (aRoof > 0.5 ? 0.9 : 1.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * uPx * 1000.0 / -mv.z, 1.0, 128.0);
  vA = pow(sin(3.14159265 * t), 1.5) * 0.5;
  vT = t;
  vY = p.y;
}`

const STEAM_FRAG = `
uniform float uIntensity;
varying float vA;
varying float vT;
varying float vY;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float soft = smoothstep(1.0, 0.0, d);
  soft *= soft;
  // Warm orange near the street, bluish-white higher up and older puffs dimmer.
  vec3 warm = vec3(1.0, 0.56, 0.24);
  vec3 cool = vec3(0.7, 0.78, 1.0);
  vec3 col = mix(warm, cool, smoothstep(2.0, 14.0, vY));
  col *= 0.6 + 0.4 * (1.0 - vT);
  gl_FragColor = vec4(col * soft * vA * uIntensity, 1.0);
}`

export interface SteamBuild {
  points: Points;
  uniforms: { uTime: { value: number }; uWind: { value: [number, number] }; uPx: { value: number }; uIntensity: { value: number } };
  dispose: () => void;
}

/** Builds the puff points for a set of emitters. Pure except for the three.js objects it returns. */
export function buildSteam(emitters: readonly SteamEmitter[], pixelRatio: number): SteamBuild {
  const n = emitters.length * PUFFS_PER_EMITTER
  const pos = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const phase = new Float32Array(n)
  const roof = new Float32Array(n)
  let i = 0
  for (const e of emitters) {
    for (let k = 0; k < PUFFS_PER_EMITTER; k++) {
      pos[i * 3] = e.x
      pos[i * 3 + 1] = e.y
      pos[i * 3 + 2] = e.z
      seed[i] = e.seed
      phase[i] = k / PUFFS_PER_EMITTER + hash01(`${e.x.toFixed(2)},${e.z.toFixed(2)}`, `puff-${k}`) * 0.08
      roof[i] = e.kind === 'roof' ? 1 : 0
      i++
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new BufferAttribute(seed, 1))
  geo.setAttribute('aPhase', new BufferAttribute(phase, 1))
  geo.setAttribute('aRoof', new BufferAttribute(roof, 1))
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: [WIND[0], WIND[1]] as [number, number] },
    uPx: { value: pixelRatio },
    uIntensity: { value: 0.85 }
  }
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: STEAM_VERT,
    fragmentShader: STEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
  const points = new Points(geo, mat)
  points.frustumCulled = false
  return {
    points,
    uniforms,
    dispose: () => {
      geo.dispose()
      mat.dispose()
    }
  }
}

export function Steam() {
  const layout = useSky((s) => s.layout)
  const reduced = useSky((s) => s.reducedMotion)
  const gl = useThree((s) => s.gl)
  const emitters = useMemo(() => (layout ? steamFor(layout) : null), [layout])
  const built = useMemo(
    () => (emitters ? buildSteam(emitters, gl.getPixelRatio()) : null),
    // Read once per plan. The pixel ratio changes with the canvas, which keeps the same plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emitters]
  )

  useEffect(() => () => built?.dispose(), [built])

  // Reduced motion: the uniform stays at 0, so every puff is frozen where it starts.
  useFrame(({ clock }) => {
    if (built && !reduced) built.uniforms.uTime.value = clock.elapsedTime
  })

  useEffect(() => {
    skylineCounts.steamEmitters = emitters?.length ?? 0
  }, [emitters])

  if (!built) return null
  return <primitive object={built.points} />
}
