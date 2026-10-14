// Drives the agent FX: relays fresh store events into the FX bus, steps every FX system once per frame, and
// exposes window.__skylineFxStep(seconds) to fast-forward the simulation deterministically (SwiftShader runs
// at about 1 fps, so screenshots cannot wait for real time). Mounts the construction, burst and popup layers.
import { useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { fxStats, startRelay, stepFx } from './fx/core'
import { FxBursts } from './FxBursts'
import { FxConstruction } from './FxConstruction'
import { FxPopups } from './FxPopups'

declare global {
  interface Window {
    /** Advances the FX simulation by `seconds` in fixed 1/30 s steps. Test and screenshot hook. */
    __skylineFxStep?: (seconds: number) => void
    /** Live counts of the FX pools (sites, ships, rings, particles, popups). Diagnostics hook. */
    __skylineFxStats?: () => Record<string, number>
  }
}

const FIXED_DT = 1 / 30

export function FxStage() {
  useEffect(() => startRelay(), [])
  useEffect(() => {
    window.__skylineFxStep = (seconds: number) => {
      const steps = Math.max(0, Math.round(seconds / FIXED_DT))
      for (let i = 0; i < steps; i++) stepFx(FIXED_DT, null, 0)
    }
    window.__skylineFxStats = fxStats
    return () => {
      delete window.__skylineFxStep
      delete window.__skylineFxStats
    }
  }, [])
  useFrame((state, dt) => {
    stepFx(Math.min(dt, 0.05), state.camera, state.gl.domElement.height)
  })
  return (
    <>
      <FxBursts />
      <FxConstruction />
      <FxPopups />
    </>
  )
}
