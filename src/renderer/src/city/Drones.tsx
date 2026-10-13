// Agent drones: one per active agent (not 'fs', not 'done'). A critically damped spring moves each drone
// toward a point above the building it is working on; idle drones orbit their last district.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, Trail } from '@react-three/drei'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CanvasTexture, CylinderGeometry, Group,
  Mesh, MeshBasicMaterial, Points, PointsMaterial, Quaternion, Sprite, SpriteMaterial, Vector3
} from 'three'
import type { CityLayout } from '@shared/types'
import { findBuilding } from '@shared/layout'
import { visCenter, visHeight } from './geom'
import { useSky } from '../state/store'
import { useDroneSources, type DroneSource } from './data'
import { droneVec, forgetDrone, getDroneVec, setTagEl, tagEntries } from './registry'
import './city.css'

const HOVER_ABOVE_ROOF = 3.2
const ORBIT_HEIGHT = 7   // idle drones hover lower than working ones
const ORBIT_RADIUS = 11
const SPRING_K = 9
const SPRING_C = 2 * Math.sqrt(SPRING_K)
const PARTICLES = 28
const TAG_ANCHOR_Y = 1.3   // the name tag sits this far above the drone
const TAG_GAP = 4          // px between tags after collision resolution
const UP = new Vector3(0, 1, 0)

let radialTex: CanvasTexture | null = null
/** Soft round glow for halos and particles. Shared, created on first use. */
function glowTexture(): CanvasTexture {
  if (radialTex) return radialTex
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.2, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
  }
  radialTex = new CanvasTexture(c)
  return radialTex
}

function phaseOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h % 1000) / 1000 * Math.PI * 2
}

/** Center of the top-level district holding a file, or the origin. */
function districtCenter(layout: CityLayout | null, file: string | undefined): { x: number; z: number } {
  if (!layout || !file) return { x: 0, z: 0 }
  const top = file.split('/')[0]
  const d = layout.districts.find((x) => x.depth === 1 && x.name === top)
  return d ? { x: d.x + d.w / 2, z: d.z + d.d / 2 } : { x: 0, z: 0 }
}

export function Drones() {
  const sources = useDroneSources()
  return (
    <>
      {sources.map((s) => (
        <Drone key={s.id} src={s} />
      ))}
      <TagLayout />
    </>
  )
}

interface Box { l: number; r: number; t: number; b: number }

/**
 * Places the name tags in screen space: each tag is projected from its drone, and tags that would
 * overlap an already placed one are pushed down. Runs once per frame over the registered tags.
 */
function TagLayout() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const sizes = useMemo(() => new WeakMap<HTMLElement, { w: number; h: number }>(), [])
  const tmp = useMemo(() => new Vector3(), [])

  useFrame(() => {
    const items: { el: HTMLElement; x: number; y: number; w: number; h: number }[] = []
    for (const [id, el] of tagEntries()) {
      const v = getDroneVec(id)
      if (!v) continue
      tmp.set(v.x, v.y + TAG_ANCHOR_Y, v.z).project(camera)
      if (tmp.z > 1 || tmp.z < -1) {
        el.style.visibility = 'hidden'
        continue
      }
      el.style.visibility = ''
      let m = sizes.get(el)
      if (!m && el.offsetWidth > 0) {
        m = { w: el.offsetWidth, h: el.offsetHeight }
        sizes.set(el, m)
      }
      items.push({
        el,
        x: (tmp.x * 0.5 + 0.5) * size.width,
        y: (-tmp.y * 0.5 + 0.5) * size.height,
        w: m?.w ?? 160,
        h: m?.h ?? 24
      })
    }
    items.sort((a, b) => a.y - b.y)
    const placed: Box[] = []
    for (const it of items) {
      let y = it.y
      for (let tries = 0; tries < 8; tries++) {
        const box: Box = { l: it.x - it.w / 2, r: it.x + it.w / 2, t: y - it.h / 2, b: y + it.h / 2 }
        const hit = placed.find((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)
        if (!hit) {
          placed.push(box)
          break
        }
        y = hit.b + TAG_GAP + it.h / 2
      }
      const dy = Math.round(y - it.y)
      it.el.style.translate = dy === 0 ? '' : `0px ${dy}px`
    }
  })
  return null
}

