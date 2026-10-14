// Ground glow: a soft light-pollution dome lying on the ground around the city, in the city's own neighbourhood
// colours. One additive disc, drawn with depth test so buildings and plates cover it. No per-frame JS.
import { useEffect, useMemo } from 'react'
import { AdditiveBlending, Color, PlaneGeometry, ShaderMaterial } from 'three'
import type { CityDistrict } from '@shared/types'
import { useSky } from '../state/store'

/** Radius of the glow disc in world units (the city fits well inside it). */
const RADIUS = 260

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAG = `
uniform vec3 uColor;
uniform vec3 uAlt;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // Plane spans 2 * RADIUS, so r is 0 at the centre and 1 at the rim.
  float r = length(vUv - 0.5) * 2.0;
  float d = r * ${RADIUS.toFixed(1)};
  float core = exp(-d / 70.0);
  float wide = exp(-d / 150.0);
  float rim = 1.0 - smoothstep(0.55, 1.0, r);
  vec3 col = mix(uColor, uAlt, smoothstep(0.0, 1.0, r)) * (core * 0.9 + wide * 0.45) * rim;
  gl_FragColor = vec4(col * uStrength, 1.0);
}`

/** The district hues, averaged by area into one colour (and a second, complementary one for the outer ring). */
function neighbourhoodColours(districts: readonly CityDistrict[]): [Color, Color] {
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
  if (area <= 0) return [new Color('#19c6d9'), new Color('#c64fae')]
  const mean = new Color(acc.r / area, acc.g / area, acc.b / area)
  const peak = Math.max(mean.r, mean.g, mean.b, 1e-4)
  mean.multiplyScalar(1 / peak)
  const alt = new Color('#c64fae').lerp(mean, 0.35)
  return [mean, alt]
}

const NO_DISTRICTS: CityDistrict[] = []

export function GroundGlow() {
  const districts = useSky((s) => s.layout?.districts ?? NO_DISTRICTS)
  const geo = useMemo(() => {
    const g = new PlaneGeometry(RADIUS * 2, RADIUS * 2)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])
  const material = useMemo(() => {
    const [a, b] = neighbourhoodColours(districts)
    return new ShaderMaterial({
      uniforms: {
        uColor: { value: a },
        uAlt: { value: b },
        uStrength: { value: 0.3 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
  }, [districts])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geo.dispose(), [geo])
  return <mesh geometry={geo} material={material} position={[0, 0.05, 0]} renderOrder={-4} frustumCulled={false} />
}
