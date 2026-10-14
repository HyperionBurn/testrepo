// Road network. The default road is procedural: one ground mesh for the streets, painted from the street mask and
// the traffic network (roadtex.ts), with a wet-asphalt shader (fresnel sky, streaked lamp reflections, puddles) and
// sodium-orange light on every avenue. Lamps are procedural cobra heads: instanced poles, instanced heads, and one
// additive glow layer. With the 'stylized' building style the Kenney road tiles are used instead, as before.
// The plan is pure (streets.ts) and memoised per layout object; the surface sits at ROAD_Y, above the ground plane.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry, Float32BufferAttribute,
  Group, InstancedMesh, Material, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Points, PointsMaterial,
  Quaternion, ShaderMaterial, SRGBColorSpace, Texture, Vector3
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { CityLayout } from '@shared/types'
import { useSky } from '../state/store'
import { loadModels, type LoadedModel } from './assets'
import { FOG_DENSITY, FOG_HEX } from './Sky'
import { buildRoadPlan, lampArmDirection, lampTransform, ROAD_Y, type RoadPlan, type RoadTile } from './streets'
import { buildRoadRaster, roadTextures } from './roadtex'
import { buildLanes } from './lanes'

const FADE_MS = 800
const UP = new Vector3(0, 1, 0)
const WARM = new Color('#ffc27a')
const COOL = new Color('#9fd6ff')
/** Glow colour multiplier: above the bloom threshold, so the lamp heads bloom. */
const GLOW_GAIN = 2.2
/** Cobra head: pole height, arm reach toward the road, and where the head hangs. */
const POLE_H = 0.66
const ARM_REACH = 0.27
const HEAD_Y = 0.628

declare global {
  interface Window {
    /** Lamp and road plan, and the signalled junctions, for tests and the harness. */
    __skylineRoads?: () => { tiles: RoadTile[]; lights: RoadPlan['lights']; junctions: { x: number; z: number }[] };
  }
}

/** The building style is a store field added by the facade pass; read it defensively until it exists. */
function useStylized(): boolean {
  return useSky((s) => (s as unknown as { buildingStyle?: string }).buildingStyle === 'stylized')
}

// ---------------------------------------------------------------------------------------------
// Procedural road

const SURF_VERT = `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const SURF_FRAG = `
uniform sampler2D uSurf;
uniform sampler2D uGlow;
uniform float uSize;
uniform float uFade;
uniform float uWet;
uniform vec3 uCam;
uniform vec3 uFog;
uniform float uDensity;
varying vec3 vW;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

