// Backdrop: the far horizon beyond the metropolis. Two rings of low ridges (the Palisades across the Hudson, the hills past
// the island) at 1900 and 1980 units. They are aerial-perspective silhouettes, not solid hills: their colour comes from the
// live fog and haze (colorU, so they follow the time of day), warm grey-gold toward the sun and cool grey-blue away from it,
// and distance pulls them almost all the way into that haze. The towers that fill this ring come from Metropolis. The
// aviation beacons live in Rooftops. One draw call.
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, DoubleSide, ShaderMaterial } from 'three'
import { colorU, mulberry32 } from './Sky'
import { HAZE_DENSITY } from './metro'
import { lightingUniforms } from './lighting'

const RIDGE_VERT = `
attribute float aLayer;
attribute float aH;
varying float vLayer;
varying float vH;
varying vec3 vW;
void main() {
  vLayer = aLayer;
  vH = aH;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const RIDGE_FRAG = `
uniform vec3 uFog;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform float uFogDensity;
varying float vLayer;
varying float vH;
varying vec3 vW;
void main() {
  // Sun-facing haze: warm gold where the view points at the sun, cool grey-blue away from it.
  vec3 toRidge = normalize(vW - cameraPosition);
  float sunward = smoothstep(-0.2, 0.9, dot(toRidge, uSunDir));
  vec3 warm = mix(uFog, uHaze, 0.35) * vec3(1.0, 0.94, 0.86);
  vec3 cool = uFog * vec3(0.8, 0.86, 0.96);
  vec3 haze = mix(cool, warm, sunward);
  // The silhouette is a little darker than the haze behind it; the far ring is paler still.
  vec3 col = mix(haze * 0.82, haze * 0.9, vLayer);
  col += vec3(0.02, 0.02, 0.025) * smoothstep(0.6, 1.0, vH);
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, haze, fog), 1.0);
}`

/** Two rings of low-poly ridges beyond the metropolis: a near range and a farther, paler one. */
function makeRidges(): BufferGeometry {
  const rnd = mulberry32(21)
  const pos: number[] = []
  const layer: number[] = []
  const hgt: number[] = []
  const idx: number[] = []
  const SEG = 180
  const layers = [
    { r: 1900, base: 12, amp: 150, layer: 0 },
    { r: 1980, base: 20, amp: 210, layer: 1 }
  ]
  for (const L of layers) {
    // Ridged harmonics: sharp crests from 1 - |sin|, with a seeded jitter per vertex.
    const harm = Array.from({ length: 5 }, (_, k) => ({
      f: 2 + k * 3 + Math.floor(rnd() * 3),
      p: rnd() * Math.PI * 2,
      a: 1 / (k + 1.3)
    }))
    const start = pos.length / 3
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2
      let ridge = 0
      let norm = 0
      for (const h of harm) {
        ridge += h.a * (1 - Math.abs(Math.sin(a * h.f * 0.5 + h.p)))
        norm += h.a
      }
      const top = L.base + L.amp * Math.pow(ridge / norm, 1.6) + (rnd() - 0.5) * L.amp * 0.08
      const r = L.r + (rnd() - 0.5) * 8
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      // Bottom (below the ground, hidden) and top of each strip segment.
      pos.push(x, -40, z, x, Math.max(top, 0), z)
      layer.push(L.layer, L.layer)
      hgt.push(0, 1)
    }
    for (let i = 0; i < SEG; i++) {
      const b0 = start + i * 2
      const t0 = b0 + 1
      const b1 = b0 + 2
      const t1 = b0 + 3
      idx.push(b0, t0, b1, t0, t1, b1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aLayer', new BufferAttribute(new Float32Array(layer), 1))
  g.setAttribute('aH', new BufferAttribute(new Float32Array(hgt), 1))
  g.setIndex(idx)
  return g
}

export function Backdrop() {
  const ridgeGeo = useMemo(() => makeRidges(), [])
  const ridgeMat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uFog: colorU.fog,
      uHaze: colorU.haze,
      uSunDir: lightingUniforms.uSunDir,
      // Pulls the ridges most of the way into the haze at ~1900 units, leaving a faint silhouette.
      uFogDensity: { value: HAZE_DENSITY * 0.6 }
    },
    vertexShader: RIDGE_VERT,
    fragmentShader: RIDGE_FRAG,
    side: DoubleSide
  }), [])

  useEffect(() => () => {
    ridgeGeo.dispose()
    ridgeMat.dispose()
  }, [ridgeGeo, ridgeMat])

  return <mesh geometry={ridgeGeo} material={ridgeMat} frustumCulled={false} renderOrder={-6} />
}

