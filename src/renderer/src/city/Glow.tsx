// Ground glow: a soft warm sodium pool on the ground, centred on the repo city. Brightest right over the city and falling
// off smoothly over about 120 units, with a long faint tail that dies out well before the disc edge, so no ring shows. One
// additive disc, depth tested. No per-frame JS.
import { useEffect, useMemo } from 'react'
import { AdditiveBlending, Color, PlaneGeometry, ShaderMaterial } from 'three'

/** Radius of the glow disc in world units (it fades to nothing before this). */
const RADIUS = 1500

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAG = `
uniform vec3 uWarm;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // Plane spans 2 * RADIUS, so d is the distance from the city centre in world units.
  float r = length(vUv - 0.5) * 2.0;
  float d = r * ${RADIUS.toFixed(1)};
  // A soft sodium pool over ~90 units, a faint long tail, and a fade to zero well before the plane's edge. Kept dim:
  // the asphalt between the lots must stay near black, so the pool reads as light on the ground, not a brown wash.
  float pool = exp(-d / 90.0) * 0.6 + exp(-d / 220.0) * 0.04;
  float fall = 1.0 - smoothstep(360.0, 700.0, d);
  vec3 col = uWarm * pool * fall;
  gl_FragColor = vec4(col * uStrength, 1.0);
}`

export function GroundGlow() {
  const geo = useMemo(() => {
    const g = new PlaneGeometry(RADIUS * 2, RADIUS * 2)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])
  const material = useMemo(() => new ShaderMaterial({
    uniforms: {
      uWarm: { value: new Color('#ff9a4a') },
      uStrength: { value: 0.12 }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geo.dispose(), [geo])
  return <mesh geometry={geo} material={material} position={[0, 0.05, 0]} renderOrder={-4} frustumCulled={false} />
}
