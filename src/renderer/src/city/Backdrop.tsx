// Backdrop: the city as part of a vast metropolis. A ring of two mountain ridges far out, a ring of a few hundred
// distant skyline towers with sparse lit windows (instanced, shader-lit, no per-frame JS), and red aviation beacons
// blinking on the tallest towers of the current layout. Three draw calls. Fog here uses its own, lighter density than
// the city fog (a fraction of FOG_DENSITY) so the far rings stay readable instead of dissolving at 400 units.
import { useEffect, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4,
  MeshStandardMaterial, Quaternion, ShaderMaterial, Vector3
} from 'three'
import { useSky } from '../state/store'
import { FOG_DENSITY, mulberry32, skyTime } from './Sky'
import { loadModels, type LoadedModel } from './assets'
import { createFarSkylineMaterial, prepareModelMaterial } from './buildingShader'

/** Lighter than the city fog: the far rings sit 300 to 650 units out. */
const BACKDROP_FOG = FOG_DENSITY * 0.3
const HORIZON = '#1a2a52'
const BEACONS = 30

// ---- Mountains -------------------------------------------------------------------------------------------

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
  // Sunless rim light from the city glow along the crest, a little lift toward the top of each ridge.
  col += vec3(0.05, 0.12, 0.2) * smoothstep(0.6, 1.0, vH) * (0.6 + 0.4 * vLayer);
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uHorizon, fog), 1.0);
}`

/** Two rings of low-poly ridges around the city: a near range and a farther, paler one. */
function makeRidges(): BufferGeometry {
  const rnd = mulberry32(21)
  const pos: number[] = []
  const layer: number[] = []
  const hgt: number[] = []
  const idx: number[] = []
  const SEG = 180
  // Near range and far range, seen from the low wide and reveal poses. The framed view looks 35 degrees down, so its
  // top edge sits below the horizon and these ridges are never in that frame.
  const layers = [
    { r: 600, base: 26, amp: 150, layer: 0 },
    { r: 930, base: 40, amp: 260, layer: 1 }
  ]
  for (const L of layers) {
    // Ridged harmonics: sharp crests from 1 - |sin|, with a seeded fractal jitter per vertex.
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

// ---- Distant skyline -------------------------------------------------------------------------------------

const SKYLINE_VERT = `
varying vec3 vN;
varying vec3 vP;
varying float vSeed;
varying vec3 vW;
void main() {
  mat4 im = instanceMatrix;
  vec3 size = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
  vP = position * size;
  vN = normal;
  vSeed = fract(sin(dot(im[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 w = modelMatrix * im * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const SKYLINE_FRAG = `
uniform vec3 uBase;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec3 uHorizon;
uniform float uFogDensity;
uniform float uTime;
varying vec3 vN;
varying vec3 vP;
varying float vSeed;
varying vec3 vW;
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec3 col = uBase;
  // Windows: sparse lit cells on the side faces only.
  vec2 uv = abs(vN.x) > 0.5 ? vec2(vP.z, vP.y) : vec2(vP.x, vP.y);
  vec2 g = uv / vec2(2.2, 2.6);
  vec2 id = floor(g);
  vec2 f = fract(g);
  float r = hash21(id + vSeed * 91.7);
  float on = step(0.9, r);
  float inside = step(0.2, f.x) * step(f.x, 0.62) * step(0.25, f.y) * step(f.y, 0.7);
  float flick = 0.85 + 0.15 * sin(uTime * 0.6 + r * 40.0 + vSeed * 9.0);
  vec3 tint = mix(uWarm, uCool, step(0.5, hash21(id * 1.7 + vSeed)));
  float side = 1.0 - step(0.5, abs(vN.y));
  col += tint * on * inside * flick * 0.5 * side;
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uHorizon, fog), 1.0);
}`

/** A few hundred towers on a seeded ring 300 to 480 units out. Mostly low, a few tall. */
function makeSkyline(): InstancedMesh {
  const rnd = mulberry32(44)
  const COUNT = 420
  const geo = new BoxGeometry(1, 1, 1)
  geo.translate(0, 0.5, 0)
  const mat = new ShaderMaterial({
    uniforms: {
      uBase: { value: new Color('#050a1a') },
      uWarm: { value: new Color('#ffb36b') },
      uCool: { value: new Color('#7fe7ff') },
      uHorizon: { value: new Color(HORIZON) },
      uFogDensity: { value: BACKDROP_FOG },
      uTime: skyTime
    },
    vertexShader: SKYLINE_VERT,
    fragmentShader: SKYLINE_FRAG
  })
  const mesh = new InstancedMesh(geo, mat, COUNT)
  const m = new Matrix4()
  const p = new Vector3()
  const s = new Vector3()
  const q = new Quaternion()
  for (let i = 0; i < COUNT; i++) {
    const a = rnd() * Math.PI * 2
    const R = 300 + Math.pow(rnd(), 0.8) * 180
    const k = rnd()
    const h = k < 0.7 ? 6 + rnd() * 10 : k < 0.95 ? 16 + rnd() * 14 : 30 + rnd() * 26
    p.set(Math.cos(a) * R, 0, Math.sin(a) * R)
    s.set(3 + rnd() * 6, h, 3 + rnd() * 6)
    q.setFromAxisAngle(new Vector3(0, 1, 0), rnd() * Math.PI * 2)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
  }
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

// The far ring with real models: each class is one InstancedMesh (3 low-detail towers, 2 skyscrapers). About 780 towers
// on a seeded ring 300 to 480 units out. Triangles: ~316k. The box ring stays up until these are loaded.
const FAR_LOW = ['low-detail-building-a', 'low-detail-building-c', 'low-detail-building-f']
const FAR_TALL = ['building-skyscraper-b', 'building-skyscraper-d']
const FAR_PALETTE = ['#2a6cff', '#19c6d9', '#c64fae', '#ffb36b', '#7fe7ff', '#6a5cff']

function makeFarRing(models: LoadedModel[], mat: MeshStandardMaterial): InstancedMesh[] {
  const rnd = mulberry32(91)
  const groups = models.map((m) => ({ m, count: m.def.cls === 'skyscraper' ? 60 : 240 }))
  const out: InstancedMesh[] = []
  const m4 = new Matrix4()
  const p = new Vector3()
  const s = new Vector3()
  const q = new Quaternion()
  const up = new Vector3(0, 1, 0)
  const col = new Color()
  for (const { m, count } of groups) {
    const geo = m.geometry.clone()
    const size = new Float32Array(count * 3)
    const lang = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    const zero = new Float32Array(count)
    const mesh0 = new InstancedMesh(geo, mat, count)
    const tall = m.def.cls === 'skyscraper'
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2
      const R = 300 + Math.pow(rnd(), 0.8) * 180
      p.set(Math.cos(a) * R, 0, Math.sin(a) * R)
      // Footprint in world units, height from a skewed distribution: most low, a few towers.
      const w = tall ? 4 + rnd() * 3 : 5 + rnd() * 5
      const k = rnd()
      const h = tall ? 9 + rnd() * 8 : k < 0.75 ? 4 + rnd() * 7 : k < 0.95 ? 12 + rnd() * 8 : 22 + rnd() * 16
      s.set(w, h, w * (0.8 + rnd() * 0.4))
      q.setFromAxisAngle(up, Math.floor(rnd() * 4) * (Math.PI / 2) + (rnd() - 0.5) * 0.2)
      m4.compose(p, q, s)
      mesh0.setMatrixAt(i, m4)
      size[i * 3] = s.x
      size[i * 3 + 1] = s.y
      size[i * 3 + 2] = s.z
      col.set(FAR_PALETTE[Math.floor(rnd() * FAR_PALETTE.length)]!).multiplyScalar(0.7)
      lang[i * 3] = col.r
      lang[i * 3 + 1] = col.g
      lang[i * 3 + 2] = col.b
      seed[i] = rnd()
    }
    geo.setAttribute('aSize', new InstancedBufferAttribute(size, 3))
    geo.setAttribute('aLang', new InstancedBufferAttribute(lang, 3))
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seed, 1))
    geo.setAttribute('aGlow', new InstancedBufferAttribute(zero, 1))
    geo.setAttribute('aGlowColor', new InstancedBufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aSel', new InstancedBufferAttribute(new Float32Array(count), 1))
    geo.setAttribute('aShim', new InstancedBufferAttribute(new Float32Array(count), 1))
    mesh0.instanceMatrix.needsUpdate = true
    mesh0.frustumCulled = false
    out.push(mesh0)
  }
  return out
}

function FarModels({ onReady }: { onReady: (ok: boolean) => void }) {
  const [meshes, setMeshes] = useState<InstancedMesh[] | null>(null)
  const mat = useMemo(() => {
    return createFarSkylineMaterial(skyTime, 0.3)
  }, [])
  useEffect(() => {
    let live = true
    const ids = [...FAR_LOW, ...FAR_TALL]
    loadModels(ids)
      .then((models) => {
        if (!live) return
        prepareModelMaterial(mat, models[0]!.map)
        setMeshes(makeFarRing(models, mat))
        onReady(true)
      })
      .catch((err: unknown) => {
        console.warn('far skyline models unavailable, keeping the boxes', err)
        onReady(false)
      })
    return () => {
      live = false
    }
  }, [mat, onReady])
  useEffect(() => () => {
    mat.dispose()
  }, [mat])
  useEffect(() => () => {
    meshes?.forEach((m) => m.geometry.dispose())
  }, [meshes])
  if (!meshes) return null
  return <>{meshes.map((m, i) => <primitive key={i} object={m} />)}</>
}

// ---- Aviation beacons ------------------------------------------------------------------------------------

const BEACON_VERT = `
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vB;
void main() {
  // Each beacon blinks on its own phase: a sharp pulse, mostly dark.
  float s = pow(0.5 + 0.5 * sin(uTime * 2.4 + aPhase), 6.0);
  vB = s;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (9.0 + 8.0 * s) * uPixelRatio * clamp(260.0 / max(-mv.z, 1.0), 0.6, 2.2);
  gl_Position = projectionMatrix * mv;
}`

const BEACON_FRAG = `
varying float vB;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float core = exp(-r2 * 12.0);
  float halo = exp(-r2 * 3.0) * 0.3;
  float a = (core * 2.0 + halo) * (0.2 + 0.8 * vB);
  gl_FragColor = vec4(vec3(1.0, 0.1, 0.2) * a, 1.0);
}`

function makeBeacons(buildings: readonly { x: number; z: number; w: number; d: number; h: number }[]): BufferGeometry {
  const tallest = buildings.slice().sort((a, b) => b.h - a.h).slice(0, BEACONS)
  const rnd = mulberry32(5)
  const pos = new Float32Array(tallest.length * 3)
  const phase = new Float32Array(tallest.length)
  tallest.forEach((b, i) => {
    pos[i * 3] = b.x + b.w / 2
    pos[i * 3 + 1] = b.h + 0.5
    pos[i * 3 + 2] = b.z + b.d / 2
    phase[i] = rnd() * Math.PI * 2
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aPhase', new BufferAttribute(phase, 1))
  return g
}

export function Backdrop() {
  const layout = useSky((s) => s.layout)
  const ridgeGeo = useMemo(() => makeRidges(), [])
  const ridgeMat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uNear: { value: new Color('#0a1130') },
      uFar: { value: new Color('#16295a') },
      uHorizon: { value: new Color(HORIZON) },
      // Ridges fade less than the far towers: the framed view looks down at the horizon, so they must read against it.
      uFogDensity: { value: BACKDROP_FOG * 0.4 }
    },
    vertexShader: RIDGE_VERT,
    fragmentShader: RIDGE_FRAG,
    side: DoubleSide
  }), [])
  const skyline = useMemo(() => makeSkyline(), [])
  // The box ring shows until the far models are in; then it is dropped.
  const [modelsUp, setModelsUp] = useState(false)
  const beaconGeo = useMemo(() => makeBeacons(layout?.buildings ?? []), [layout])
  const beaconMat = useMemo(() => new ShaderMaterial({
    uniforms: { uTime: skyTime, uPixelRatio: { value: 1 } },
    vertexShader: BEACON_VERT,
    fragmentShader: BEACON_FRAG,
    transparent: true,
    depthWrite: false
  }), [])

  useFrame(({ gl }) => {
    beaconMat.uniforms.uPixelRatio!.value = gl.getPixelRatio()
  })

  useEffect(() => () => {
    ridgeGeo.dispose()
    ridgeMat.dispose()
    skyline.geometry.dispose()
    ;(skyline.material as ShaderMaterial).dispose()
  }, [ridgeGeo, ridgeMat, skyline])

  useEffect(() => () => beaconGeo.dispose(), [beaconGeo])
  useEffect(() => () => beaconMat.dispose(), [beaconMat])

  return (
    <>
      <mesh geometry={ridgeGeo} material={ridgeMat} frustumCulled={false} renderOrder={-6} />
      {!modelsUp && <primitive object={skyline} frustumCulled={false} />}
      <FarModels onReady={setModelsUp} />
      <points geometry={beaconGeo} material={beaconMat} frustumCulled={false} renderOrder={4} />
    </>
  )
}
