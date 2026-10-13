// Camera: an intro swoop that ends framed on the whole city, a glide back to that framing on repo open and
// on F, smooth fly-to for the selected building or focused drone, a cinematic flyover for recordings,
// damped orbit controls and a slow auto-orbit after 25 s without input.
// The framing keeps the orbit target centred in the part of the window the HUD leaves free (see framing.ts).
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Spherical, Vector3, type Camera, type PerspectiveCamera } from 'three'
import { findBuilding } from '@shared/layout'
import { visCenter } from './geom'
import { useSky } from '../state/store'
import { useUi } from '../lib/ui'
import { getDroneVec } from './registry'
import {
  DEFAULT_MAX_HEIGHT,
  framePose,
  maxBuildingHeight,
  viewOffset,
  visibleRegion,
  type FrameMode,
  type FramePose,
  type Rect
} from './framing'
import { clearFlyoverCancel, flyoverCancelled, setCameraSettled, takeFlyoverRequest, type FlyoverRequest } from './capture'

const INTRO_S = 2.5
const FLY_S = 0.9
const FRAME_S = 1.1
const APPROACH_S = 1.0
const IDLE_ROTATE_MS = 25000
const MIN_FLY_DIST = 26
const MAX_FLY_DIST = 60
const CITY_MAX_DIST = 520
const INTRO_MAX_DIST = 420
/** Flyover opening shot: higher and farther out than the framed view, descending into it during the orbit. */
const FLY_HIGH_SCALE = 1.3
const FLY_HIGH_PHI = 0.4

const FROM = { r: 330, phi: 0.06, theta: 0 }

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

/** A camera pose as an orbit around a target. */
interface Sph {
  radius: number;
  phi: number;
  theta: number;
  target: Vector3;
}

interface Fly {
  t0: number;
  fromPos: Vector3;
  fromTarget: Vector3;
  offset: Vector3;
  getTarget: () => Vector3 | null;
}

interface Tween {
  t0: number;
  from: Sph;
}

interface Flight {
  req: FlyoverRequest;
  phase: 'approach' | 'orbit';
  t0: number;
  dur: number;
  from: Sph;
  high: Sph;
}

interface Framed {
  key: string;
  pose: Sph;
  offset: { x: number; y: number };
}

type Pending = { kind: 'building'; path: string } | { kind: 'drone'; id: string }

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const TWO_PI = Math.PI * 2

/** Shortest signed angle from a to b, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI
  if (d > Math.PI) d -= TWO_PI
  if (d <= -Math.PI) d += TWO_PI
  return d
}

function sphOf(camera: Camera, target: Vector3): Sph {
  const s = new Spherical().setFromVector3(new Vector3().subVectors(camera.position, target))
  return { radius: s.radius, phi: s.phi, theta: s.theta, target: target.clone() }
}

function toSph(p: FramePose): Sph {
  return { radius: p.radius, phi: p.phi, theta: p.theta, target: new Vector3(p.target.x, p.target.y, p.target.z) }
}

function lerpSph(a: Sph, b: Sph, e: number): Sph {
  return {
    radius: lerp(a.radius, b.radius, e),
    phi: lerp(a.phi, b.phi, e),
    theta: a.theta + angleDelta(a.theta, b.theta) * e,
    target: a.target.clone().lerp(b.target, e)
  }
}

function applySph(camera: Camera, controls: Controls, p: Sph): void {
  controls.target.copy(p.target)
  camera.position.setFromSpherical(new Spherical(p.radius, p.phi, p.theta)).add(p.target)
  camera.lookAt(p.target)
}

/** The opening shot of a flyover: the framed view, raised and pulled back. */
function highPose(frame: Sph): Sph {
  return { radius: frame.radius * FLY_HIGH_SCALE, phi: FLY_HIGH_PHI, theta: frame.theta, target: frame.target }
}

let framedCache: Framed | null = null

/** The framing for the current window size, HUD state and capture mode. Cached until one of them changes. */
function frameFor(size: { width: number; height: number }): Framed {
  const s = useSky.getState()
  const mode: FrameMode = s.capture ?? 'ui'
  const region: Rect = visibleRegion(size, mode, {
    repo: s.repo !== null,
    dockCollapsed: useUi.getState().dockCollapsed,
    inspector: s.selectedPath !== null
  })
  const maxH = s.layout ? maxBuildingHeight(s.layout) : DEFAULT_MAX_HEIGHT
  const key = [size.width, size.height, region.left, region.top, region.right, region.bottom, maxH].join('|')
  if (framedCache && framedCache.key === key) return framedCache
  framedCache = {
    key,
    pose: toSph(framePose(size, region, maxH)),
    offset: viewOffset(size, region)
  }
  return framedCache
}

let appliedView = ''