function Drone({ src }: { src: DroneSource }) {
  const reduced = useSky((s) => s.reducedMotion)
  const layout = useSky((s) => s.layout)
  const srcRef = useRef(src)
  srcRef.current = src
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const pos = useMemo(() => droneVec(src.id), [src.id])
  const vel = useMemo(() => new Vector3(), [])
  const target = useMemo(() => new Vector3(), [])
  const phase = useMemo(() => phaseOf(src.id), [src.id])
  const color = useMemo(() => new Color(src.color), [src.color])
  // Idle drones are dimmer: less core intensity, a fainter halo.
  const idleDim = src.status === 'idle'
  const coreColor = useMemo(() => new Color(src.color).multiplyScalar(idleDim ? 1.1 : 2.6), [src.color, idleDim])
  const beamColor = useMemo(() => (src.status === 'reading' ? new Color('#cfe8ff') : new Color(src.color)), [src.color, src.status])
  const tex = useMemo(() => glowTexture(), [])

  const groupRef = useRef<Group>(null)
  // The trail is drawn only while the drone is near its target: no streaks from the sky descent or across the city.
  const [trailOn, setTrailOn] = useState(false)
  const trailRef = useRef(false)
  const tagRef = useCallback((el: HTMLDivElement | null) => setTagEl(src.id, el), [src.id])
  const haloRef = useRef<Sprite>(null)
  const beamRef = useRef<Group>(null)
  const beamMeshRef = useRef<Mesh>(null)
  const pointsRef = useRef<Points>(null)
  const state = useMemo(() => ({
    init: false,
    flash: reduced ? 0 : 1,
    center: { x: 0, z: 0 },
    centerFile: '\u0000' as string | undefined, // sentinel: no district computed yet
    ages: new Float32Array(PARTICLES),
    lives: new Float32Array(PARTICLES),
    speeds: new Float32Array(PARTICLES)
  }), [reduced])

  const beamGeo = useMemo(() => {
    const g = new CylinderGeometry(0.22, 0.04, 1, 12, 1, true)
    g.translate(0, 0.5, 0)
    return g
  }, [])
  const beamMat = useMemo(() => new MeshBasicMaterial({
    color: beamColor, transparent: true, opacity: 0.4, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false
  }), [beamColor])
  const particleGeo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(PARTICLES * 3), 3))
    return g
  }, [])
  const particleMat = useMemo(() => new PointsMaterial({
    color: coreColor, size: 0.9, map: tex, transparent: true, opacity: 0.8, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false, sizeAttenuation: true
  }), [coreColor, tex])
  const haloMat = useMemo(() => new SpriteMaterial({
    map: tex, color, transparent: true, opacity: idleDim ? 0.32 : 0.7, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  }), [color, tex])
  const flashMat = useMemo(() => new SpriteMaterial({
    map: tex, color: coreColor, transparent: true, opacity: 0, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false
  }), [coreColor, tex])

  // Unregister only when the agent goes away, not when a material changes with its status.
  useEffect(() => () => forgetDrone(src.id), [src.id])
  useEffect(() => () => {
    beamGeo.dispose()
    beamMat.dispose()
    particleGeo.dispose()
    particleMat.dispose()
    haloMat.dispose()
    flashMat.dispose()
  }, [beamGeo, beamMat, particleGeo, particleMat, haloMat, flashMat])

  useFrame((frame, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const t = frame.clock.elapsedTime
    const s = srcRef.current
    const L = layoutRef.current
    const b = s.file && L ? findBuilding(L, s.file) : undefined
    const active = !!b && s.status !== 'idle'

    // Where the drone wants to be.
    if (active && b && L) {
      const c = visCenter(b, L)
      target.set(c.x, visHeight(b, L) + HOVER_ABOVE_ROOF + Math.sin(t * 1.7 + phase) * 0.3, c.z)
    } else {
      if (state.centerFile !== s.file) {
        state.center = districtCenter(L, s.file)
        state.centerFile = s.file
      }
      const ang = t * 0.22 + phase
      target.set(
        state.center.x + Math.cos(ang) * ORBIT_RADIUS,
        ORBIT_HEIGHT + Math.sin(t * 0.9 + phase) * 0.6,
        state.center.z + Math.sin(ang) * ORBIT_RADIUS
      )
    }

    if (!state.init) {
      state.init = true
      // New drones descend from the sky.
      if (reduced) pos.copy(target)
      else pos.set(target.x, target.y + 60, target.z)
    }
    if (reduced) {
      pos.copy(target)
      vel.set(0, 0, 0)
    } else {
      const ax = (target.x - pos.x) * SPRING_K - vel.x * SPRING_C
      const ay = (target.y - pos.y) * SPRING_K - vel.y * SPRING_C
      const az = (target.z - pos.z) * SPRING_K - vel.z * SPRING_C
      vel.x += ax * dt
      vel.y += ay * dt
      vel.z += az * dt
      pos.x += vel.x * dt
      pos.y += vel.y * dt
      pos.z += vel.z * dt
    }

    const gap = pos.distanceTo(target)
    const wantTrail = !reduced && state.init && (trailRef.current ? gap < 25 : gap < 8)
    if (wantTrail !== trailRef.current) {
      trailRef.current = wantTrail
      setTrailOn(wantTrail)
    }

    const g = groupRef.current
    if (g) g.position.copy(pos)

    // Arrival flash.
    state.flash = Math.max(0, state.flash - dt * 0.75)
    const flash = state.flash
    const halo = haloRef.current
    if (halo) {
      const k = 4.2 + flash * 9 + Math.sin(t * 2.3 + phase) * 0.25
      halo.scale.setScalar(k)
    }
    flashMat.opacity = flash * 0.9

    // Light beam and particles while the drone works on a building.
    // Beams and particles only once the drone has arrived: in flight, a beam would stretch across the city.
    const working = !!b && (s.status === 'editing' || s.status === 'reading') && gap < 6
    const beam = beamRef.current
    if (beam) {
      beam.visible = working
      if (working && b && L) {
        const c = visCenter(b, L)
        beam.position.set(c.x, visHeight(b, L), c.z)
        const dir = new Vector3().subVectors(pos, beam.position)
        const len = Math.max(0.01, dir.length())
        dir.normalize()
        beam.quaternion.copy(new Quaternion().setFromUnitVectors(UP, dir))
        const mesh = beamMeshRef.current
        if (mesh) mesh.scale.set(1, len, 1)
        beamMat.opacity = (s.status === 'reading' ? 0.22 : 0.4) + 0.12 * Math.sin(t * 4.5 + phase)
      }
    }

    const pts = pointsRef.current
    if (pts) {
      pts.visible = working && s.status === 'editing' && !!b
      if (pts.visible && b && L) {
        const arr = particleGeo.getAttribute('position') as BufferAttribute
        const c = visCenter(b, L)
        for (let i = 0; i < PARTICLES; i++) {
          state.ages[i] = (state.ages[i] ?? 0) + dt
          if ((state.ages[i] ?? 0) > (state.lives[i] ?? 0) || state.lives[i] === 0) {
            state.ages[i] = 0
            state.lives[i] = 1.2 + Math.random() * 1.4
            state.speeds[i] = 1.6 + Math.random() * 1.6
            arr.setXYZ(
              i,
              c.x + (Math.random() - 0.5) * b.w * 0.8,
              visHeight(b, L),
              c.z + (Math.random() - 0.5) * b.d * 0.8
            )
          } else {
            arr.setY(i, arr.getY(i) + (state.speeds[i] ?? 2) * dt)
          }
        }
        arr.needsUpdate = true
        particleMat.opacity = 0.55 + 0.25 * Math.sin(t * 6 + phase)
      }
    }
  })

  return (
    <>
      <group ref={groupRef}>
        {reduced || !trailOn ? (
          <mesh>
            <sphereGeometry args={[0.42, 20, 14]} />
            <meshBasicMaterial color={coreColor} toneMapped={false} />
          </mesh>
        ) : (
          <Trail width={0.7} length={7} color={src.color} attenuation={(w: number) => w * w}>
            <mesh>
              <sphereGeometry args={[0.42, 20, 14]} />
              <meshBasicMaterial color={coreColor} toneMapped={false} />
            </mesh>
          </Trail>
        )}
        <sprite ref={haloRef} material={haloMat} />
        <sprite material={flashMat} scale={[10, 10, 1]} />
        <Html position={[0, TAG_ANCHOR_Y, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <div className="drone-tag" data-status={src.status} ref={tagRef}>
            <span className="drone-tag__dot" style={{ background: src.color, boxShadow: `0 0 10px ${src.color}` }} />
            <span className="drone-tag__name">{src.name}</span>
            <span className="drone-tag__status">{src.status}</span>
          </div>
        </Html>
      </group>
      <group ref={beamRef} visible={false}>
        <mesh ref={beamMeshRef} geometry={beamGeo} material={beamMat} />
      </group>
      <points ref={pointsRef} geometry={particleGeo} material={particleMat} visible={false} />
    </>
  )
}
