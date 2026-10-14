// Metropolis: the endless city beyond the repo's square. The plan (metro.ts) lists the lots; this file turns them into
// a handful of instanced meshes: near towers in stepped tiers (with a spire where the plan says so), and plain boxes in
// three far bands. One facade shader carries every box: dark walls, a window grid whose lit share averages out with
// distance (derivatives), warm lit crowns and the fog. Light lines (avenues and cross streets) and the warm horizon
// band are one draw call each. Built once per repo name and layout size; nothing is allocated per frame.
import { useEffect, useMemo } from 'react'
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, Quaternion, ShaderMaterial, Vector3, AdditiveBlending, Float32BufferAttribute, BufferAttribute
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CITY_SIZE } from '@shared/layout'
import { useSky } from '../state/store'
import { FOG_HEX, skyTime } from './Sky'
import { GRID_ANGLE, HAZE_DENSITY, buildMetro, type LotSet, type MetroPlan } from './metro'

const LIGHT_Y = 0.12
/** Far haze: the scene fog colour, warmed toward the sodium glow so the far city fades into orange light. */
const METRO_HAZE = new Color(FOG_HEX).lerp(new Color('#4a2a18'), 0.4)
const HORIZON_R = 1790
const HORIZON_H = 220

// ---- Geometry --------------------------------------------------------------------------------------------

/** Unit box standing on y = 0: x and z in -0.5..0.5, y in 0..1. */
function unitBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): BufferGeometry {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  g.deleteAttribute('uv')
  return g
}

/** Stepped towers: a full base, two setbacks, and (optionally) a thin spire above the unit height. */
function tierGeometry(spire: boolean): BufferGeometry {
  const parts = [
    unitBox(-0.5, 0.5, 0, 0.6, -0.5, 0.5),
    unitBox(-0.37, 0.37, 0.6, 0.84, -0.37, 0.37),
    unitBox(-0.24, 0.24, 0.84, 1, -0.24, 0.24)
  ]
  if (spire) parts.push(unitBox(-0.025, 0.025, 1, 1.32, -0.025, 0.025))
  const merged = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  return merged
}

function plainGeometry(): BufferGeometry {
  return unitBox(-0.5, 0.5, 0, 1, -0.5, 0.5)
}

/** One instanced mesh of lots. Every lot shares the rotation of the grid and carries its footprint and seed. */
function lotMesh(geo: BufferGeometry, set: LotSet, mat: ShaderMaterial): InstancedMesh {
  const g = geo
  const mesh = new InstancedMesh(g, mat, Math.max(1, set.count))
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), GRID_ANGLE)
  const m = new Matrix4()
  const p = new Vector3()
  const s = new Vector3()
  for (let i = 0; i < set.count; i++) {
    p.set(set.pos[i * 3]!, 0, set.pos[i * 3 + 2]!)
    s.set(set.size[i * 3]!, set.size[i * 3 + 1]!, set.size[i * 3 + 2]!)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
  }
  mesh.count = set.count
  mesh.instanceMatrix.needsUpdate = true
  g.setAttribute('aSize', new InstancedBufferAttribute(set.size, 3))
  g.setAttribute('aSeed', new InstancedBufferAttribute(set.seed, 1))
  mesh.frustumCulled = false
  return mesh
}

// ---- Facade shader ---------------------------------------------------------------------------------------

const FACADE_VERT = `
attribute vec3 aSize;
attribute float aSeed;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWN;
varying vec3 vW;
varying float vSeed;
varying float vUnitY;
varying float vHgt;
void main() {
  vLocal = position * aSize;
  vN = normal;
  vWN = normalize(mat3(instanceMatrix) * normal);
  vSeed = aSeed;
  vUnitY = position.y;
  vHgt = aSize.y;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const FACADE_FRAG = `
