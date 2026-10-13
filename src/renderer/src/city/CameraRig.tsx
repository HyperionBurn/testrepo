// Camera: a cinematic intro swoop, smooth fly-to for the selected building or focused drone,
// damped orbit controls, and a slow auto-orbit after 25 s without input.
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Spherical, Vector3 } from 'three'
import { findBuilding } from '@shared/layout'
import { visCenter } from './geom'
import { useSky } from '../state/store'
import { getDroneVec } from './registry'

const INTRO_S = 2.5
const FLY_S = 0.9
const IDLE_ROTATE_MS = 25000
const MIN_FLY_DIST = 26
const MAX_FLY_DIST = 60
const CITY_MAX_DIST = 180
const INTRO_MAX_DIST = 420

interface Controls {
  target: Vector3;
  enabled: boolean;
  autoRotate: boolean;
  autoRotateSpeed: number;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
  addEventListener(type: 'start', fn: () => void): void;
  removeEventListener(type: 'start', fn: () => void): void;
}

interface Fly {
  t0: number;
  fromPos: Vector3;
  fromTarget: Vector3;
  offset: Vector3;
  getTarget: () => Vector3 | null;
}

type Pending = { kind: 'building'; path: string } | { kind: 'drone'; id: string }

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))

const FROM = { r: 330, phi: 0.06, theta: 0 }
const TO = { r: 180, phi: 0.95, theta: 0.72 }

export function CameraRig() {
  const reduced = useSky((s) => s.reducedMotion)
  const controlsRef = useRef<Controls | null>(null)
  const intro = useRef<{ start: number | null; done: boolean }>({ start: null, done: false })
  const fly = useRef<Fly | null>(null)
  const pending = useRef<Pending | null>(null)
  const lastInput = useRef(performance.now())
  const scratch = useRef({ tmp: new Vector3(), end: new Vector3(), sph: new Spherical() }).current

  // Input resets the idle timer and stops the auto-orbit.
  useEffect(() => {
    const onStart = () => {
      lastInput.current = performance.now()
    }
    const unsubscribe = useSky.subscribe((s, prev) => {
      if (s.selectedPath !== prev.selectedPath && s.selectedPath) {
        pending.current = { kind: 'building', path: s.selectedPath }
        lastInput.current = performance.now()
      }
      if (s.focusAgentId !== prev.focusAgentId && s.focusAgentId) {
        pending.current = { kind: 'drone', id: s.focusAgentId }
        lastInput.current = performance.now()
      }
    })
    // Controls mount before this effect runs (refs attach during commit).
    const c = controlsRef.current
    c?.addEventListener('start', onStart)
    return () => {
      c?.removeEventListener('start', onStart)
      unsubscribe()
    }
  }, [])

  useFrame(({ camera, clock }) => {
    const controls = controlsRef.current
    if (!controls) return
    const now = performance.now()
    const t = clock.elapsedTime

    // Intro: the camera swings from high above into a three-quarter view.
    if (!intro.current.done) {
      if (intro.current.start === null) {
        intro.current.start = t
        controls.enabled = false
        controls.maxDistance = INTRO_MAX_DIST
        controls.minPolarAngle = 0
      }
      const u = reduced ? 1 : clamp01((t - intro.current.start) / INTRO_S)
      const e = easeInOut(u)
      const sph = scratch.sph
      sph.radius = FROM.r + (TO.r - FROM.r) * e
      sph.phi = FROM.phi + (TO.phi - FROM.phi) * e
      sph.theta = FROM.theta + (TO.theta - FROM.theta) * e
      camera.position.setFromSpherical(sph).add(controls.target)
      camera.lookAt(controls.target)
      if (u >= 1) {
        intro.current.done = true
        controls.enabled = true
        controls.maxDistance = CITY_MAX_DIST
        controls.minPolarAngle = 0.15
        lastInput.current = now
      }
      return
    }

    // Start a fly-to from a pending selection or focus.
    const p = pending.current
    if (p) {
      pending.current = null
      const getTarget = (): Vector3 | null => {
        if (p.kind === 'drone') return getDroneVec(p.id) ?? null
        const L = useSky.getState().layout
        const b = L ? findBuilding(L, p.path) : undefined
        if (!b) return null
        const c = visCenter(b)
        return scratch.tmp.set(c.x, c.y * 0.6, c.z)
      }
      const first = getTarget()
      if (first) {
        const offset = new Vector3().subVectors(camera.position, controls.target)
        offset.setLength(Math.min(MAX_FLY_DIST, Math.max(MIN_FLY_DIST, offset.length())))
        fly.current = {
          t0: t,
          fromPos: camera.position.clone(),
          fromTarget: controls.target.clone(),
          offset,
          getTarget
        }
      }
    }

    const f = fly.current
    if (f) {
      const target = f.getTarget()
      if (!target) {
        fly.current = null
      } else {
        const u = reduced ? 1 : clamp01((t - f.t0) / FLY_S)
        const e = easeInOut(u)
        controls.target.lerpVectors(f.fromTarget, target, e)
        scratch.end.addVectors(target, f.offset)
        camera.position.lerpVectors(f.fromPos, scratch.end, e)
        if (u >= 1) fly.current = null
      }
    }

    // Idle auto-orbit.
    const idle = !reduced && !fly.current && now - lastInput.current > IDLE_ROTATE_MS
    controls.autoRotate = idle
    controls.autoRotateSpeed = 0.45
  })

  return (
    <OrbitControls
      ref={controlsRef as never}
      makeDefault
      enableDamping
      dampingFactor={0.07}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      minDistance={18}
      maxDistance={CITY_MAX_DIST}
      minPolarAngle={0.15}
      maxPolarAngle={1.35}
    />
  )
}
