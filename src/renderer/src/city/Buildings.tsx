// The building field as a React component: rebuilds on layout change, steps the animation each frame, and turns
// pointer events on instances into hover and select actions. The assets load in the background: the Kenney models (the
// stylized style, over the procedural boxes), and for the real style the photographic facade atlas and the kit towers.
// Until they are in, the buildings show their boxes or their massing, then crossfade.
import { useEffect, useMemo, useReducer, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Color, type Texture } from 'three'
import { useSky } from '../state/store'
import { BuildingField } from './BuildingField'
import { createBuildingMaterials, prepareModelMaterial, type BuildingMaterials } from './buildingShader'
import { agentHex, resolveHeat } from './data'
import { isClick } from './registry'
import { loadModels, type LoadedModel } from './assets'
import { locByPath } from './modelPicker'
import { throttle } from './picking'
import { loadKit, applyKitTextures, type KitData } from './kit'
import './dev/layers'
import { loadFacadeAtlas } from './facade/photo/atlas'
import { setFacadeAtlas } from './facade/photo/material'

/** Hover updates reach the store at most this often (20 Hz). */
const HOVER_MS = 50

export interface SkylineStats {
  /** Draw calls and triangles of the last frame (all render passes of the frame). */
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Building field only: instanced meshes in the scene, and the triangles they draw per frame. */
  buildingMeshes: number;
  buildingTriangles: number;
}

declare global {
  interface Window {
    __skylineStats?: () => SkylineStats;
  }
}

/** Models already in memory, by id. Filled once: later fields start with them and skip the box fallback. */
const loaded = new Map<string, LoadedModel>()
/** The kit towers, once loaded (real style). Later fields start with them. */
let kitReady: KitData | null = null

/** Loads the given models and points the model material at the shared colormap. */
async function loadAll(ids: string[], mats: BuildingMaterials): Promise<ReadonlyMap<string, LoadedModel>> {
  if (ids.every((id) => loaded.has(id))) return loaded
  const models = await loadModels(ids)
  for (const m of models) loaded.set(m.def.id, m)
  const first = models[0]
  if (first) prepareModelMaterial(mats.models, first.map as Texture)
  return loaded
}

