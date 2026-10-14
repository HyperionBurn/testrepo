// Atmosphere: three slow ground-fog banks lit by the city, a cloud shell high above it (lit from below, teal and
// magenta), and a few hundred dust motes around the camera for depth. Five draw calls in total. All motion is in the
// shaders on the shared clock skyTime, so reduced motion (which freezes that clock) makes it all static.
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, PlaneGeometry, ShaderMaterial, SphereGeometry, Vector3
} from 'three'
import { DOME_VERT, NOISE_GLSL, mulberry32, skyTime } from './Sky'

const FOG_BANK_FRAG = `
uniform float uTime;
uniform float uScale;
uniform float uSpeed;
uniform float uAlpha;
uniform float uSeed;
uniform vec3 uBank;
uniform vec3 uTeal;
uniform vec3 uMag;
varying vec3 vW;
${NOISE_GLSL}
void main() {
  vec2 p = vW.xz;
  float t = uTime * uSpeed;
  float n = fbm3(vec3(p * uScale + vec2(t, -0.6 * t), uSeed)) * 0.75
    + fbm3(vec3(p * uScale * 2.6 - vec2(1.7 * t, 0.0), uSeed + 5.0)) * 0.25;
  float bank = smoothstep(0.4, 0.8, n);
  float r = length(p);
  // City light pools in the middle and tints the fog; the far fog stays cold.
  float lit = exp(-r * 0.009);
  float mag = smoothstep(0.45, 0.7, fbm3(vec3(p * 0.004, uSeed + 9.0)));
  vec3 glow = mix(uTeal, uMag, mag * 0.6);
  vec3 col = mix(uBank, glow, lit * 0.8);
  float edge = 1.0 - smoothstep(160.0, 520.0, r);
  gl_FragColor = vec4(col, bank * uAlpha * edge);
}`

const CLOUD_FRAG = `
uniform float uTime;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float band = smoothstep(0.1, 0.3, h) * (1.0 - smoothstep(0.6, 0.9, h));
  // Stretched horizontally so the cover reads as sheets, drifting very slowly.
  vec3 p = vec3(d.x, d.y * 0.45, d.z) * 3.2 + vec3(uTime * 0.01, 0.0, uTime * 0.006);
  float cloud = smoothstep(0.5, 0.85, fbm3(p));
  // Lit from below: the underside glows, cyan low and magenta high.
  float under = 1.0 - smoothstep(0.15, 0.55, h);
  vec3 tint = mix(vec3(0.2, 0.9, 1.0), vec3(1.0, 0.4, 0.85), smoothstep(0.25, 0.65, h));
  gl_FragColor = vec4(tint * (0.35 + 0.65 * under), cloud * band * 0.22);
}`

const MOTE_VERT = `
attribute vec3 aSeed;
attribute float aSize;
uniform vec3 uCam;
uniform float uTime;
uniform float uPixelRatio;
varying float vA;
const vec3 BOX = vec3(140.0, 70.0, 140.0);
void main() {
  // Each mote keeps a fixed spot in a box that wraps around the camera, so the field never empties.
  vec3 base = (aSeed - 0.5) * BOX;
  base += vec3(sin(uTime * 0.13 + aSeed.x * 40.0), sin(uTime * 0.09 + aSeed.y * 30.0) * 0.6, cos(uTime * 0.11 + aSeed.z * 50.0)) * 3.0;
  vec3 rel = mod(base - uCam + BOX * 0.5, BOX) - BOX * 0.5;
  vec3 w = uCam + rel;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  float dist = -mv.z;
  vA = smoothstep(4.0, 14.0, dist) * (1.0 - smoothstep(70.0, 100.0, dist)) * (0.3 + 0.7 * aSeed.z);
  gl_PointSize = aSize * uPixelRatio * clamp(120.0 / max(dist, 1.0), 0.8, 3.0);
  gl_Position = projectionMatrix * mv;
}`

const MOTE_FRAG = `
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float g = exp(-dot(p, p) * 4.0);
  gl_FragColor = vec4(vec3(0.7, 0.85, 1.0), g * vA * 0.45);
}`

const FOG_BANKS = [
  { y: 0.8, scale: 0.0075, speed: 0.012, alpha: 0.16, seed: 1.3 },
  { y: 1.8, scale: 0.0055, speed: -0.008, alpha: 0.12, seed: 7.9 },
  { y: 3.0, scale: 0.0105, speed: 0.02, alpha: 0.08, seed: 14.2 }
] as const

const MOTE_COUNT = 360

function makeFogMaterial(b: (typeof FOG_BANKS)[number]): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uScale: { value: b.scale },
      uSpeed: { value: b.speed },
      uAlpha: { value: b.alpha },
      uSeed: { value: b.seed },
      uBank: { value: new Color('#1b2c58') },
      uTeal: { value: new Color('#2fb8c8') },
      uMag: { value: new Color('#9a4fc4') }
    },
    vertexShader: `varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: FOG_BANK_FRAG,
    transparent: true,
    depthWrite: false
  })
}

function makeMoteGeometry(): BufferGeometry {
  const rnd = mulberry32(31)
  const seed = new Float32Array(MOTE_COUNT * 3)
  const size = new Float32Array(MOTE_COUNT)
  const pos = new Float32Array(MOTE_COUNT * 3)
  for (let i = 0; i < MOTE_COUNT; i++) {
    seed[i * 3] = rnd()
    seed[i * 3 + 1] = rnd()
    seed[i * 3 + 2] = rnd()
    size[i] = 1.2 + rnd() * 1.6
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new BufferAttribute(seed, 3))
  g.setAttribute('aSize', new BufferAttribute(size, 1))
  return g
}

export function Atmosphere() {
  const banks = useMemo(() => FOG_BANKS.map((b) => ({ y: b.y, mat: makeFogMaterial(b) })), [])
  const bankGeo = useMemo(() => new PlaneGeometry(1500, 1500), [])
  const cloudMat = useMemo(() => new ShaderMaterial({
    uniforms: { uTime: skyTime },
    vertexShader: DOME_VERT,
    fragmentShader: CLOUD_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false
  }), [])
  const cloudGeo = useMemo(() => new SphereGeometry(880, 48, 24), [])
  const moteGeo = useMemo(() => makeMoteGeometry(), [])
  const moteMat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uCam: { value: new Vector3() },
      uPixelRatio: { value: 1 }
    },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])

  useFrame(({ camera, gl }) => {
    moteMat.uniforms.uCam!.value.copy(camera.position)
    moteMat.uniforms.uPixelRatio!.value = gl.getPixelRatio()
  })

  useEffect(() => () => {
    for (const b of banks) b.mat.dispose()
    bankGeo.dispose()
    cloudMat.dispose()
    cloudGeo.dispose()
    moteGeo.dispose()
    moteMat.dispose()
  }, [banks, bankGeo, cloudMat, cloudGeo, moteGeo, moteMat])

  return (
    <>
      {banks.map((b) => (
        <mesh
          key={b.y}
          geometry={bankGeo}
          material={b.mat}
          position={[0, b.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          frustumCulled={false}
          renderOrder={-2}
        />
      ))}
      <mesh geometry={cloudGeo} material={cloudMat} frustumCulled={false} renderOrder={-3} />
      <points geometry={moteGeo} material={moteMat} frustumCulled={false} renderOrder={3} />
    </>
  )
}
