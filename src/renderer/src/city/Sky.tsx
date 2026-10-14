// Sky for New York at night. One dome shader carries the gradient (zenith to teal to the orange-pink horizon band,
// or near-black with a warm light-pollution band at night, or lilac to peach at dawn), thin wisps lit by the last
// light and a small moon. A sparse star field sits only near the zenith and shooting stars are rare. The time of
// day is a preset (skyPresets.ts): changes blend over ~2 s, and the blended values are written to shared uniforms
// (colorU, levelU) that Atmosphere also reads. The scene fog follows the horizon colour so distant geometry melts
// into the glow. Every animation reads the shared clock skyTime (frozen under reduced motion, which also turns the
// shooting stars off).
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight, Mesh,
  MeshBasicMaterial, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, SRGBColorSpace, Texture, Vector3,
  WebGLRenderer
} from 'three'
import { useSky } from '../state/store'
import {
  COLOR_KEYS, LEVEL_KEYS, PresetTransition, type ColorKey, type LevelKey, type ResolvedPreset
} from './skyPresets'

/** Fog colour at blue hour. The live fog follows the horizon of the current preset (see Sky below). */
export const FOG_HEX = '#3a4c74'
export const FOG_DENSITY = 0.0042

/** The one clock for every atmosphere shader (Sky, Atmosphere, Backdrop). Sky writes it each frame. */
export const skyTime = { value: 0 }

const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1)

/** Shared colour uniforms, one per preset colour. Sky writes them, Atmosphere and the sky materials read them. */
export const colorU = Object.fromEntries(COLOR_KEYS.map((k) => [k, { value: new Color() }])) as Record<ColorKey, { value: Color }>
/** Shared scalar uniforms, one per preset level. */
export const levelU = Object.fromEntries(LEVEL_KEYS.map((k) => [k, { value: 0 }])) as Record<LevelKey, { value: number }>

/** Every shared uniform under its shader name (uZenith, uStar, ...). Spread these into a ShaderMaterial. */
export const skyUniforms: Record<string, { value: Color | number }> = {}
for (const k of COLOR_KEYS) skyUniforms[`u${cap(k)}`] = colorU[k]
for (const k of LEVEL_KEYS) skyUniforms[`u${cap(k)}`] = levelU[k]

/** Writes a resolved preset into the shared uniforms. */
function applyResolved(r: ResolvedPreset): void {
  for (const k of COLOR_KEYS) {
    const c = r.colors[k]
    colorU[k].value.setRGB(c[0], c[1], c[2], SRGBColorSpace)
  }
  for (const k of LEVEL_KEYS) levelU[k].value = r.levels[k]
}

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

/** Seeded PRNG, so the stars and ridges are identical on every launch. */
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
const MOON_RADIUS = 0.035

