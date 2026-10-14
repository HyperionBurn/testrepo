// Water: the two rivers either side of the island (the Hudson to the west, the East River to the east), the embankment
// with piers and a row of lamps on each bank, and the far banks' light carpet. The water is one analytic shader: a sky
// reflection with fresnel, slow moving ripple normals, and long vertical light streaks keyed to the shore lights, bent by
// the ripples. Nothing per frame on the JS side except the shared clock. One draw call per river, plus piers, lamps and carpet.
import { useEffect, useMemo } from 'react'
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, InstancedMesh, Matrix4,
  Mesh, MeshBasicMaterial, PlaneGeometry, Points, PointsMaterial, ShaderMaterial, Vector4
} from 'three'
import { FOG_HEX, skyTime } from './Sky'
import { BRIDGES, HAZE_DENSITY, METRO_RADIUS, RIVER_INNER, RIVER_OUTER } from './metro'

const LIGHT_COUNT = 36
const WATER_Y = 0
const RIVER_CENTRE = (RIVER_INNER + RIVER_OUTER) / 2
const RIVER_LEN = 4000
const DEEP = new Color('#02050c')

/** Shore lights that reflect in the water: 8 along each of the four banks (island and far bank, both sides). */
export function shoreLights(): Array<{ x: number; z: number; i: number }> {
  const out: Array<{ x: number; z: number; i: number }> = []
  for (const edge of [-RIVER_INNER, RIVER_INNER, -RIVER_OUTER, RIVER_OUTER]) {
    const far = Math.abs(edge) === RIVER_OUTER
    for (let k = 0; k < 8; k++) {
      out.push({ x: edge + (edge < 0 ? -2 : 2), z: -1400 + k * 400 + (far ? 120 : 0), i: far ? 0.45 : 0.75 })
    }
  }
  // Bridge tower bases stand in the water: warm, bright reflections under each tower.
  for (const b of BRIDGES) {
    for (const tx of b.towers) out.push({ x: tx, z: b.deckZ, i: 1.0 })
  }
  return out.slice(0, LIGHT_COUNT)
}

const WATER_VERT = `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const WATER_FRAG = `
#define NL ${LIGHT_COUNT}
uniform vec4 uLights[NL];
uniform float uTime;
uniform vec3 uHaze;
uniform vec3 uDeep;
uniform float uFogK;
varying vec3 vW;

// Four analytic waves: height gradient for the normal, no texture reads. Each wave fades out once its wavelength is
// under about 2 to 6 pixels (from the screen derivatives of p), so distant water is smooth and never moires.
float waveWeight(float k, float px) {
  return smoothstep(2.0, 6.0, (6.2831853 / k) / px);
}
vec2 ripple(vec2 p, float t, float px) {
  vec2 g = vec2(0.0);
  vec2 d1 = vec2(1.0, 0.2); float k1 = 0.35; float a1 = 0.05; float s1 = 0.9;
  vec2 d2 = vec2(-0.3, 1.0); float k2 = 0.52; float a2 = 0.035; float s2 = 1.3;
  vec2 d3 = vec2(0.7, 0.7); float k3 = 1.1; float a3 = 0.018; float s3 = 2.1;
  vec2 d4 = vec2(-0.9, -0.4); float k4 = 2.3; float a4 = 0.008; float s4 = 3.3;
  g += waveWeight(k1, px) * a1 * k1 * cos(k1 * dot(d1, p) + s1 * t) * d1;
  g += waveWeight(k2, px) * a2 * k2 * cos(k2 * dot(d2, p) + s2 * t) * d2;
  g += waveWeight(k3, px) * a3 * k3 * cos(k3 * dot(d3, p) + s3 * t) * d3;
  g += waveWeight(k4, px) * a4 * k4 * cos(k4 * dot(d4, p) + s4 * t) * d4;
  return g;
}

