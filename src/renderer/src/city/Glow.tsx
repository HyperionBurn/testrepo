// Ground glow: a large light-pollution dome lying on the ground, centred on the city. Warm sodium orange, brightest in a
// ring where the neighbourhoods thin out into the metropolis, and faintly tinted by the district hues. One additive disc,
// depth tested, so buildings and plates cover it. No per-frame JS.
import { useEffect, useMemo } from 'react'
import { AdditiveBlending, Color, PlaneGeometry, ShaderMaterial } from 'three'
import type { CityDistrict } from '@shared/types'
import { useSky } from '../state/store'

/** Radius of the glow disc in world units (it reaches the edge of the metropolis). */
const RADIUS = 1500

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAG = `
uniform vec3 uWarm;
uniform vec3 uTint;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // Plane spans 2 * RADIUS, so r is 0 at the centre and 1 at the rim.
  float r = length(vUv - 0.5) * 2.0;
  float d = r * ${RADIUS.toFixed(1)};
  float core = exp(-d / 260.0) * 0.35;
  float ring = exp(-pow((d - 720.0) / 420.0, 2.0)) * 0.5;
  float fall = 1.0 - smoothstep(0.62, 1.0, r);
  vec3 col = mix(uWarm, uTint, 0.25) * (core + ring) * fall;
  gl_FragColor = vec4(col * uStrength, 1.0);
}`

/** The district hues, averaged by area into one tint. */
function neighbourhoodTint(districts: readonly CityDistrict[]): Color {
  const acc = new Color(0, 0, 0)
  const c = new Color()
  let area = 0
  for (const d of districts) {
    const a = d.w * d.d
    c.setHSL((0.56 + d.depth * 0.04) % 1, 0.9, 0.5)
    acc.r += c.r * a
    acc.g += c.g * a
    acc.b += c.b * a
    area += a
  }
  if (area <= 0) return new Color('#19c6d9')
  const mean = new Color(acc.r / area, acc.g / area, acc.b / area)
  const peak = Math.max(mean.r, mean.g, mean.b, 1e-4)
  return mean.multiplyScalar(1 / peak)
}

const NO_DISTRICTS: CityDistrict[] = []

export function GroundGlow() {
  const districts = useSky((s) => s.layout?.districts ?? NO_DISTRICTS)
  const geo = useMemo(() => {
    const g = new PlaneGeometry(RADIUS * 2, RADIUS * 2)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])
  const material = useMemo(() => new ShaderMaterial({
    uniforms: {
      uWarm: { value: new Color('#ff9a4a') },
      uTint: { value: neighbourhoodTint(districts) },
      uStrength: { value: 0.3 }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [districts])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geo.dispose(), [geo])
  return <mesh geometry={geo} material={material} position={[0, 0.05, 0]} renderOrder={-4} frustumCulled={false} />
}
