// Road network: Kenney road pieces instanced per model in the streets between district plates, street lamps
// (instanced, no per-lamp lights) and one additive glow layer for the lamp heads, so bloom picks them up.
// The plan is pure (streets.ts) and memoised per layout object. Roads sit at ROAD_Y, above the ground and
// under the plates' outlines; the plates are taller than the road surface, so plate edges never z-fight.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, InstancedMesh,
  Material, Matrix4, MeshStandardMaterial, Points, PointsMaterial, Quaternion, SRGBColorSpace, Texture, Vector3
} from 'three'
import { useSky } from '../state/store'
import { loadModels, type LoadedModel } from './assets'
import { buildRoadPlan, lampTransform, ROAD_Y, type RoadPlan, type RoadTile } from './streets'

const FADE_MS = 800
const UP = new Vector3(0, 1, 0)
const WARM = new Color('#ffc27a')
const COOL = new Color('#9fd6ff')
/** Glow colour multiplier: above the bloom threshold, so the lamp heads bloom. */
const GLOW_GAIN = 2.2

interface Built {
  root: Group
  mats: Material[]
  dispose: () => void
}

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

/** Builds the instanced meshes for one plan. Models must be loaded (their geometry is shared, not owned). */
function buildGroup(plan: RoadPlan, models: ReadonlyMap<string, LoadedModel>, instant: boolean): Built {
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
    mesh.raycast = () => {} // roads never take clicks from the plates or buildings beneath
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
  // Lamp heads in one points layer, alternating warm sodium and cool LED tints.
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

/** Road network for the current layout: memoised per layout object, fades in once per repo. */
export function Roads() {
  const layout = useSky((s) => s.layout)
  const root = useSky((s) => s.repo?.root ?? null)
  const plan = useMemo(() => (layout ? buildRoadPlan(layout) : null), [layout])
  const host = useRef<Group>(null)
  const fade = useRef<{ start: number; mats: Material[] } | null>(null)
  const lastRoot = useRef<string | null>(null)

  useEffect(() => {
    const parent = host.current
    if (!plan || !parent) return
    let cancelled = false
    let built: Built | null = null
    const ids = [...new Set([...plan.tiles.map((t) => t.model), ...plan.lights.map((l) => l.model)])]
    loadModels(ids).then((list) => {
      if (cancelled) return
      const models = new Map(list.map((m) => [m.def.id, m] as const))
      // A new repo fades in; live refreshes of the same repo swap quietly.
      const fresh = root !== lastRoot.current && !useSky.getState().reducedMotion
      lastRoot.current = root
      built = buildGroup(plan, models, !fresh)
      parent.add(built.root)
      if (fresh) fade.current = { start: performance.now(), mats: built.mats }
    }).catch((err) => console.warn('roads: models failed to load', err))
    return () => {
      cancelled = true
      fade.current = null
      if (built) {
        parent.remove(built.root)
        built.dispose()
      }
    }
    // root only matters for the fade decision; a new layout is what rebuilds.
  }, [plan])

  useEffect(() => {
    const w = window as unknown as { __skylineRoads?: () => { tiles: RoadTile[]; lights: RoadPlan['lights'] } }
    if (!plan) return
    w.__skylineRoads = () => ({ tiles: plan.tiles, lights: plan.lights })
    return () => { delete w.__skylineRoads }
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