void main() {
  vec2 p = vW.xz;
  float px = max(length(fwidth(p)), 1e-4);
  vec2 grad = ripple(p, uTime, px);
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 V = normalize(cameraPosition - vW);
  vec3 R = reflect(-V, n);

  // Sky reflection: warm near the horizon, deep navy overhead.
  vec3 hz = mix(uHaze * 1.8, vec3(0.62, 0.36, 0.2), 0.5);
  vec3 top = vec3(0.02, 0.03, 0.085);
  vec3 refl = mix(hz, top, smoothstep(0.0, 0.35, R.y));
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 col = mix(uDeep, refl, clamp(fres * 1.5, 0.0, 1.0));

  // Vertical light streaks: each shore light's reflection lies on the water between the light and the camera's foot,
  // stretched toward the camera. Ripples wobble the streak edges.
  vec3 c = cameraPosition;
  float hL = 14.0;
  for (int i = 0; i < NL; i++) {
    vec4 L = uLights[i];
    if (L.z <= 0.0) continue;
    vec2 q = c.xz + (L.xy - c.xz) * (c.y / (c.y + hL));
    vec2 toC = c.xz - q;
    vec2 dC = toC / max(length(toC), 1e-3);
    vec2 rel = p - q;
    float along = dot(rel, dC);
    float perp = length(rel - dC * along);
    perp += 0.35 * sin(p.y * 1.7 + uTime * 2.0 + float(i) * 1.3) + 0.2 * grad.x * 20.0;
    float wid = 0.9 + 0.00045 * max(along, 0.0);
    float streak = exp(-(perp * perp) / (wid * wid)) * smoothstep(-6.0, 4.0, along) * (1.0 - smoothstep(40.0, 110.0, along));
    float warm = mix(1.0, 0.82, step(0.5, fract(float(i) * 0.37)));
    col += vec3(1.0, 0.62 * warm, 0.3 * warm) * streak * L.z * 0.42 * fres * 6.0;
  }

  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogK, 2.0));
  gl_FragColor = vec4(mix(col, uHaze, fog), 1.0);
}`

function waterMesh(cx: number, mat: ShaderMaterial): Mesh {
  const g = new PlaneGeometry(RIVER_OUTER - RIVER_INNER, RIVER_LEN, 1, 1)
  g.rotateX(-Math.PI / 2)
  const m = new Mesh(g, mat)
  m.position.set(cx, WATER_Y, 0)
  m.frustumCulled = false
  return m
}

/** Piers in the river along each bank: one instanced mesh of stone blocks. */
function piers(): InstancedMesh {
  const edges = [-RIVER_INNER, RIVER_INNER, -RIVER_OUTER, RIVER_OUTER]
  const per = 60
  const geo = new BoxGeometry(1, 1, 1)
  geo.translate(0, 0.5, 0)
  const mat = new MeshBasicMaterial({ color: new Color('#0b0d14') })
  const mesh = new InstancedMesh(geo, mat, edges.length * per)
  const m = new Matrix4()
  let n = 0
  for (const edge of edges) {
    const inward = edge < 0 ? 1 : -1
    for (let k = 0; k < per; k++) {
      const z = -1800 + (k + 0.5) * (3600 / per)
      // A pier stands just off the bank: 12 wide in x, 6 deep in z, 3 units above the water.
      m.makeScale(12, 3, 6)
      m.setPosition(edge + inward * 5, WATER_Y - 0.5, z)
      mesh.setMatrixAt(n++, m)
    }
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
  return mesh
}

/** Lamp heads along each bank, one Points object. */
function lamps(): Points {
  const edges = [-RIVER_INNER, RIVER_INNER, -RIVER_OUTER, RIVER_OUTER]
  const pos: number[] = []
  const col: number[] = []
  for (const edge of edges) {
    const inward = edge < 0 ? 1 : -1
    for (let z = -1800; z <= 1800; z += 34) {
      pos.push(edge + inward * 3, 9.5, z)
      col.push(1.0, 0.7, 0.36)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  const mat = new PointsMaterial({
    size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  })
  const p = new Points(g, mat)
  p.frustumCulled = false
  return p
}

/** The far banks' light carpet: points at street and window height, denser nearer the rivers. */
function carpet(): Points {
  const rnd = mulberry(77)
  const N = 12000
  const pos = new Float32Array(N * 3)
  const col = new Float32Array(N * 3)
  const tint = new Color()
  for (let i = 0; i < N; i++) {
    // Rejection-sample a point on one far bank inside the metropolis disc.
    let x = 0, z = 0
    do {
      const side = rnd() < 0.5 ? -1 : 1
      x = side * (RIVER_OUTER + 4 + Math.pow(rnd(), 1.6) * (METRO_RADIUS - RIVER_OUTER))
      z = (rnd() * 2 - 1) * 1800
    } while (Math.hypot(x, z) > METRO_RADIUS)
    pos[i * 3] = x
    pos[i * 3 + 1] = 1 + rnd() * 14
    pos[i * 3 + 2] = z
    const warm = rnd() < 0.85
    tint.set(warm ? '#ffb469' : '#9fe6ff').multiplyScalar(0.55 + rnd() * 0.45)
    col[i * 3] = tint.r
    col[i * 3 + 1] = tint.g
    col[i * 3 + 2] = tint.b
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('color', new BufferAttribute(col, 3))
  const mat = new PointsMaterial({
    size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  })
  const p = new Points(g, mat)
  p.frustumCulled = false
  return p
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function Water() {
  const lights = useMemo(() => {
    const arr: Vector4[] = []
    for (let i = 0; i < LIGHT_COUNT; i++) arr.push(new Vector4(0, 0, 0, 0))
    shoreLights().forEach((L, i) => arr[i]!.set(L.x, L.z, L.i, 0))
    return arr
  }, [])
  const mat = useMemo(() => new ShaderMaterial({
    uniforms: {
      uLights: { value: lights },
      uTime: skyTime,
      uHaze: { value: new Color(FOG_HEX) },
      uDeep: { value: DEEP },
      uFogK: { value: HAZE_DENSITY }
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG
  }), [lights])
  const west = useMemo(() => waterMesh(-RIVER_CENTRE, mat), [mat])
  const east = useMemo(() => waterMesh(RIVER_CENTRE, mat), [mat])
  const pierMesh = useMemo(() => piers(), [])
  const lampPoints = useMemo(() => lamps(), [])
  const carpetPoints = useMemo(() => carpet(), [])

  useEffect(() => () => {
    mat.dispose()
    west.geometry.dispose()
    east.geometry.dispose()
    pierMesh.geometry.dispose()
    ;(pierMesh.material as MeshBasicMaterial).dispose()
    lampPoints.geometry.dispose()
    ;(lampPoints.material as PointsMaterial).dispose()
    carpetPoints.geometry.dispose()
    ;(carpetPoints.material as PointsMaterial).dispose()
  }, [mat, west, east, pierMesh, lampPoints, carpetPoints])

  return (
    <>
      <primitive object={west} renderOrder={-5} />
      <primitive object={east} renderOrder={-5} />
      <primitive object={pierMesh} />
      <primitive object={lampPoints} />
      <primitive object={carpetPoints} />
    </>
  )
}

