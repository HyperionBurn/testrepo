// Metropolis: the endless city beyond the repo's square. The plan (metro.ts) lists the buildings, parks and light lines;
// this file turns them into a few dozen instanced meshes. Each (band, massing) group is one draw: stepped crowns, setbacks,
// podiums, L-plans and spires in the near band, slabs and setbacks farther out. One facade shader carries every building:
// dark brick, concrete, glass or limestone; a real-scale window grid (floors of 0.16 units, panes 0.12 to 0.2 across) that
// fades to the building's average light once the panes fall under about 1.5 pixels; per-building lit share, office towers
// and half-lit blocks; dark roofs with warm vents; and the fog. Light lines (avenues and streets), parks and the warm
// horizon band are one draw call each. Built once per repo name and layout size; nothing is allocated per frame.
import { useEffect, useMemo } from 'react'
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, Quaternion, ShaderMaterial, Vector3, AdditiveBlending, Float32BufferAttribute, BufferAttribute, Points, PointsMaterial
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CITY_SIZE } from '@shared/layout'
import { useSky } from '../state/store'
import { FOG_HEX, skyTime } from './Sky'
import { GRID_ANGLE, HAZE_DENSITY, buildMetro, type Massing, type MetroGroup, type MetroPlan, type LotSet } from './metro'

const LIGHT_Y = 0.12
const PARK_Y = 0.05
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

/** One massing in unit space, merged into one non-indexed-safe geometry. */
function massingGeometry(m: Massing): BufferGeometry {
  let parts: BufferGeometry[]
  switch (m) {
    case 'slab':
      parts = [unitBox(-0.5, 0.5, 0, 1, -0.5, 0.5)]
      break
    case 'setback':
      parts = [unitBox(-0.5, 0.5, 0, 0.55, -0.5, 0.5), unitBox(-0.36, 0.36, 0.55, 1, -0.36, 0.36)]
      break
    case 'podium':
      parts = [unitBox(-0.5, 0.5, 0, 0.2, -0.5, 0.5), unitBox(-0.3, 0.3, 0.2, 1, -0.3, 0.3)]
      break
    case 'ell':
      parts = [unitBox(-0.5, 0.5, 0, 1, -0.5, 0), unitBox(-0.5, -0.08, 0, 0.6, 0, 0.5)]
      break
    case 'crown':
      parts = [
        unitBox(-0.5, 0.5, 0, 0.6, -0.5, 0.5),
        unitBox(-0.37, 0.37, 0.6, 0.84, -0.37, 0.37),
        unitBox(-0.24, 0.24, 0.84, 1, -0.24, 0.24)
      ]
      break
    case 'spire':
      parts = [unitBox(-0.5, 0.5, 0, 1, -0.5, 0.5), unitBox(-0.025, 0.025, 1, 1.32, -0.025, 0.025)]
      break
  }
  const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts)!
  if (parts.length > 1) parts.forEach((p) => p.dispose())
  return merged
}

const QUARTER = Math.PI / 2
const Q_PLAIN = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), GRID_ANGLE)
const Q_TURNED = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), GRID_ANGLE + QUARTER)

/** One instanced mesh of buildings. Each lot carries its footprint, seed, turn and facade style as instance attributes. */
function lotMesh(geo: BufferGeometry, set: LotSet, mat: ShaderMaterial): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, Math.max(1, set.count))
  const m = new Matrix4()
  const p = new Vector3()
  const s = new Vector3()
  for (let i = 0; i < set.count; i++) {
    p.set(set.pos[i * 3]!, 0, set.pos[i * 3 + 2]!)
    s.set(set.size[i * 3]!, set.size[i * 3 + 1]!, set.size[i * 3 + 2]!)
    m.compose(p, set.rot[i] ? Q_TURNED : Q_PLAIN, s)
    mesh.setMatrixAt(i, m)
  }
  mesh.count = set.count
  mesh.instanceMatrix.needsUpdate = true
  geo.setAttribute('aSize', new InstancedBufferAttribute(set.size, 3))
  geo.setAttribute('aSeed', new InstancedBufferAttribute(set.seed, 1))
  geo.setAttribute('aStyle', new InstancedBufferAttribute(set.style, 4))
  mesh.frustumCulled = false
  return mesh
}

