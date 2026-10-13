// The 3D city: a full-bleed R3F canvas that reads the renderer store. The HUD renders above it.
import { useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three'
import type { CityDistrict } from '@shared/types'
import { useSky } from '../state/store'
import { notePointerDown } from './registry'
import { Sky, FOG_HEX, FOG_DENSITY } from './Sky'
import { Ground, Districts } from './Ground'
import { Buildings } from './Buildings'
import { Scaffolding, Spotlight, ImportArcs } from './Overlays'
import { Drones } from './Drones'
import { CameraRig } from './CameraRig'
import { Effects } from './Effects'
import { serviceGrab } from './capture'
// Registers window.__skylineDemo (demo repo and fake agents) for screenshots and manual testing.
import './dev/fixture'

const NO_DISTRICTS: CityDistrict[] = []

function CityDistricts() {
  const districts = useSky((s) => s.layout?.districts ?? NO_DISTRICTS)
  return <Districts districts={districts} />
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
  const [lowPerf, setLowPerf] = useState(false)
  const [dpr, setDpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2))

  // Tracks where each pointer press started, so camera drags never count as clicks.
  useEffect(() => {
    const down = (e: PointerEvent) => notePointerDown(e.clientX, e.clientY)
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [])

  const composed = !reduced && !lowPerf

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#03040a', overflow: 'hidden' }}>
      <Canvas
        dpr={captureDpr ?? dpr}
        camera={{ position: [0, 330, 0.01], fov: 36, near: 0.5, far: 2000 }}
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
            setLowPerf(true)
            setDpr(1)
          }}
        />
        <Sky />
        <Ground />
        <CityDistricts />
        <Buildings />
        <Scaffolding />
        <Spotlight />
        <ImportArcs />
        <Drones />
        <CameraRig />
        <CaptureTap composed={composed} />
        {composed && <Effects />}
      </Canvas>
    </div>
  )
}
