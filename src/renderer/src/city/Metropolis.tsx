// Metropolis: the endless city beyond the repo's square. The plan (metro.ts) lists the buildings, parks, kit landmarks
// and light lines; this file turns them into a few dozen instanced meshes. Each (band, massing) group is one draw of
// unit massings (stepped crowns, setbacks, podiums, L-plans and slabs), each scaled to its lot in metres: the photographic
// facade material carries them, with the same lit-window and lighting rules as the repo city. The landmarks are the kit
// towers at their real size, one draw per kit model. Light lines (avenues and streets), parks and the warm horizon band
// are one draw call each. Built once per repo name and layout size; nothing is allocated per frame.
import { useEffect, useMemo, useState } from 'react'
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, Quaternion, ShaderMaterial, Vector3, AdditiveBlending, Float32BufferAttribute, BufferAttribute, Points, PointsMaterial,
  type MeshStandardMaterial
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CITY_SIZE } from '@shared/layout'
import { useSky } from '../state/store'
import { FOG_HEX, skyTime } from './Sky'
import { GRID_ANGLE, HAZE_DENSITY, buildMetro, type Landmark, type Massing, type MetroGroup, type MetroPlan, type LotSet } from './metro'
import { createFacadeMaterial, createKitOverlayMaterial, attachInstanceAttributes, neutralInstanceAttributes } from './buildingShader'
import { lightingUniforms } from './lighting'
import { loadFacadeAtlas } from './facade/photo/atlas'
import { setFacadeAtlas } from './facade/photo/material'
import { loadKit, applyKitTextures, type KitData } from './kit'

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

/**
 * One instanced mesh of lots. Each lot carries its size in world units (aSize: the massing is scaled to it, so the facade
 * UVs come out in metres), its seed, lit share and facade set, and the neutral overlay attributes.
 */