// ---- Facade shader ---------------------------------------------------------------------------------------

const FACADE_VERT = `
attribute vec3 aSize;
attribute float aSeed;
attribute vec4 aStyle;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWN;
varying vec3 vW;
varying float vSeed;
varying float vUnitY;
varying float vHgt;
varying vec4 vStyle;
void main() {
  vLocal = position * aSize;
  vN = normal;
  vWN = normalize(mat3(instanceMatrix) * normal);
  vSeed = aSeed;
  vStyle = aStyle;
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
uniform float uNight;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWN;
varying vec3 vW;
varying float vSeed;
varying float vUnitY;
varying float vHgt;
varying vec4 vStyle;
float h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec3 n = normalize(vN);
  float sd = vSeed * 97.0;
  // Dark neutral walls: brick (brown-red), grey concrete, blue-black glass, dark limestone. Each varies per building.
  float pal = vStyle.z;
  vec3 wall = pal < 0.5 ? vec3(0.085, 0.040, 0.032)
    : pal < 1.5 ? vec3(0.062, 0.062, 0.066)
    : pal < 2.5 ? vec3(0.020, 0.026, 0.042)
    : vec3(0.078, 0.072, 0.062);
  wall *= 0.8 + 0.4 * h21(vec2(vSeed * 11.3, 1.7));

  // Window grid at real scale: floors of 0.16 world units, panes across the face at a pitch of 0.12 to 0.2.
  bool sideX = abs(n.x) > 0.5;
  float along = sideX ? vLocal.z : vLocal.x;
  float pitch = mix(0.12, 0.2, vStyle.y);
  vec2 g = vec2(along / pitch, vLocal.y / 0.16);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 fw = fwidth(g);
  float pxc = max(fw.x, fw.y);
  // Panes under about 1.5 pixels average out to the building's mean light: no moire, no speckle, no white squares.
  float aa = 1.0 - smoothstep(0.35, 0.7, pxc);
  float winX = smoothstep(0.2 - fw.x, 0.2 + fw.x, f.x) * (1.0 - smoothstep(0.8 - fw.x, 0.8 + fw.x, f.x));
  float winY = smoothstep(0.24 - fw.y, 0.24 + fw.y, f.y) * (1.0 - smoothstep(0.8 - fw.y, 0.8 + fw.y, f.y));
  float pane = winX * winY;

  // Lit share: per building, with half-lit blocks (lower part lit) and dark blocks already in the style.
  float dens = vStyle.x;
  float kind = vStyle.w;
  float halfLit = step(2.5, kind) * step(kind, 3.5);
  float cut = 0.3 + 0.5 * h21(vec2(sd, 4.0));
  dens = mix(dens, mix(0.5, 0.03, step(cut, vLocal.y / max(vHgt, 1.0))), halfLit);
  float r = h21(cell + sd);
  // Whole floors lit in runs now and then.
  float run = step(0.9, h21(vec2(cell.y, sd + 3.0))) * step(0.5, dens);
  float lit = max(step(r, dens), run);
  // Office towers: most panes lit.
  if (kind > 0.5 && kind < 1.5) lit = max(lit, step(0.12, r));

  // Warm 2400 to 3200 K (#ffd9a0 and #ffc27a) 72 %, cool white 20 %, TV blue 8 %; each pane varies by 30 %.
  float kc = h21(cell * 1.3 + sd + 4.0);
  vec3 warm = mix(vec3(1.0, 0.851, 0.627), vec3(1.0, 0.761, 0.478), h21(cell + sd + 9.0));
  vec3 winCol = kc < 0.72 ? warm : (kc < 0.92 ? vec3(0.82, 0.9, 1.0) : vec3(0.35, 0.55, 1.0));
  float inten = 0.7 + 0.6 * h21(cell * 2.1 + sd + 5.0);
  // Single panes stay below 1.2. The far average (the same panes, averaged over a cell) is boosted at night.
  vec3 paneCol = winCol * inten * 0.85 * lit * pane;
  vec3 avg = dens * 0.336 * vec3(0.93, 0.74, 0.5) * 0.85 * uWinGain;
  vec3 col = wall + mix(avg, paneCol, aa);

  // Roofs: dark tar with small warm vents as emissive specks (faded where a vent is under a pixel). The derivatives are
  // taken outside the branch, so every fragment of a quad shares them.
  vec2 vc = vLocal.xz / 0.9;
  vec2 vcell = floor(vc);
  vec2 vf = fract(vc) - 0.5;
  vec2 vfwv = fwidth(vc);
  float vfw = max(vfwv.x, vfwv.y);
  if (n.y > 0.5) {
    vec3 tar = vec3(0.016, 0.016, 0.02) * (0.7 + 0.8 * h21(vec2(vSeed * 13.0, 2.0)));
    float vent = step(0.8, h21(vcell + vSeed * 31.0)) * (1.0 - smoothstep(0.06, 0.12, length(vf)));
    vent *= 1.0 - smoothstep(0.3, 0.6, vfw);
    col = tar + vec3(1.0, 0.6, 0.3) * vent * 0.55;
  }
  // Tall lots: a thin lit crown on about 15 % of them.
  float crownGate = step(0.85, h21(vec2(vSeed * 71.0, 9.0)));
  float tallC = smoothstep(80.0, 160.0, vHgt);
  float crown = smoothstep(0.93, 0.995, vUnitY) * tallC * crownGate * (1.0 - abs(n.y)) * 0.35;
  col += vec3(1.0, 0.7, 0.4) * crown;

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
uniform float uNight;
varying float vAcross;
varying float vBright;
varying float vSeed;
varying vec3 vW;
void main() {
  float edge = 1.0 - smoothstep(0.15, 1.0, abs(vAcross));
  float flick = 0.82 + 0.18 * sin(uTime * (1.2 + vSeed * 2.0) + vSeed * 40.0);
  vec3 sodium = mix(vec3(1.0, 0.46, 0.12), vec3(1.0, 0.74, 0.38), 0.4);
  vec3 col = sodium * vBright * edge * flick;
  // Faint wide sodium haze around each street line, so the carpet glows like a night aerial.
  col += sodium * vBright * 0.035 * uNight * (1.0 - smoothstep(0.3, 1.0, abs(vAcross)));
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogK, 2.0));
  col *= 1.0 - 0.85 * fog;
  gl_FragColor = vec4(col * 1.5, 1.0);
}`

