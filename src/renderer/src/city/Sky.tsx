// Night sky: one dome shader carries the horizon light-pollution band, a Milky Way lane, the moon and the
// shooting stars. A dense twinkling star field and a slow aurora curtain sit on top of it. Every animation reads
// the shared clock skyTime (frozen under reduced motion, which also turns the shooting stars off). The reflection
// environment is generated once from the same gradient, so glass reflects the night.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Mesh,
  MeshBasicMaterial, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3
} from 'three'
import { useSky } from '../state/store'

/** Fog color. The horizon of the sky dome matches it so the city dissolves into the night. */
export const FOG_HEX = '#0b1430'
export const FOG_DENSITY = 0.0042

/** The one clock for every atmosphere shader (Sky, Atmosphere, Backdrop). Sky writes it each frame. */
export const skyTime = { value: 0 }

/** Shared 3D value noise and fbm for the atmosphere shaders. */
export const NOISE_GLSL = `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0)), d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0)), g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0)), k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(17.1, 4.3, 9.7);
    a *= 0.5;
  }
  return s;
}`

/** Vertex shader for the direction-keyed shells: passes the unit-sphere position through as the view direction. */
export const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/** Seeded PRNG, so the stars, ridges and far skyline are identical on every launch. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Moon direction (unit, in the sky dome). Above the horizon, toward the far side of the city. */
export const MOON_DIR = new Vector3(-0.62, 0.13, -0.78).normalize()
const MOON_RADIUS = 0.07

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uGlowA;
uniform vec3 uGlowB;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uShootA;
uniform vec3 uShootB;
uniform float uTime;
uniform float uDetail;
uniform float uMoonSize;
uniform float uShootT0;
uniform float uShootLen;
uniform float uShootOn;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
  col = mix(uBottom, col, smoothstep(-0.2, 0.0, h));

  // Light pollution: a broad band hugging the horizon, teal with magenta drifting through it.
  float az = atan(d.z, d.x);
  float drift = vnoise(vec3(cos(az), sin(az), h * 0.7) * 1.6 + vec3(3.1, 0.0, 0.0));
  vec3 glow = mix(uGlowA, uGlowB, smoothstep(0.6, 0.9, drift));
  float band = exp(-max(h, 0.0) * 6.5) * 0.42 + exp(-abs(h) * 40.0) * 0.26;
  col += glow * band;

  if (uDetail > 0.5) {
    // Milky Way lane along a tilted great circle.
    vec3 n = normalize(vec3(0.35, 0.8, 0.45));
    float lane = dot(d, n);
    float dust = fbm3(d * 4.0 + vec3(0.0, 2.0, 0.0));
    col += vec3(0.16, 0.2, 0.34) * exp(-lane * lane * 22.0) * smoothstep(0.25, 0.8, dust) * 0.4;

    // Moon: tight corona, wide faint veil, and a cratered disc with limb darkening.
    float dm = length(d - uMoonDir);
    float r = uMoonSize;
    float dOut = max(dm - r, 0.0);
    col += uMoonCol * (exp(-dOut * 30.0) * 0.16 + exp(-dOut * 9.0) * 0.03);
    float disc = 1.0 - smoothstep(r * 0.985, r, dm);
    if (disc > 0.0) {
      float mu = sqrt(max(0.0, 1.0 - (dm * dm) / (r * r)));
      float mare = smoothstep(0.45, 0.72, fbm3(d * 7.0 + 4.0));
      float craters = smoothstep(0.68, 0.8, vnoise(d * 46.0)) * 0.6 + smoothstep(0.7, 0.85, vnoise(d * 15.0)) * 0.35;
      float surf = 0.94 - 0.22 * mare - 0.1 * craters;
      vec3 moon = uMoonCol * surf * (0.45 + 0.55 * mu) * 0.8;
      col = mix(col, moon, disc);
    }

    // One shooting star at a time: a thin head with a fading tail along the arc from A to B.
    float life = (uTime - uShootT0) / uShootLen;
    if (uShootOn > 0.5 && life > 0.0 && life < 1.0) {
      float head = life * 1.15;
      vec3 ab = uShootB - uShootA;
      float u = clamp(dot(d - uShootA, ab) / dot(ab, ab), 0.0, 1.0);
      float dist = length(d - (uShootA + ab * u));
      float tail = smoothstep(head - 0.35, head, u) * step(u, head);
      float core = exp(-dist * dist * 9000.0);
      float hd = length(d - (uShootA + ab * min(head, 1.0)));
      float spark = exp(-hd * hd * 7000.0) * 1.4 + exp(-hd * 70.0) * 0.25;
      col += vec3(0.8, 0.95, 1.0) * (core * tail * 1.1 + spark) * sin(life * 3.14159);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`

/** The night dome. detail = false is the reflection environment (no moon, shooting stars or Milky Way). */
export function makeSkyMaterial(detail = true): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTop: { value: new Color('#02040b') },
      uHorizon: { value: new Color('#1a2a52') },
      uBottom: { value: new Color('#0b1430') },
      uGlowA: { value: new Color('#19c6d9') },
      uGlowB: { value: new Color('#c64fae') },
      uMoonDir: { value: MOON_DIR.clone() },
      uMoonCol: { value: new Color('#cfdcf5') },
      uMoonSize: { value: MOON_RADIUS },
      uTime: skyTime,
      uDetail: { value: detail ? 1 : 0 },
      uShootA: { value: new Vector3(0, 1, 0) },
      uShootB: { value: new Vector3(0, 1, 0) },
      uShootT0: { value: -100 },
      uShootLen: { value: 1.4 },
      uShootOn: { value: 0 }
    },
    vertexShader: DOME_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    depthTest: false
  })
}

const STAR_VERT = `
attribute float aSize;
attribute float aPhase;
attribute float aRate;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vA;
void main() {
  float tw = 0.7 + 0.3 * sin(uTime * aRate + aPhase);
  vec3 dir = normalize(position);
  vA = tw * smoothstep(-0.03, 0.12, dir.y);
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * (0.8 + 0.2 * tw);
}`

const STAR_FRAG = `
varying vec3 vColor;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float g = exp(-dot(p, p) * 3.2);
  gl_FragColor = vec4(vColor, g * vA);
}`

/** A few thousand stars on a shell inside the dome. Sizes, tints and twinkle phases are seeded. */
function makeStarField(): BufferGeometry {
  const rnd = mulberry32(7)
  const n = 4200
  const pos = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const phase = new Float32Array(n)
  const rate = new Float32Array(n)
  const col = new Float32Array(n * 3)
  const R = 760
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1
    const t = rnd() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    pos[i * 3] = s * Math.cos(t) * R
    pos[i * 3 + 1] = u * R
    pos[i * 3 + 2] = s * Math.sin(t) * R
    const k = rnd()
    size[i] = k < 0.9 ? 1 + rnd() * 0.7 : k < 0.99 ? 1.9 + rnd() * 0.9 : 3 + rnd() * 1.4
    phase[i] = rnd() * Math.PI * 2
    rate[i] = 0.5 + rnd() * 1.8
    const tint = rnd()
    const b = 0.3 + 0.7 * rnd() * rnd()
    // Mostly white, some blue-white, a few warm.
    const r = tint < 0.7 ? 0.92 : tint < 0.9 ? 0.6 : 1.0
    const g = tint < 0.7 ? 0.95 : tint < 0.9 ? 0.76 : 0.85
    const bl = tint < 0.7 ? 1.0 : tint < 0.9 ? 1.0 : 0.72
    col[i * 3] = r * b
    col[i * 3 + 1] = g * b
    col[i * 3 + 2] = bl * b
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('aSize', new BufferAttribute(size, 1))
  geo.setAttribute('aPhase', new BufferAttribute(phase, 1))
  geo.setAttribute('aRate', new BufferAttribute(rate, 1))
  geo.setAttribute('aColor', new BufferAttribute(col, 3))
  return geo
}

const AURORA_FRAG = `
uniform float uTime;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float band = smoothstep(0.02, 0.2, h) * (1.0 - smoothstep(0.45, 0.8, h));
  float az = atan(d.z, d.x);
  float t = uTime * 0.035;
  // Curtains: noise stretched vertically on a seamless ring, drifting sideways.
  vec3 q = vec3(cos(az) * 1.8, sin(az) * 1.8, h * 2.2 - t * 1.5) + vec3(t, 0.0, 0.0);
  float n = fbm3(q);
  float curtain = smoothstep(0.42, 0.8, n);
  // Fine vertical rays inside each curtain.
  float rays = 0.55 + 0.45 * sin(az * 60.0 + fbm3(q * vec3(1.0, 0.4, 1.0) * 2.0) * 9.0 + t * 4.0);
  float a = band * curtain * rays;
  vec3 col = mix(vec3(0.12, 0.95, 0.8), vec3(0.55, 0.3, 1.0), smoothstep(0.2, 0.55, h + 0.1 * n));
  gl_FragColor = vec4(col * a * 0.42, 1.0);
}`

function makeAuroraMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: skyTime },
    vertexShader: DOME_VERT,
    fragmentShader: AURORA_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
}

// Scratch vectors for scheduling shooting stars (no per-frame allocation).
const shotA = new Vector3()
const shotB = new Vector3()

export function Sky() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const sky = useMemo(() => makeSkyMaterial(true), [])
  const stars = useMemo(() => makeStarField(), [])
  const starMat = useMemo(() => new ShaderMaterial({
    uniforms: { uTime: skyTime, uPixelRatio: { value: 1 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])
  const aurora = useMemo(() => makeAuroraMaterial(), [])
  const auroraGeo = useMemo(() => new CylinderGeometry(560, 560, 1000, 128, 1, true), [])
  const nextShot = useRef(3 + Math.random() * 4)

  // Reflection environment, rendered once from the sky gradient and a few procedural softboxes.
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const env = new Scene()
    env.add(new Mesh(new SphereGeometry(50, 32, 16), makeSkyMaterial(false)))
    const box = (color: string, intensity: number, pos: [number, number, number], w: number, h: number) => {
      const m = new Mesh(
        new SphereGeometry(1, 8, 8),
        new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) })
      )
      m.scale.set(w, h, 1)
      m.position.set(...pos)
      m.lookAt(new Vector3(0, 0, 0))
      env.add(m)
    }
    box('#8fb4ff', 2.2, [30, 22, 25], 6, 3)
    box('#ff7ad9', 1.6, [-35, 14, -30], 5, 2.5)
    box('#22d3ee', 1.2, [0, 40, -10], 7, 2)
    const tex = pmrem.fromScene(env, 0.02).texture
    scene.environment = tex
    pmrem.dispose()
    return () => {
      if (scene.environment === tex) scene.environment = null
      tex.dispose()
    }
  }, [gl, scene])

  useEffect(() => () => {
    sky.dispose()
    starMat.dispose()
    aurora.dispose()
    stars.dispose()
    auroraGeo.dispose()
  }, [sky, starMat, aurora, stars, auroraGeo])

  // Runs before the other atmosphere layers so they read this frame's clock.
  useFrame(({ clock, gl: renderer }) => {
    const reduced = useSky.getState().reducedMotion
    const t = reduced ? 0 : clock.elapsedTime
    skyTime.value = t
    starMat.uniforms.uPixelRatio!.value = renderer.getPixelRatio()
    if (reduced || t < nextShot.current) return
    // One shooting star: a short streak across the upper sky, then 8 to 15 seconds of quiet.
    const az = Math.random() * Math.PI * 2
    shotA.set(Math.cos(az), 0.35 + Math.random() * 0.45, Math.sin(az)).normalize()
    shotB.set(
      shotA.x + (Math.random() - 0.5) * 0.8,
      shotA.y - 0.25 - Math.random() * 0.2,
      shotA.z + (Math.random() - 0.5) * 0.8
    ).normalize()
    sky.uniforms.uShootA!.value.copy(shotA)
    sky.uniforms.uShootB!.value.copy(shotB)
    sky.uniforms.uShootT0!.value = t
    sky.uniforms.uShootOn!.value = 1
    nextShot.current = t + 8 + Math.random() * 7
  }, -1)

  return (
    <>
      <mesh material={sky} renderOrder={-10} frustumCulled={false} scale={1100}>
        <sphereGeometry args={[1, 48, 24]} />
      </mesh>
      <points geometry={stars} material={starMat} frustumCulled={false} renderOrder={-9} />
      <mesh geometry={auroraGeo} material={aurora} frustumCulled={false} renderOrder={-8} />
      <hemisphereLight args={['#5b7cff', '#03040a', 0.45]} />
      <directionalLight position={[-60, 120, 50]} intensity={1.0} color="#cfe0ff" />
      <directionalLight position={[80, 40, -60]} intensity={0.5} color="#ff7ad9" />
    </>
  )
}