/** Moves the projection so the orbit target sits in the centre of the free region. Cheap when unchanged. */
function applyView(camera: Camera, size: { width: number; height: number }, off: { x: number; y: number }): void {
  const key = `${size.width}|${size.height}|${off.x}|${off.y}`
  if (key === appliedView) return
  appliedView = key
  ;(camera as PerspectiveCamera).setViewOffset(size.width, size.height, off.x, off.y, size.width, size.height)
}

export function CameraRig() {
  const reduced = useSky((s) => s.reducedMotion)
  const controlsRef = useRef<Controls | null>(null)
  const intro = useRef<{ start: number | null; done: boolean }>({ start: null, done: false })
  const fly = useRef<Fly | null>(null)
  const tween = useRef<Tween | null>(null)
  const flight = useRef<Flight | null>(null)
  const pending = useRef<Pending | null>(null)
  const frameWanted = useRef(false)
  const lastInput = useRef(performance.now())
  const scratch = useRef({ tmp: new Vector3(), end: new Vector3() }).current

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
      // A repo opened (or F pressed): glide to the framing.
      if (s.frameSeq !== prev.frameSeq || (s.repo !== null && s.repo.root !== prev.repo?.root)) {
        frameWanted.current = true
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

  useFrame(({ camera, clock, size }) => {
    const controls = controlsRef.current
    if (!controls) return
    const now = performance.now()
    const t = clock.elapsedTime
    const frame = frameFor(size)
    applyView(camera, size, frame.offset)

    const finishFlight = (outcome: 'done' | 'cancelled') => {
      const f = flight.current
      flight.current = null
      clearFlyoverCancel()
      controls.enabled = true
      lastInput.current = now
      f?.req.resolve(outcome)
    }

    // Intro: the camera swings from high above and ends on the framed view.
    if (!intro.current.done) {
      if (intro.current.start === null) {
        intro.current.start = t
        controls.enabled = false
        controls.maxDistance = INTRO_MAX_DIST
        controls.minPolarAngle = 0
      }
      const u = reduced ? 1 : clamp01((t - intro.current.start) / INTRO_S)
      const from: Sph = { radius: FROM.r, phi: FROM.phi, theta: FROM.theta, target: new Vector3() }
      applySph(camera, controls, lerpSph(from, frame.pose, easeInOut(u)))
      if (u >= 1) {
        intro.current.done = true
        controls.enabled = true
        controls.maxDistance = CITY_MAX_DIST
        controls.minPolarAngle = 0.15
        lastInput.current = now
        frameWanted.current = false
      }
      setCameraSettled(false)
      return
    }

    if (frameWanted.current && !flight.current) {
      frameWanted.current = false
      fly.current = null
      tween.current = { t0: t, from: sphOf(camera, controls.target) }
    }

    const req = takeFlyoverRequest()
    if (req) {
      if (flight.current) {
        req.resolve('cancelled')
      } else {
        tween.current = null
        fly.current = null
        flight.current = {
          req,
          phase: 'approach',
          t0: t,
          dur: APPROACH_S,
          from: sphOf(camera, controls.target),
          high: highPose(frame.pose)
        }
        controls.enabled = false
      }
    }

    const fl = flight.current
    if (fl) {
      controls.autoRotate = false
      setCameraSettled(false)
      if (flyoverCancelled()) {
        finishFlight('cancelled')
        return
      }
      if (fl.phase === 'approach') {
        const u = clamp01((t - fl.t0) / fl.dur)
        applySph(camera, controls, lerpSph(fl.from, fl.high, easeInOut(u)))
        if (u >= 1) {
          fl.phase = 'orbit'
          fl.t0 = t
          fl.dur = fl.req.seconds
          fl.req.onStart()
        }
      } else {
        // One full turn while descending from the high shot into the framed three-quarter view.
        const u = clamp01((t - fl.t0) / fl.dur)
        const e = easeInOut(u)
        const h = fl.high
        const target = frame.pose.target
        applySph(camera, controls, {
          radius: lerp(h.radius, frame.pose.radius, e),
          phi: lerp(h.phi, frame.pose.phi, e),
          theta: frame.pose.theta + TWO_PI * e,
          target
        })
        fl.req.onProgress(u)
        if (u >= 1) finishFlight('done')
      }
      return
    }

    const tw = tween.current
    if (tw) {
      const u = reduced ? 1 : clamp01((t - tw.t0) / FRAME_S)
      applySph(camera, controls, lerpSph(tw.from, frame.pose, easeInOut(u)))
      if (u >= 1) tween.current = null
      controls.autoRotate = false
      setCameraSettled(tween.current === null)
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
        if (!L || !b) return null
        const c = visCenter(b, L)
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
    setCameraSettled(!fly.current)
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
