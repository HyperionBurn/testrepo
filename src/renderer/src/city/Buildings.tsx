// The building field as a React component: rebuilds on layout change, steps the animation each
// frame, and turns pointer events on instances into hover and select actions.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Color } from 'three'
import { useSky } from '../state/store'
import { BuildingField } from './BuildingField'
import { createBuildingMaterial } from './buildingShader'
import { agentHex, resolveHeat } from './data'
import { isClick } from './registry'

export function Buildings() {
  const layout = useSky((s) => s.layout)
  const mode = useSky((s) => s.mode)
  const gitTs = useSky((s) => s.gitTs)
  const firstSeen = useSky((s) => s.firstSeen)
  const hoveredPath = useSky((s) => s.hoveredPath)
  const selectedPath = useSky((s) => s.selectedPath)
  const plan = useSky((s) => s.colorPlan)

  const shader = useMemo(() => createBuildingMaterial(), [])
  const prevRef = useRef<BuildingField | null>(null)
  // The field is rebuilt only with the layout, so it reads the current colors from here. A color mode change
  // reaches the existing field through setColors (animated), not a rebuild.
  const colorsRef = useRef<ReadonlyMap<string, string> | null>(null)
  colorsRef.current = plan?.colors ?? null

  // Built during render from the last committed field, so the animation state carries over.
  const field = useMemo(() => {
    if (!layout) return null
    const s = useSky.getState()
    return new BuildingField(layout, shader.material, prevRef.current, {
      mode: s.mode,
      gitTs: s.gitTs,
      firstSeen: s.firstSeen,
      colors: colorsRef.current
    })
  }, [layout, shader])

  useEffect(() => {
    if (field && plan) field.setColors(plan.colors)
  }, [field, plan])

  useEffect(() => {
    prevRef.current = field
    return () => field?.dispose()
  }, [field])

  useEffect(() => {
    field?.retarget(mode, gitTs, firstSeen)
  }, [field, mode, gitTs, firstSeen])

  useEffect(() => {
    field?.setHighlight(hoveredPath, selectedPath)
  }, [field, hoveredPath, selectedPath])

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

  const fieldRef = useRef<BuildingField | null>(null)
  fieldRef.current = field

  useFrame((state, dt) => {
    const f = fieldRef.current
    if (!f) return
    shader.time.value = state.clock.elapsedTime
    const s = useSky.getState()
    const now = s.mode === 'replay' && s.replayTs !== null ? s.replayTs : Date.now()
    f.step(Math.min(dt, 0.05))
    f.applyHeat(now, resolveHeat(s), colorOf)
    f.commit()
  })

  if (!field) return null

  const pathOf = (e: ThreeEvent<PointerEvent | MouseEvent>): string | null =>
    e.instanceId !== undefined ? field.pathAt(e.instanceId) : null

  return (
    <primitive
      object={field.mesh}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        const path = pathOf(e)
        useSky.getState().hover(path)
        document.body.style.cursor = path ? 'pointer' : ''
      }}
      onPointerOut={() => {
        useSky.getState().hover(null)
        document.body.style.cursor = ''
      }}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (!isClick(e.clientX, e.clientY)) return
        e.stopPropagation()
        const path = pathOf(e)
        if (path) useSky.getState().select(path)
      }}
    />
  )
}