// ---- Parks -----------------------------------------------------------------------------------------------

const PARK_FRAG = `
uniform float uFogK;
uniform vec3 uHaze;
varying vec3 vCol;
varying vec3 vW;
void main() {
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uFogK, 2.0));
  gl_FragColor = vec4(mix(vCol, uHaze, fog), 1.0);
}`

const PARK_VERT = `
attribute vec3 aCol;
varying vec3 vCol;
varying vec3 vW;
void main() {
  vCol = aCol;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
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
  meshes: InstancedMesh[]
  geos: BufferGeometry[]
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

/** Park ground: one dark-green quad per park, with a little colour variation from park to park. */
function parkGeometry(plan: MetroPlan): BufferGeometry {
  const P = plan.parks
  const pos = new Float32Array(P.count * 4 * 3)
  const col = new Float32Array(P.count * 4 * 3)
  const idx = new Uint32Array(P.count * 6)
  const base = new Color('#0d1b14')
  for (let k = 0; k < P.count; k++) {
    const [x0, x1, z0, z1] = [P.rects[k * 4]!, P.rects[k * 4 + 1]!, P.rects[k * 4 + 2]!, P.rects[k * 4 + 3]!]
    const shade = 0.75 + 0.5 * (Math.abs(Math.sin(x0 * 12.9898 + z0 * 78.233) * 43758.5453) % 1)
    const c = base.clone().multiplyScalar(shade)
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
    corners.forEach(([x, z], q) => {
      const v = k * 4 + q
      pos.set([x!, PARK_Y, z!], v * 3)
      col.set([c.r, c.g, c.b], v * 3)
    })
    idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('aCol', new Float32BufferAttribute(col, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}

function buildMetropolis(plan: MetroPlan, facade: ShaderMaterial): Built {
  const meshes: InstancedMesh[] = []
  const geos: BufferGeometry[] = []
  for (const grp of plan.groups as MetroGroup[]) {
    const geo = massingGeometry(grp.massing)
    meshes.push(lotMesh(geo, grp.set, facade))
    geos.push(geo)
  }
  return { meshes, geos }
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
      uWinGain: { value: 1.0 },
      uNight: { value: 1.0 }
    },
    vertexShader: FACADE_VERT,
    fragmentShader: FACADE_FRAG
  }), [])

  const lines = useMemo(() => {
    const geo = lineGeometry(plan)
    const mat = new ShaderMaterial({
      uniforms: { uTime: skyTime, uFogK: { value: HAZE_DENSITY }, uHaze: { value: new Color(METRO_HAZE) }, uNight: { value: 1.0 } },
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

  const parks = useMemo(() => {
    const geo = parkGeometry(plan)
    const mat = new ShaderMaterial({
      uniforms: { uFogK: { value: HAZE_DENSITY }, uHaze: { value: new Color(METRO_HAZE) } },
      vertexShader: PARK_VERT,
      fragmentShader: PARK_FRAG
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -4
    // Sparse lamps in the parks: warm points, one draw call for all of them.
    const L = plan.parks.lights
    const lp = new Float32Array((L.length / 2) * 3)
    for (let i = 0; i < L.length / 2; i++) {
      lp[i * 3] = L[i * 2]!
      lp[i * 3 + 1] = 1.2
      lp[i * 3 + 2] = L[i * 2 + 1]!
    }
    const lg = new BufferGeometry()
    lg.setAttribute('position', new BufferAttribute(lp, 3))
    const lmat = new PointsMaterial({ color: new Color('#ffb469'), size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
    const lamps = new Points(lg, lmat)
    lamps.frustumCulled = false
    return { mesh, geo, mat, lamps, lg, lmat }
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
  // Night boosts the far window average (x1.6); the other presets keep the base level.
  const night = useSky((s) => s.timeOfDay === 'night')
  useEffect(() => {
    // The far average of the windows is the warm carpet of light: stronger at night, moderate at blue hour.
    facade.uniforms.uNight!.value = night ? 1.6 : 1.0
    facade.uniforms.uWinGain!.value = night ? 2.6 : 1.15
    lines.mat.uniforms.uNight!.value = night ? 1.6 : 1.0
  }, [night, facade, lines])

  useEffect(() => () => {
    built.geos.forEach((g) => g.dispose())
  }, [built])
  useEffect(() => () => {
    lines.geo.dispose()
    lines.mat.dispose()
  }, [lines])
  useEffect(() => () => {
    parks.geo.dispose()
    parks.mat.dispose()
    parks.lg.dispose()
    parks.lmat.dispose()
  }, [parks])
  useEffect(() => () => {
    horizon.geo.dispose()
    horizon.mat.dispose()
  }, [horizon])
  useEffect(() => () => facade.dispose(), [facade])

  return (
    <>
      {built.meshes.map((m, i) => <primitive key={i} object={m} />)}
      <primitive object={parks.mesh} />
      <primitive object={parks.lamps} />
      <primitive object={lines.mesh} />
      <primitive object={horizon.mesh} />
    </>
  )
}
