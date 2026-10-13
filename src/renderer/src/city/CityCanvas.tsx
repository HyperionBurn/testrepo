// The 3D city: a full-bleed R3F canvas that reads the renderer store. The HUD renders above it.
import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
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
// Registers window.__skylineDemo (demo repo and fake agents) for screenshots and manual testing.
import './dev/fixture'

const NO_DISTRICTS: CityDistrict[] = []

function CityDistricts() {
  const districts = useSky((s) => s.layout?.districts ?? NO_DISTRICTS)
  return <Districts districts={districts} />
}

export default function CityCanvas() {
  const reduced = useSky((s) => s.reducedMotion)
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
        dpr={dpr}
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
        {composed && <Effects />}
      </Canvas>
    </div>
  )
}
