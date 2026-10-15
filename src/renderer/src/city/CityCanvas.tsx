// The 3D city: a full-bleed R3F canvas that reads the renderer store. The HUD renders above it.
import { useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three'
import type { CityDistrict } from '@shared/types'
import { useSky } from '../state/store'
import { notePointerDown } from './registry'
import { Sky, FOG_HEX, FOG_DENSITY } from './Sky'
import { Atmosphere } from './Atmosphere'
import { Backdrop } from './Backdrop'
import { Ground, Districts } from './Ground'
import { GroundGlow } from './Glow'
import { Metropolis } from './Metropolis'
import { Water } from './Water'
import { Bridges } from './Bridges'
import { Boats } from './Boats'
import { Helicopters } from './Helicopters'
import { Buildings } from './Buildings'
import { Roads } from './Roads'
import { Scaffolding, Spotlight, ImportArcs } from './Overlays'
import { Drones } from './Drones'
import { FxStage } from './FxStage'
import { Traffic } from './Traffic'
import { Rooftops } from './Rooftops'
import { Signage } from './Signage'
import { Steam } from './Steam'
import { CameraRig } from './CameraRig'
import { Effects } from './Effects'
import { Environment } from './Environment'
import { ShotRig } from './ShotRig'
import { serviceGrab } from './capture'
// Registers window.__skylineDemo (demo repo and fake agents) for screenshots and manual testing.
import './dev/fixture'
import './assets/debug'

const NO_DISTRICTS: CityDistrict[] = []

function CityDistricts() {
  const districts = useSky((s) => s.layout?.districts ?? NO_DISTRICTS)
  const hoods = useSky((s) => s.hoods)
  const areaColors = useSky((s) => s.colorPlan?.areaColors ?? null)
  return <Districts districts={districts} hoods={hoods} areaColors={areaColors} />
}

/**
 * Serves snapshot grabs from inside the frame loop (see capture.ts). Priority 2 runs after the composer, so the
 * drawing buffer holds the finished frame. It also renders the frame itself when the composer is not mounted,
 * because a priority above 0 turns off R3F's automatic render.
 */
function CaptureTap({ composed }: { composed: boolean }) {
  const captureDpr = useSky((s) => s.captureDpr)
  const setSize = useThree((s) => s.setSize)
  const size = useThree((s) => s.size)
  // The composer sizes its buffers from the drawing buffer, which a pixel-ratio change alone does not refresh.
  // Setting the same size again makes R3F hand the composer a new size object, so it resizes.
  useEffect(() => {
    setSize(size.width, size.height)
    // Runs on a DPR change only.
  }, [captureDpr])

  useFrame(({ gl, scene, camera }) => {
    if (!composed) gl.render(scene, camera)
    serviceGrab(gl.domElement, gl.getPixelRatio(), performance.now())
  }, 2)
  return null
}

export default function CityCanvas() {
  const reduced = useSky((s) => s.reducedMotion)
  const captureDpr = useSky((s) => s.captureDpr)
  const capturing = useSky((s) => s.capture !== null)
  const [lowPerf, setLowPerf] = useState(false)
  const [dpr, setDpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2))

  // Tracks where each pointer press started, so camera drags never count as clicks.
  useEffect(() => {
    const down = (e: PointerEvent) => notePointerDown(e.clientX, e.clientY)
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [])

  // A capture always gets the composer (bloom, tone mapping, SMAA), even when the frame rate had degraded it.
  // Once the capture ends the normal rule applies again.
  const composed = capturing || (!reduced && !lowPerf)

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#03040a', overflow: 'hidden' }}>
      <Canvas
        dpr={captureDpr ?? dpr}
        camera={{ position: [0, 330, 0.01], fov: 42, near: 0.5, far: 2000 }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          outputColorSpace: SRGBColorSpace
        }}
      >
        <color attach="background" args={['#03040a']} />
        <fogExp2 attach="fog" args={[FOG_HEX, FOG_DENSITY]} />
        <PerformanceMonitor
          onDecline={() => {
            // A snapshot or flyover renders heavier frames on purpose; do not let that lower the quality for good.
            if (useSky.getState().capture !== null) return
            setLowPerf(true)
            setDpr(1)
          }}
        />
        <Sky />
        <Environment />
        <Backdrop />
        <Atmosphere />
        <Ground />
        <GroundGlow />
        <Metropolis />
        <Water />
        <Bridges />
        <Boats />
        <Helicopters />
        <CityDistricts />
        <Roads />
        <Buildings />
        <Rooftops />
        <Signage />
        <Steam />
        <Scaffolding />
        <Spotlight />
        <ImportArcs />
        <Drones />
        <FxStage />
        <Traffic />
        <CameraRig />
        <ShotRig />
        <CaptureTap composed={composed} />
        {composed && <Effects />}
      </Canvas>
    </div>
  )
}