uniform float uFogK;
uniform vec3 uHaze;
uniform float uWinGain;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWN;
varying vec3 vW;
varying float vSeed;
varying float vUnitY;
varying float vHgt;
float h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec3 n = normalize(vN);
  // Window grid in world units on the face the fragment sits on.
  float along = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
  vec2 uv = vec2(along, vLocal.y);
  vec2 cell = vec2(3.1, 3.7);
  vec2 g = uv / cell;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float sd = vSeed * 97.0;
  // Dark neutral facade: brick, concrete or glass.
  float mt = h21(vec2(vSeed * 41.0, 3.0));
  vec3 wall = mix(vec3(0.060, 0.038, 0.030), vec3(0.046, 0.048, 0.054), step(0.42, mt));
  wall = mix(wall, vec3(0.018, 0.024, 0.040), step(0.84, mt));
  // Lit panes: about 40 % of windows, whole floors lit in runs now and then. Each lit pane gets its own intensity (+-30 %)
  // and colour: warm yellow-white most of the time, some orange, cool white and a few TV-blue.
  float r = h21(id + sd);
  float run = step(0.86, h21(vec2(id.y + 3.0, sd)));
  float lit = max(step(r, 0.40), run * step(h21(id * 1.3 + sd + 7.0), 0.7));
  float kind = h21(id * 1.7 + sd + 19.0);
  vec3 winCol = kind < 0.65 ? vec3(1.0, 0.85, 0.63) : kind < 0.80 ? vec3(1.0, 0.55, 0.22) : kind < 0.95 ? vec3(0.86, 0.91, 1.0) : vec3(0.35, 0.55, 1.0);
  float inten = 0.7 + 0.6 * h21(id * 3.1 + sd + 5.0);
  float pane = step(0.2, f.x) * step(f.x, 0.8) * step(0.24, f.y) * step(f.y, 0.8);
  // Pixels per window cell: where a cell is smaller than a pixel, the lit share averages out to its mean.
  vec2 fw = fwidth(g);
  float px = max(fw.x, fw.y);
  float aa = 1.0 - smoothstep(0.15, 0.9, px);
  float emitW = (lit * inten * pane * aa + (1.0 - aa) * 0.4 * 1.0 * 0.336) * uWinGain;
  vec3 col = wall + winCol * emitW;
  // Tall towers: a lit crown band near the top, and a faint warm rim where the face turns away.
  float tall = smoothstep(60.0, 180.0, vHgt);
  float crown = smoothstep(0.93, 0.995, vUnitY) * tall * (1.0 - 0.5 * abs(n.y));
  col += vec3(1.0, 0.7, 0.4) * crown * 0.45;
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - abs(dot(normalize(vWN), V)), 3.0);
  col += vec3(0.5, 0.28, 0.12) * rim * 0.1;
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogK, 2.0));
  gl_FragColor = vec4(mix(col, uHaze, fog), 1.0);
}`

// ---- Light lines -----------------------------------------------------------------------------------------

const LINE_VERT = `
attribute float aAcross;
attribute float aBright;
attribute float aSeed;
varying float vAcross;
varying float vBright;
varying float vSeed;
varying vec3 vW;
void main() {
  vAcross = aAcross;
  vBright = aBright;
  vSeed = aSeed;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const LINE_FRAG = `
uniform float uTime;
uniform float uFogK;
uniform vec3 uHaze;
varying float vAcross;
varying float vBright;
varying float vSeed;
varying vec3 vW;
void main() {
  float edge = 1.0 - smoothstep(0.15, 1.0, abs(vAcross));
  float flick = 0.82 + 0.18 * sin(uTime * (1.2 + vSeed * 2.0) + vSeed * 40.0);
  vec3 sodium = mix(vec3(1.0, 0.46, 0.12), vec3(1.0, 0.74, 0.38), 0.4);
  vec3 col = sodium * vBright * edge * flick;
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogK, 2.0));
  col *= 1.0 - 0.85 * fog;
  gl_FragColor = vec4(col * 1.5, 1.0);
}`

// ---- Horizon band ----------------------------------------------------------------------------------------

const HORIZON_VERT = `
varying float vY;
varying float vAz;
void main() {
  vY = position.y / ${HORIZON_H.toFixed(1)};
  vAz = atan(position.z, position.x);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const HORIZON_FRAG = `
uniform float uTime;
varying float vY;
varying float vAz;
void main() {
  float ripple = 0.75 + 0.25 * sin(vAz * 23.0 + sin(vAz * 7.0) * 2.0 + uTime * 0.05);
  float a = pow(1.0 - clamp(vY, 0.0, 1.0), 2.2) * ripple;
  vec3 col = vec3(1.0, 0.5, 0.2) * 0.6 * a;
  gl_FragColor = vec4(col, 1.0);
}`

// ---- Build -----------------------------------------------------------------------------------------------

interface Built {
  group: InstancedMesh[]
  dispose: () => void
}

function lineGeometry(plan: MetroPlan): BufferGeometry {
  const L = plan.lines
  const g = new BufferGeometry()
  const pos = new Float32Array(L.quads * 4 * 3)
  for (let v = 0; v < L.quads * 4; v++) {
    pos[v * 3] = L.xz[v * 2]!
    pos[v * 3 + 1] = LIGHT_Y
    pos[v * 3 + 2] = L.xz[v * 2 + 1]!
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('aAcross', new BufferAttribute(L.across, 1))
  g.setAttribute('aBright', new BufferAttribute(L.bright, 1))
  g.setAttribute('aSeed', new BufferAttribute(L.seed, 1))
  g.setIndex(new BufferAttribute(L.index, 1))
  return g
}

function buildMetropolis(plan: MetroPlan, facade: ShaderMaterial): Built {
  const tiered = lotMesh(tierGeometry(false), plan.tiered, facade)
  const spired = lotMesh(tierGeometry(true), plan.spired, facade)
  const mid = lotMesh(plainGeometry(), plan.mid, facade)
  const far = lotMesh(plainGeometry(), plan.far, facade)
  const edge = lotMesh(plainGeometry(), plan.edge, facade)
  const meshes: InstancedMesh[] = [tiered, spired, mid, far, edge]
  const geos = meshes.map((m) => m.geometry as BufferGeometry)
  return {
    group: meshes,
    dispose: () => {
      geos.forEach((g) => g.dispose())
    }
  }
}

/** The metropolis around the repo city. Mounted once; it rebuilds only when the repo name or the layout size changes. */
export function Metropolis() {
  const name = useSky((s) => s.repo?.name ?? 'skyline')
  const size = useSky((s) => s.layout?.size ?? CITY_SIZE)
  const repoTop = useSky((s) => (s.layout?.buildings ?? []).reduce((m, b) => Math.max(m, b.h), 0))
  const plan = useMemo(() => buildMetro({ name, half: size / 2, repoTop }), [name, size, repoTop])

  const facade = useMemo(() => new ShaderMaterial({
    uniforms: {
      uFogK: { value: HAZE_DENSITY },
      uHaze: { value: new Color(METRO_HAZE) },
      uWinGain: { value: 1.0 }
    },
    vertexShader: FACADE_VERT,
    fragmentShader: FACADE_FRAG
  }), [])

  const lines = useMemo(() => {
    const geo = lineGeometry(plan)
    const mat = new ShaderMaterial({
      uniforms: { uTime: skyTime, uFogK: { value: HAZE_DENSITY }, uHaze: { value: new Color(METRO_HAZE) } },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -3
    return { mesh, geo, mat }
  }, [plan])

  const horizon = useMemo(() => {
    const geo = new CylinderGeometry(HORIZON_R, HORIZON_R, HORIZON_H, 96, 1, true)
    geo.translate(0, HORIZON_H / 2, 0)
    const mat = new ShaderMaterial({
      uniforms: { uTime: skyTime },
      vertexShader: HORIZON_VERT,
      fragmentShader: HORIZON_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -2
    return { mesh, geo, mat }
  }, [])

  const built = useMemo(() => buildMetropolis(plan, facade), [plan, facade])

  useEffect(() => () => {
    built.dispose()
  }, [built])
  useEffect(() => () => {
    lines.geo.dispose()
    lines.mat.dispose()
  }, [lines])
  useEffect(() => () => {
    horizon.geo.dispose()
    horizon.mat.dispose()
  }, [horizon])
  useEffect(() => () => facade.dispose(), [facade])

  return (
    <>
      {built.group.map((m, i) => <primitive key={i} object={m} />)}
      <primitive object={lines.mesh} />
      <primitive object={horizon.mesh} />
    </>
  )
}