function lotMesh(geo: BufferGeometry, set: LotSet, mat: MeshStandardMaterial): InstancedMesh {
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
  const attrs = neutralInstanceAttributes(set.count)
  attrs.aSize!.array.set(set.size)
  attrs.aSeed!.array.set(set.seed)
  attrs.aFacade!.array.set(Float32Array.from(set.facade))
  for (let i = 0; i < set.count; i++) attrs.aLit!.array[i] = set.style[i * 4]!
  attachInstanceAttributes(geo, attrs)
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/**
 * One instanced mesh per kit model of the landmarks, at real size: the kit geometry is already in world units, so an
 * instance is a turn and a translation. The kit geometry's vertex buffers are shared, not copied.
 */
function landmarkMeshes(landmarks: readonly Landmark[], kit: KitData, mat: MeshStandardMaterial): InstancedMesh[] {
  const byKit = new Map<string, Landmark[]>()
  for (const lm of landmarks) {
    let list = byKit.get(lm.kit)
    if (!list) byKit.set(lm.kit, (list = []))
    list.push(lm)
  }
  const out: InstancedMesh[] = []
  const m = new Matrix4()
  const p = new Vector3()
  const one = new Vector3(1, 1, 1)
  for (const [id, list] of byKit) {
    const src = kit.buildings.get(id)
    if (!src) continue
    const g = new BufferGeometry()
    for (const name of ['position', 'normal', 'uv', 'uv1']) {
      const a = src.geometry.getAttribute(name)
      if (a) g.setAttribute(name, a)
    }
    if (src.geometry.index) g.setIndex(src.geometry.index)
    const mesh = new InstancedMesh(g, mat, list.length)
    const attrs = neutralInstanceAttributes(list.length)
    list.forEach((lm, i) => {
      p.set(lm.x, 0, lm.z)
      m.compose(p, lm.rot ? Q_TURNED : Q_PLAIN, one)
      mesh.setMatrixAt(i, m)
      attrs.aSize!.setXYZ(i, lm.w, lm.h, lm.d)
      attrs.aSeed!.setX(i, lm.seed)
      attrs.aLit!.setX(i, lm.lit)
    })
    mesh.instanceMatrix.needsUpdate = true
    attachInstanceAttributes(g, attrs)
    mesh.count = list.length
    mesh.name = `metro-landmark-${id}`
    mesh.frustumCulled = false
    mesh.castShadow = true
    mesh.receiveShadow = true
    out.push(mesh)
  }
  return out
}

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
  // Faint continuous street-light haze across the whole line, on top of the thin core.
  col += sodium * vBright * 0.06 * (1.0 - smoothstep(0.0, 1.0, abs(vAcross)));
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

function buildMetropolis(plan: MetroPlan, facade: MeshStandardMaterial): Built {
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

  // One photographic facade and one kit material for the whole far city: the same lighting as the repo city (by
  // reference, from lighting.ts), and the far city's haze instead of the scene fog.
  const shared = useMemo(() => ({ time: skyTime, tint: { value: 0 } }), [])
  const haze = useMemo(() => ({ color: new Color(METRO_HAZE), k: HAZE_DENSITY }), [])
  const facade = useMemo(() => createFacadeMaterial(shared, haze), [shared, haze])
  const kitMat = useMemo(() => createKitOverlayMaterial(shared, haze), [shared, haze])
  const [kit, setKit] = useState<KitData | null>(null)

  useEffect(() => {
    let live = true
    loadFacadeAtlas()
      .then((atlas) => {
        if (live) setFacadeAtlas(facade, atlas)
      })
      .catch((err: unknown) => console.warn('metropolis facades unavailable', err))
    return () => {
      live = false
    }
  }, [facade])

  useEffect(() => {
    let live = true
    loadKit()
      .then((k) => {
        if (!live) return
        applyKitTextures(kitMat, k.textures)
        setKit(k)
      })
      .catch((err: unknown) => console.warn('metropolis landmarks unavailable', err))
    return () => {
      live = false
    }
  }, [kitMat])

  const lines = useMemo(() => {
    const geo = lineGeometry(plan)
    const mat = new ShaderMaterial({
      uniforms: { uTime: skyTime, uFogK: { value: HAZE_DENSITY }, uHaze: { value: new Color(METRO_HAZE) }, uNight: lightingUniforms.uNight },
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
    // Intersection sparkles: a warm point where each avenue crosses a cross street, outside the repo square.
    const ip: number[] = []
    for (let x = -1800; x <= 1800; x += 72) {
      for (let z = -1800; z <= 1800; z += 22) {
        if (Math.hypot(x, z) > 1800 || (Math.abs(x) < size / 2 && Math.abs(z) < size / 2)) continue
        if (Math.abs(x) >= 250 && Math.abs(x) <= 700) continue
        ip.push(x, LIGHT_Y + 0.1, z)
      }
    }
    const ig = new BufferGeometry()
    ig.setAttribute('position', new BufferAttribute(new Float32Array(ip), 3))
    const imat = new PointsMaterial({ color: new Color('#ffa860'), size: 2.2, sizeAttenuation: false, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
    const sparkles = new Points(ig, imat)
    sparkles.frustumCulled = false
    return { mesh, geo, mat, lamps, lg, lmat, sparkles, ig, imat }
  }, [plan, size])

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
  const landmarks = useMemo(() => (kit ? landmarkMeshes(plan.landmarks, kit, kitMat) : []), [plan, kit, kitMat])

  useEffect(() => () => {
    built.geos.forEach((g) => g.dispose())
  }, [built])
  useEffect(() => () => {
    landmarks.forEach((m) => m.geometry.dispose())
  }, [landmarks])
  useEffect(() => () => {
    lines.geo.dispose()
    lines.mat.dispose()
  }, [lines])
  useEffect(() => () => {
    parks.geo.dispose()
    parks.mat.dispose()
    parks.lg.dispose()
    parks.lmat.dispose()
    parks.ig.dispose()
    parks.imat.dispose()
  }, [parks])
  useEffect(() => () => {
    horizon.geo.dispose()
    horizon.mat.dispose()
  }, [horizon])
  useEffect(() => () => {
    facade.dispose()
    kitMat.dispose()
  }, [facade, kitMat])

  return (
    <>
      {built.meshes.map((m, i) => <primitive key={i} object={m} />)}
      {landmarks.map((m) => <primitive key={m.name} object={m} />)}
      <primitive object={parks.mesh} />
      <primitive object={parks.lamps} />
      <primitive object={parks.sparkles} />
      <primitive object={lines.mesh} />
      <primitive object={horizon.mesh} />
    </>
  )
}
