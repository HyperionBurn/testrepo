// Backdrop: the far horizon beyond the metropolis. Two rings of dark low-poly ridges (the Palisades across the Hudson, the
// hills past the island) at 1900 and 1980 units, fogged into the haze so they read as a silhouette above the warm band.
// The towers that used to fill this ring now come from Metropolis, and the aviation beacons moved to the beacon module.
// One draw call.
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, ShaderMaterial } from 'three'
import { mulberry32 } from './Sky'
import { HAZE_DENSITY } from './metro'

const HORIZON = '#1a2a52'

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
uniform vec3 uNear;
uniform vec3 uFar;
uniform vec3 uHorizon;
uniform float uFogDensity;
varying float vLayer;
varying float vH;
varying vec3 vW;
void main() {
  vec3 col = mix(uNear, uFar, vLayer);
  // Faint lift on the crests from the city's glow.
  col += vec3(0.05, 0.1, 0.16) * smoothstep(0.6, 1.0, vH) * (0.6 + 0.4 * vLayer);
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uHorizon, fog), 1.0);
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
    { r: 1900, base: 30, amp: 220, layer: 0 },
    { r: 1980, base: 50, amp: 320, layer: 1 }
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
      uNear: { value: new Color('#0a1130') },
      uFar: { value: new Color('#16295a') },
      uHorizon: { value: new Color(HORIZON) },
      uFogDensity: { value: HAZE_DENSITY * 0.8 }
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