const SKY_FRAG = `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uTeal;
uniform vec3 uHorizon;
uniform vec3 uBandA;
uniform vec3 uBandB;
uniform vec3 uBelow;
uniform vec3 uWisp;
uniform float uBand;
uniform float uWisps;
uniform float uMoon;
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

  // Gradient: teal and horizon at the ground, mid blue and zenith overhead.
  vec3 col = mix(uHorizon, uTeal, smoothstep(0.0, 0.12, h));
  col = mix(col, uMid, smoothstep(0.08, 0.34, h));
  col = mix(col, uZenith, smoothstep(0.3, 0.72, h));
  col = mix(uBelow, col, smoothstep(-0.05, 0.0, h));

  // Horizon band: strong at the line, fading up, drifting between two colours around the compass.
  float az = atan(d.z, d.x);
  float drift = vnoise(vec3(cos(az), sin(az), h * 0.7) * 1.6 + vec3(3.1, 0.0, 0.0));
  vec3 band = mix(uBandA, uBandB, smoothstep(0.55, 0.85, drift));
  float bandAmt = (exp(-max(h, 0.0) * 9.0) * 0.55 + exp(-abs(h) * 45.0) * 0.35) * uBand;
  col += band * bandAmt;

  // Thin wisps low in the sky, lit by the last light: streaked and sparse (high threshold).
  float wband = smoothstep(0.015, 0.07, h) * (1.0 - smoothstep(0.16, 0.42, h));
  vec3 wp = vec3(d.x * 2.2, d.y * 7.0, d.z * 2.2) + vec3(uTime * 0.006, 0.0, uTime * 0.003);
  float wisp = smoothstep(0.56, 0.9, fbm3(wp));
  col = mix(col, uWisp, wisp * wband * uWisps * 0.6);

  if (uDetail > 0.5) {
    // Small moon: a faint corona and a cratered disc with limb darkening. Fades with the preset.
    float dm = length(d - uMoonDir);
    float r = uMoonSize;
    float dOut = max(dm - r, 0.0);
    col += uMoonCol * (exp(-dOut * 34.0) * 0.12 + exp(-dOut * 10.0) * 0.02) * uMoon;
    float disc = (1.0 - smoothstep(r * 0.985, r, dm)) * uMoon;
    if (disc > 0.0) {
      float mu = sqrt(max(0.0, 1.0 - (dm * dm) / (r * r)));
      float mare = smoothstep(0.45, 0.72, fbm3(d * 7.0 + 4.0));
      float craters = smoothstep(0.68, 0.8, vnoise(d * 46.0)) * 0.6;
      float surf = 0.94 - 0.22 * mare - 0.1 * craters;
      vec3 moon = uMoonCol * surf * (0.45 + 0.55 * mu) * 0.8;
      col = mix(col, moon, disc);
    }

    // One shooting star at a time (they are rare): a thin head with a fading tail along the arc from A to B.
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

/** The sky dome. detail = false is the reflection environment (no moon or shooting stars). */
export function makeSkyMaterial(detail = true): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      ...skyUniforms,
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
uniform float uStar;
varying vec3 vColor;
varying float vA;
void main() {
  float tw = 0.7 + 0.3 * sin(uTime * aRate + aPhase);
  vec3 dir = normalize(position);
  // Stars show only high in the sky: the zenith, not the whole dome.
  vA = tw * smoothstep(0.45, 0.8, dir.y) * uStar;
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

/** A sparse set of small stars on a shell inside the dome. Sizes, tints and twinkle phases are seeded. */
function makeStarField(): BufferGeometry {
  const rnd = mulberry32(7)
  const n = 320
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
    size[i] = k < 0.92 ? 0.9 + rnd() * 0.6 : 1.6 + rnd() * 0.8
    phase[i] = rnd() * Math.PI * 2
    rate[i] = 0.5 + rnd() * 1.8
    const tint = rnd()
    const b = 0.3 + 0.6 * rnd() * rnd()
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

/**
 * The reflection environment: the sky gradient (no moon) and three soft boxes for glass. Built from the current
 * shared uniforms, so it is rebuilt once a time-of-day change has settled.
 */
function buildEnvironment(gl: WebGLRenderer): Texture {
  const pmrem = new PMREMGenerator(gl)
  const env = new Scene()
  const sphere = new Mesh(new SphereGeometry(50, 32, 16), makeSkyMaterial(false))
  env.add(sphere)
  const dim = levelU.keyI.value
  const box = (color: string, intensity: number, pos: [number, number, number], w: number, h: number) => {
    const m = new Mesh(
      new SphereGeometry(1, 8, 8),
      new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity * dim) })
    )
    m.scale.set(w, h, 1)
    m.position.set(...pos)
    m.lookAt(new Vector3(0, 0, 0))
    env.add(m)
  }
  box('#8fb4ff', 2.2, [30, 22, 25], 6, 3)
  box('#ff9a4a', 1.6, [-35, 14, -30], 5, 2.5)
  box('#7fb8d8', 1.2, [0, 40, -10], 7, 2)
  const tex = pmrem.fromScene(env, 0.02).texture
  pmrem.dispose()
  sphere.geometry.dispose()
  ;(sphere.material as ShaderMaterial).dispose()
  return tex
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
    uniforms: { uTime: skyTime, uPixelRatio: { value: 1 }, uStar: levelU.star },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])
  const transition = useMemo(() => new PresetTransition(useSky.getState().timeOfDay), [])
  const hemi = useRef<HemisphereLight>(null)
  const key = useRef<DirectionalLight>(null)
  const rim = useRef<DirectionalLight>(null)
  const envFor = useRef<string | null>(null)
  const envTex = useRef<Texture | null>(null)
  const nextShot = useRef(20 + Math.random() * 40)

  // Starts from the current preset: write the uniforms, then build the reflections once.
  useEffect(() => {
    applyResolved(transition.current)
    envTex.current = buildEnvironment(gl)
    scene.environment = envTex.current
    envFor.current = transition.target
    return () => {
      if (scene.environment === envTex.current) scene.environment = null
      envTex.current?.dispose()
      envTex.current = null
    }
  }, [gl, scene, transition])

  useEffect(() => () => {
    sky.dispose()
    starMat.dispose()
    stars.dispose()
  }, [sky, starMat, stars])

  // Runs before the other atmosphere layers so they read this frame's clock and colours.
  useFrame(({ clock, gl: renderer, scene: s }, dt) => {
    const st = useSky.getState()
    const reduced = st.reducedMotion
    const t = reduced ? 0 : clock.elapsedTime
    skyTime.value = t
    starMat.uniforms.uPixelRatio!.value = renderer.getPixelRatio()

    // Time of day: a change blends over ~2 s (at once under reduced motion).
    transition.setTarget(st.timeOfDay, !reduced)
    const moving = transition.step(dt)
    applyResolved(transition.current)

    // The fog takes the horizon colour, so distant buildings melt into the glow of the current preset.
    const fog = s.fog as { color: Color } | null
    fog?.color.copy(colorU.fog.value)

    // Scene light follows the preset.
    if (hemi.current) {
      hemi.current.color.copy(colorU.hemiSky.value)
      hemi.current.groundColor.copy(colorU.hemiGround.value)
      hemi.current.intensity = levelU.hemi.value
    }
    if (key.current) {
      key.current.color.copy(colorU.key.value)
      key.current.intensity = levelU.keyI.value
    }
    if (rim.current) {
      rim.current.color.copy(colorU.bandB.value)
      rim.current.intensity = levelU.keyI.value * 0.5
    }

    // Reflections are rebuilt once the change has settled.
    if (!moving && envFor.current !== transition.target) {
      envTex.current?.dispose()
      envTex.current = buildEnvironment(gl)
      s.environment = envTex.current
      envFor.current = transition.target
    }

    if (reduced || t < nextShot.current) return
    // One shooting star: a short streak across the upper sky, then 45 to 120 seconds of quiet (they are rare).
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
    nextShot.current = t + 45 + Math.random() * 75
  }, -1)

  return (
    <>
      <mesh material={sky} renderOrder={-10} frustumCulled={false} scale={1100}>
        <sphereGeometry args={[1, 48, 24]} />
      </mesh>
      <points geometry={stars} material={starMat} frustumCulled={false} renderOrder={-9} />
      <hemisphereLight ref={hemi} args={['#5b7cff', '#03040a', 0.45]} />
      <directionalLight ref={key} position={[-60, 120, 50]} intensity={1.0} color="#cfe0ff" />
      <directionalLight ref={rim} position={[80, 40, -60]} intensity={0.5} color="#ff7ad9" />
    </>
  )
}