// Albedo only: asphalt, kerbs, paint, manholes and wet reflections. The light itself is the additive glow layer.
void main() {
  vec2 p = vW.xz;
  vec2 uv = (p + 0.5 * uSize) / uSize;
  vec4 s = texture2D(uSurf, uv);
  if (s.r < 0.5) discard;
  vec4 g = texture2D(uGlow, uv);

  float n1 = vnoise(p * 0.9);
  float n2 = vnoise(p * 5.0);
  float n3 = fbm(p * 0.07);
  vec3 asphalt = vec3(0.030, 0.032, 0.040) * (0.7 + 0.6 * n1) * (0.85 + 0.3 * n2) * (0.8 + 0.35 * n3);
  vec3 kerb = vec3(0.13, 0.12, 0.11) * (0.75 + 0.4 * n2);
  vec3 base = mix(asphalt, kerb, s.a);
  base = mix(base, vec3(0.62, 0.63, 0.66), s.g * 0.85);
  base = mix(base, vec3(0.82, 0.58, 0.12), s.b * 0.9);

  vec2 cell = floor(p / 3.2);
  vec2 mc = (cell + 0.5) * 3.2 + (vec2(hash(cell), hash(cell + 7.0)) - 0.5) * 1.2;
  float md = length(p - mc);
  float manhole = step(hash(cell + 3.0), 0.35) * smoothstep(0.17, 0.15, md);
  base *= 1.0 - 0.55 * manhole;

  // Wet asphalt: puddles reflect the sky at grazing angles and the lamps as streaks toward the viewer.
  vec3 sodium = vec3(1.0, 0.56, 0.2);
  float puddle = smoothstep(0.50, 0.63, fbm(p * 0.11 + 3.1)) * uWet;
  vec3 V = normalize(uCam - vW);
  float cosT = clamp(V.y, 0.0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
  vec2 toCam = uCam.xz - p;
  vec2 dir = length(toCam) > 0.001 ? normalize(toCam) : vec2(0.0);
  float streak = 0.0;
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    vec2 q = p + dir * fk * 0.7;
    streak += texture2D(uGlow, (q + 0.5 * uSize) / uSize).r * (1.0 - fk / 6.0);
  }
  vec3 skyRefl = mix(vec3(0.03, 0.05, 0.10), vec3(0.45, 0.22, 0.08), pow(1.0 - cosT, 4.0));
  vec3 reflCol = sodium * streak * 0.3 + skyRefl;

  vec3 col = base * (1.0 - 0.55 * puddle);
  col += puddle * uWet * fres * reflCol * 1.6;

  float dist = length(vW - uCam);
  float fog = 1.0 - exp(-pow(dist * uDensity, 2.0));
  col = mix(col, uFog, fog);
  gl_FragColor = vec4(col * uFade, 1.0);
}`

// Light layer: additive, HDR, never fogged. Avenue sodium bands, lamp pools, junction glow and signal heads, on street
// texels only. Warm sodium #ffb056 (HDR gains so the centrelines bloom).
const GLOW_FRAG = `
uniform sampler2D uSurf;
uniform sampler2D uGlow;
uniform float uSize;
uniform float uFade;
varying vec3 vW;
void main() {
  vec2 uv = (vW.xz + 0.5 * uSize) / uSize;
  vec4 s = texture2D(uSurf, uv);
  if (s.r < 0.5) discard;
  vec4 g = texture2D(uGlow, uv);
  float k = g.b * 1.25 + g.r * 0.8 + g.a * 0.55 + g.g * 0.9;
  vec3 warm = vec3(1.0, 0.69, 0.34);
  gl_FragColor = vec4(warm * k * uFade, 1.0);
}`

function glowTexture(): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** A cobra-head lamp in local units: pole at the origin, arm and head reaching along -z (toward the road). */
function cobraGeometry(): BufferGeometry {
  const pole = new CylinderGeometry(0.02, 0.03, POLE_H, 6).translate(0, POLE_H / 2, 0)
  const arm = new BoxGeometry(0.028, 0.028, ARM_REACH + 0.02).translate(0, POLE_H - 0.02, -ARM_REACH / 2)
  const head = new BoxGeometry(0.1, 0.03, 0.085).translate(0, HEAD_Y + 0.012, -ARM_REACH)
  for (const g of [pole, arm, head]) g.deleteAttribute('uv')
  const merged = mergeGeometries([pole, arm, head], false)
  if (!merged) throw new Error('cobra lamp geometry')
  pole.dispose()
  arm.dispose()
  head.dispose()
  return merged
}

interface Procedural {
  root: Group
  mats: Material[]
  surface: ShaderMaterial
  light: ShaderMaterial
  dispose: () => void
}

/** The procedural road for a layout: surface, lamps, lamp glow. Pure data in, three objects out. */
function buildProcedural(layout: CityLayout, plan: RoadPlan): Procedural {
  const raster = buildRoadRaster(layout, plan.lights)
  const tex = roadTextures(raster)
  const surface = new ShaderMaterial({
    uniforms: {
      uSurf: { value: tex.surface },
      uGlow: { value: tex.glow },
      uSize: { value: raster.size },
      uFade: { value: 1 },
      uWet: { value: 1 },
      uCam: { value: new Vector3() },
      uFog: { value: new Color(FOG_HEX) },
      uDensity: { value: FOG_DENSITY }
    },
    vertexShader: SURF_VERT,
    fragmentShader: SURF_FRAG,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  })

  const root = new Group()
  root.name = 'skyline-roads'
  const plane = new PlaneGeometry(raster.size, raster.size).rotateX(-Math.PI / 2)
  const mesh = new Mesh(plane, surface)
  mesh.position.y = ROAD_Y
  mesh.frustumCulled = false
  mesh.raycast = () => {}
  mesh.name = 'road-surface'
  root.add(mesh)
  const glow = new ShaderMaterial({
    uniforms: { uSurf: { value: tex.surface }, uGlow: { value: tex.glow }, uSize: { value: raster.size }, uFade: { value: 1 } },
    vertexShader: SURF_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6
  })
  const lightMesh = new Mesh(plane, glow)
  lightMesh.position.y = ROAD_Y + 0.004
  lightMesh.frustumCulled = false
  lightMesh.raycast = () => {}
  lightMesh.renderOrder = 2
  lightMesh.name = 'road-light'
  root.add(lightMesh)

  // Lamps: poles and heads, the head glow, and the glow points.
  const pole = new MeshStandardMaterial({ color: '#2a2e38', roughness: 0.55, metalness: 0.4, transparent: true, opacity: 1 })
  const headMat = new MeshBasicMaterial({ color: new Color(2.4, 1.9, 1.3), toneMapped: false, transparent: true, opacity: 1 })
  const glowTex = glowTexture()
  const glowMat = new PointsMaterial({
    map: glowTex, size: 6, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 1, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  })
  const cobra = cobraGeometry()
  const bulb = new BoxGeometry(0.085, 0.012, 0.075).translate(0, HEAD_Y - 0.004, -ARM_REACH)
  const m4 = new Matrix4()
  const q = new Quaternion()
  const pos = new Vector3()
  const scl = new Vector3(1, 1, 1)
  const lamps = plan.lights
  const poleMesh = new InstancedMesh(cobra, pole, Math.max(1, lamps.length))
  const headMesh = new InstancedMesh(bulb, headMat, Math.max(1, lamps.length))
  const glowPos: number[] = []
  const glowCol: number[] = []
  const colour = new Color()
  lamps.forEach((l, i) => {
    const [ax, az] = lampArmDirection(l.rot)
    const yaw = Math.atan2(-ax, -az)
    q.setFromAxisAngle(UP, yaw)
    m4.compose(pos.set(l.x, ROAD_Y, l.z), q, scl)
    poleMesh.setMatrixAt(i, m4)
    headMesh.setMatrixAt(i, m4)
    glowPos.push(l.x + ax * ARM_REACH, ROAD_Y + HEAD_Y, l.z + az * ARM_REACH)
    colour.copy(i % 3 === 2 ? COOL : WARM).multiplyScalar(GLOW_GAIN)
    glowCol.push(colour.r, colour.g, colour.b)
  })
  for (const m of [poleMesh, headMesh]) {
    m.count = lamps.length
    m.instanceMatrix.needsUpdate = true
    m.frustumCulled = false
    m.raycast = () => {}
    root.add(m)
  }
  const glowGeo = new BufferGeometry()
  glowGeo.setAttribute('position', new Float32BufferAttribute(glowPos, 3))
  glowGeo.setAttribute('color', new Float32BufferAttribute(glowCol, 3))
  const points = new Points(glowGeo, glowMat)
  points.frustumCulled = false
  points.raycast = () => {}
  root.add(points)

  return {
    root,
    mats: [pole, headMat, glowMat],
    surface,
    light: glow,
    dispose: () => {
      root.traverse((o) => { if (o instanceof InstancedMesh) o.dispose() })
      plane.dispose()
      cobra.dispose()
      bulb.dispose()
      glowGeo.dispose()
      surface.dispose()
      glow.dispose()
      pole.dispose()
      headMat.dispose()
      glowMat.dispose()
      glowTex.dispose()
      tex.surface.dispose()
      tex.glow.dispose()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Kenney tiles (stylized building style only)

/** Builds the Kenney road tiles and lamps for one plan. Models must be loaded (their geometry is shared, not owned). */
function buildKenney(plan: RoadPlan, models: ReadonlyMap<string, LoadedModel>, instant: boolean): { root: Group; mats: Material[]; dispose: () => void } {
  const any = models.values().next().value as LoadedModel | undefined
  const map = any?.map ?? null
  const road = new MeshStandardMaterial({
    map, color: '#c4cad8', roughness: 0.35, metalness: 0.1,
    transparent: true, opacity: instant ? 1 : 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  })
  const lamp = new MeshStandardMaterial({
    map, color: '#ffffff', roughness: 0.5, metalness: 0.35,
    transparent: true, opacity: instant ? 1 : 0
  })
  const glowTex = glowTexture()
  const glow = new PointsMaterial({
    map: glowTex, size: 7, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: instant ? 1 : 0, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  })

  const root = new Group()
  root.name = 'skyline-roads'
  const m4 = new Matrix4()
  const q = new Quaternion()
  const pos = new Vector3()
  const scl = new Vector3()
  const place = (i: number, x: number, y: number, z: number, rot: number, s: number, mesh: InstancedMesh) => {
    q.setFromAxisAngle(UP, rot)
    m4.compose(pos.set(x, y, z), q, scl.set(s, 1, s))
    mesh.setMatrixAt(i, m4)
  }

  const byModel = new Map<string, RoadTile[]>()
  for (const t of plan.tiles) {
    const list = byModel.get(t.model)
    if (list) list.push(t)
    else byModel.set(t.model, [t])
  }
  for (const [id, tiles] of byModel) {
    const geo = models.get(id)?.geometry
    if (!geo) continue
    const mesh = new InstancedMesh(geo, road, tiles.length)
    tiles.forEach((t, i) => place(i, t.x, ROAD_Y, t.z, t.rot, t.scale, mesh))
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    root.add(mesh)
  }

  const lampsByModel = new Map<string, typeof plan.lights>()
  for (const l of plan.lights) {
    const list = lampsByModel.get(l.model)
    if (list) list.push(l)
    else lampsByModel.set(l.model, [l])
  }
  const glowPos: number[] = []
  const glowCol: number[] = []
  for (const [id, lamps] of lampsByModel) {
    const geo = models.get(id)?.geometry
    if (!geo) continue
    const mesh = new InstancedMesh(geo, lamp, lamps.length)
    lamps.forEach((l, i) => {
      const t = lampTransform(id as 'light-square' | 'light-curved', l.x, l.z, l.rot)
      place(i, t.origin.x, ROAD_Y, t.origin.z, l.rot, 1, mesh)
      glowPos.push(t.bulb.x, ROAD_Y + t.bulb.y, t.bulb.z)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    root.add(mesh)
  }
  const colour = new Color()
  for (let i = 0; i < glowPos.length / 3; i++) {
    colour.copy(i % 3 === 2 ? COOL : WARM).multiplyScalar(GLOW_GAIN)
    glowCol.push(colour.r, colour.g, colour.b)
  }
  const glowGeo = new BufferGeometry()
  glowGeo.setAttribute('position', new Float32BufferAttribute(glowPos, 3))
  glowGeo.setAttribute('color', new Float32BufferAttribute(glowCol, 3))
  const points = new Points(glowGeo, glow)
  points.frustumCulled = false
  points.raycast = () => {}
  root.add(points)

  return {
    root,
    mats: [road, lamp, glow],
    dispose: () => {
      root.traverse((o) => { if (o instanceof InstancedMesh) o.dispose() })
      glowGeo.dispose()
      road.dispose()
      lamp.dispose()
      glow.dispose()
      glowTex.dispose()
    }
  }
}

function KenneyRoads({ plan }: { plan: RoadPlan }) {
  const root = useSky((s) => s.repo?.root ?? null)
  const host = useRef<Group>(null)
  const fade = useRef<{ start: number; mats: Material[] } | null>(null)
  const lastRoot = useRef<string | null>(null)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    let cancelled = false
    let built: { root: Group; dispose: () => void } | null = null
    const ids = [...new Set([...plan.tiles.map((t) => t.model), ...plan.lights.map((l) => l.model)])]
    loadModels(ids).then((list) => {
      if (cancelled) return
      const models = new Map(list.map((m) => [m.def.id, m] as const))
      const fresh = root !== lastRoot.current && !useSky.getState().reducedMotion
      lastRoot.current = root
      const b = buildKenney(plan, models, !fresh)
      built = b
      parent.add(b.root)
      if (fresh) fade.current = { start: performance.now(), mats: b.mats }
    }).catch((err) => console.warn('roads: models failed to load', err))
    return () => {
      cancelled = true
      fade.current = null
      if (built) {
        parent.remove(built.root)
        built.dispose()
      }
    }
    // root only matters for the fade decision; a new plan is what rebuilds.
  }, [plan])

  useFrame(() => {
    const f = fade.current
    if (!f) return
    const t = Math.min(1, (performance.now() - f.start) / FADE_MS)
    const e = t * t * (3 - 2 * t)
    for (const m of f.mats) m.opacity = e
    if (t >= 1) fade.current = null
  })

  return <group ref={host} />
}

function ProceduralRoads({ layout, plan }: { layout: CityLayout; plan: RoadPlan }) {
  const root = useSky((s) => s.repo?.root ?? null)
  const built = useMemo(() => buildProcedural(layout, plan), [layout, plan])
  const host = useRef<Group>(null)
  const lastRoot = useRef<string | null>(null)
  const fade = useRef<number | null>(null)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    parent.add(built.root)
    // A new repo fades in; live refreshes of the same repo appear at once.
    const fresh = root !== lastRoot.current && !useSky.getState().reducedMotion
    lastRoot.current = root
    if (fresh) {
      fade.current = performance.now()
      for (const m of built.mats) (m as Material & { opacity: number }).opacity = 0
      built.surface.uniforms.uFade!.value = 0
      built.light.uniforms.uFade!.value = 0
    }
    return () => {
      parent.remove(built.root)
    }
  }, [built, root])

  useEffect(() => () => built.dispose(), [built])

  useEffect(() => {
    const w = window as unknown as typeof window
    const junctions = buildLanes(layout).nodes
      .filter((n) => n.segments.length >= 3)
      .map((n) => ({ x: n.x, z: n.z }))
    w.__skylineRoads = () => ({ tiles: plan.tiles, lights: plan.lights, junctions })
    return () => { delete w.__skylineRoads }
  }, [layout, plan])

  useFrame(({ camera }) => {
    built.surface.uniforms.uCam!.value.copy(camera.position)
    const start = fade.current
    if (start === null) return
    const t = Math.min(1, (performance.now() - start) / FADE_MS)
    const e = t * t * (3 - 2 * t)
    for (const m of built.mats) (m as Material & { opacity: number }).opacity = e
    built.surface.uniforms.uFade!.value = e
    built.light.uniforms.uFade!.value = e
    if (t >= 1) fade.current = null
  })

  return <group ref={host} />
}

/** Road network for the current layout: the procedural road, or the Kenney tiles for the stylized building style. */
export function Roads() {
  const layout = useSky((s) => s.layout)
  const stylized = useStylized()
  const plan = useMemo(() => (layout ? buildRoadPlan(layout) : null), [layout])
  if (!layout || !plan) return null
  return stylized ? <KenneyRoads plan={plan} /> : <ProceduralRoads layout={layout} plan={plan} />
}
