// Post-processing chain: bloom for lit windows and lamps, a wide halation glow, ACES tone mapping, the grade
// (split toning, lift, grain), chromatic aberration at the edges, a soft vignette and SMAA.
// Only mounted when the GPU keeps up and reduced motion is off (CityCanvas); otherwise the scene renders directly.
// Quality steps down on its own when the frame rate sags: halation first, then grain and aberration, then the
// bloom radius. A capture always renders at level 0.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Bloom, ChromaticAberration, EffectComposer, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { Vector2 } from 'three'
import { useSky } from '../state/store'
import { GradeEffect } from './Grade'
import { GRADES, MAX_DEGRADE_LEVEL, degradeGrade } from './gradeParams'

/** Frame times (seconds) that step quality down and back up. Hysteresis keeps it from flapping. */
const SLOW_FRAME = 1 / 30
const FAST_FRAME = 1 / 50
const STEP_DOWN_AFTER = 3 // seconds of slow frames
const STEP_UP_AFTER = 8 // seconds of fast frames

/** The degradation level, 0 (full) to MAX_DEGRADE_LEVEL. Frozen while `watching` is false. */
function useDegradeLevel(watching: boolean): number {
  const [level, setLevel] = useState(0)
  const slow = useRef(0)
  const fast = useRef(0)
  const current = useRef(0)

  useFrame((_, dt) => {
    if (!watching) return
    if (dt > SLOW_FRAME) {
      slow.current += dt
      fast.current = 0
    } else if (dt < FAST_FRAME) {
      fast.current += dt
      slow.current = 0
    } else {
      slow.current = 0
      fast.current = 0
    }
    if (slow.current >= STEP_DOWN_AFTER && current.current < MAX_DEGRADE_LEVEL) {
      current.current += 1
      slow.current = 0
      setLevel(current.current)
    } else if (fast.current >= STEP_UP_AFTER && current.current > 0) {
      current.current -= 1
      fast.current = 0
      setLevel(current.current)
    }
  })
  return level
}

export function Effects() {
  const reduced = useSky((s) => s.reducedMotion)
  const capturing = useSky((s) => s.capture !== null)
  const tod = useSky((s) => s.timeOfDay)
  const degrade = useDegradeLevel(!capturing)
  const level = capturing ? 0 : degrade

  // The composer owns the effect's passes and releases them on unmount; Effect has no dispose of its own.
  const grade = useMemo(() => new GradeEffect(), [])

  const params = useMemo(() => degradeGrade(GRADES[tod], level), [tod, level])
  useEffect(() => {
    grade.apply(params, !reduced)
  }, [grade, params, reduced])

  const aberration = useMemo(() => new Vector2(params.ca, params.ca), [params.ca])

  return (
    <EffectComposer multisampling={0}>
      <Bloom
        mipmapBlur
        luminanceThreshold={params.bloom.threshold}
        luminanceSmoothing={0.2}
        intensity={params.bloom.intensity}
        radius={params.bloom.radius}
      />
      {params.halation.intensity > 0 ? (
        <Bloom
          mipmapBlur
          luminanceThreshold={params.halation.threshold}
          luminanceSmoothing={0.3}
          intensity={params.halation.intensity}
          radius={params.halation.radius}
        />
      ) : <></>}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      {params.ca > 0 ? <ChromaticAberration offset={aberration} radialModulation modulationOffset={0.15} /> : <></>}
      <primitive object={grade} dispose={null} />
      <Vignette eskil={false} offset={0.22} darkness={params.vignette} />
      <SMAA />
    </EffectComposer>
  )
}