export function Buildings() {
  const gl = useThree((s) => s.gl)
  const layout = useSky((s) => s.layout)
  const mode = useSky((s) => s.mode)
  const gitTs = useSky((s) => s.gitTs)
  const firstSeen = useSky((s) => s.firstSeen)
  const hoveredPath = useSky((s) => s.hoveredPath)
  const selectedPath = useSky((s) => s.selectedPath)
  const plan = useSky((s) => s.colorPlan)
  const style = useSky((s) => s.buildingStyle)

  const fieldRef = useRef<BuildingField | null>(null)
  const lastFrameMs = useRef<number | null>(null)
  const mats = useMemo(() => createBuildingMaterials(), [])
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const prevRef = useRef<BuildingField | null>(null)
  // The field is rebuilt only with the layout, so it reads the current colors from here. A color mode change
  // reaches the existing field through setColors (animated), not a rebuild.
  const colorsRef = useRef<ReadonlyMap<string, string> | null>(null)
  colorsRef.current = plan?.colors ?? null

  // Built during render from the last committed field, so the animation state carries over. A style change rebuilds
  // the field (the facades and the Kenney models are different meshes).
  const field = useMemo(() => {
    if (!layout) return null
    const s = useSky.getState()
    return new BuildingField(layout, mats, prevRef.current, {
      style,
      mode: s.mode,
      gitTs: s.gitTs,
      firstSeen: s.firstSeen,
      colors: colorsRef.current,
      loc: locByPath(s.repo?.files ?? []),
      models: loaded,
      kit: kitReady
    })
  }, [layout, mats, style])

  fieldRef.current = field

  useEffect(() => {
    if (field && plan) field.setColors(plan.colors)
  }, [field, plan])

  useEffect(() => {
    prevRef.current = field
    if (field) field.onChange = bump
    return () => field?.dispose()
  }, [field])

  // Models arrive in the background; the field keeps its boxes until they are here, then crossfades.
  useEffect(() => {
    if (!field || field.hasModels) return
    let live = true
    loadAll(field.modelIds(), mats)
      .then((models) => {
        if (live) field.adoptModels(models)
      })
      .catch((err: unknown) => {
        console.warn('city models unavailable, keeping the boxes', err)
      })
    return () => {
      live = false
    }
  }, [field, mats])

  // Real style: the facade atlas binds once it is in; the kit towers rise over their massing when they are in.
  useEffect(() => {
    let live = true
    loadFacadeAtlas({ maxAnisotropy: gl.capabilities.getMaxAnisotropy() })
      .then((atlas) => {
        if (live) setFacadeAtlas(mats.facade, atlas)
      })
      .catch((err: unknown) => {
        console.warn('facade atlas unavailable, keeping the massing in placeholder colours', err)
      })
    return () => {
      live = false
    }
  }, [gl, mats])

  useEffect(() => {
    if (!field || field.hasKit || style !== 'real') return
    let live = true
    loadKit()
      .then((kit) => {
        if (!live) return
        kitReady = kit
        applyKitTextures(mats.kit, kit.textures)
        field.adoptKit(kit)
      })
      .catch((err: unknown) => {
        console.warn('city kit unavailable, keeping the massing', err)
      })
    return () => {
      live = false
    }
  }, [field, mats, style])

  useEffect(() => {
    field?.retarget(mode, gitTs, firstSeen)
  }, [field, mode, gitTs, firstSeen])

  useEffect(() => {
    field?.setHighlight(hoveredPath, selectedPath)
  }, [field, hoveredPath, selectedPath])

  // Stats for the verification harness: gl.info counts the whole frame (all passes) between two resets.
  useEffect(() => {
    gl.info.autoReset = false
    window.__skylineStats = () => {
      const f = fieldRef.current
      return {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        buildingMeshes: f ? f.meshes.filter((m) => m.count > 0).length : 0,
        buildingTriangles: f ? f.triangleCount : 0
      }
    }
    return () => {
      delete window.__skylineStats
    }
  }, [gl])

  // Colors are cached per hex so the frame loop does not allocate.
  const colorByHex = useMemo(() => new Map<string, Color>(), [])
  const colorOf = useMemo(() => (agentId: string): Color => {
    const hex = agentHex(agentId, useSky.getState().agents)
    let c = colorByHex.get(hex)
    if (!c) {
      c = new Color(hex)
      colorByHex.set(hex, c)
    }
    return c
  }, [colorByHex])

  const hoverSoon = useMemo(
    () => throttle((p: string | null) => useSky.getState().hover(p), HOVER_MS),
    []
  )
  useEffect(() => () => hoverSoon.cancel(), [hoverSoon])

  useFrame((state, dt) => {
    gl.info.reset()
    const f = fieldRef.current
    if (!f) return
    mats.time.value = state.clock.elapsedTime
    const s = useSky.getState()
    // Natural is untinted; the data modes tint the lit windows, the crown and a little of the wall.
    mats.tint.value = s.colorMode === 'natural' ? 0 : 1
    const now = s.mode === 'replay' && s.replayTs !== null ? s.replayTs : Date.now()
    const now0 = performance.now()
    const realDt = lastFrameMs.current === null ? dt : (now0 - lastFrameMs.current) / 1000
    lastFrameMs.current = now0
    f.step(Math.min(dt, 0.05), realDt)
    f.applyHeat(now, resolveHeat(s), colorOf)
    f.commit()
  })

  if (!field) return null

  return (
    <>
      {field.meshes.map((mesh) => (
        <primitive
          key={mesh.uuid}
          object={mesh}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation()
            const path = e.instanceId !== undefined ? field.pathAt(mesh, e.instanceId) : null
            hoverSoon(path)
            document.body.style.cursor = path ? 'pointer' : ''
          }}
          onPointerOut={() => {
            hoverSoon.cancel()
            useSky.getState().hover(null)
            document.body.style.cursor = ''
          }}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            if (!isClick(e.clientX, e.clientY)) return
            e.stopPropagation()
            const path = e.instanceId !== undefined ? field.pathAt(mesh, e.instanceId) : null
            if (path) useSky.getState().select(path)
          }}
        />
      ))}
    </>
  )
}
