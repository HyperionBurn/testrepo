// Agent ships: one sleek low-poly ship per active agent, escorts for subagents. The whole fleet is four
// instanced draws (hull, halos, ring lights, ribbon trails) driven by one FX system. An agent hovers over the
// building it works on, perches when idle, orbits otherwise, flies up and sparks out when it finishes.
import { useEffect, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Camera, Color, DoubleSide, DynamicDrawUsage, Euler,
  Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry,
  Quaternion, ShaderMaterial, TorusGeometry, Vector3
} from 'three'
import { findBuilding } from '@shared/layout'
import type { AgentInfo, AgentStatus, CityBuilding, CityLayout } from '@shared/types'
import { visCenter, visHeight } from './geom'
import { useSky } from '../state/store'
import { useDroneSources, type DroneSource } from './data'
import { droneVec, forgetDrone, getDroneVec, setTagEl, tagEntries } from './registry'
import { registerCounter, registerFx, emitFx, type FxCtx, type FxSystem } from './fx/core'
import { getParticles, getRings } from './fx/pools'
import {
  bankTarget, formationOffset, formatCost, formatTokens, headingOf, makeRng, POPUP_MERGE_S, popupDue, popupLine,
  tokenTotal, trailOn, unitHash, wrapAngle
} from './fx/model'
import { selectTags, stackTags, type TagCandidate } from './tagPolicy'
import { shotLayers } from './capture'
import { STATUS_META } from '../hud/meta'
import './fx.css'

export const MAX_SHIPS = 24
const HIST = 22               // trail points per ship
const LEAVE_S = 2.2           // a finished agent flies up and fades over this long
const HOVER_ABOVE_ROOF = 3.2
const ORBIT_HEIGHT = 16       // above most of the district's roofs, so the hull is not buried in a building
const ORBIT_RADIUS = 11
const PERCH_HEIGHT = 9        // idle drones sit lower and dimmer, still clear of the roofs
const SPRING_K = 9
const SPRING_C = 2 * Math.sqrt(SPRING_K)
const TAG_ANCHOR_Y = 1.6
const TAG_GAP = 4             // px between tags after collision resolution
const ESCORT_SCALE = 0.9
const HULL_SCALE = 1.8
const IDLE_ALPHA = 0.42

// ---------------------------------------------------------------------------------------------
// Geometry and shaders

/** Low-poly delta-wing hull in local space, nose toward -Z, about 2.6 long and 2.2 across. Flat shaded. */
export function buildShipGeometry(): BufferGeometry {
  const outline: [number, number][] = [
    [0, -1.3], [0.55, -0.35], [1.15, 0.85], [0.3, 0.55], [0, 0.25], [-0.3, 0.55], [-1.15, 0.85], [-0.55, -0.35]
  ]
  const top: [number, number, number] = [0, 0.16, -0.1]
  const bottom: [number, number, number] = [0, -0.1, -0.1]
  const verts: number[] = []
  const norms: number[] = []
  const inside = [0, 0.02, 0]
  const tri = (a: number[], b: number[], c: number[]): void => {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const cx = (a[0]! + b[0]! + c[0]!) / 3 - inside[0]!
    const cy = (a[1]! + b[1]! + c[1]!) / 3 - inside[1]!
    const cz = (a[2]! + b[2]! + c[2]!) / 3 - inside[2]!
    if (nx * cx + ny * cy + nz * cz < 0) {
      nx = -nx; ny = -ny; nz = -nz
    }
    const l = Math.hypot(nx, ny, nz) || 1
    for (const p of [a, b, c]) {
      verts.push(p[0]!, p[1]!, p[2]!)
      norms.push(nx / l, ny / l, nz / l)
    }
  }
  const n = outline.length
  for (let i = 0; i < n; i++) {
    const a = outline[i]!
    const b = outline[(i + 1) % n]!
    tri(top, [a[0], 0, a[1]], [b[0], 0, b[1]])
    tri(bottom, [b[0], 0, b[1]], [a[0], 0, a[1]])
  }
  // A dorsal fin down the spine, double sided by the material.
  tri([0, 0.16, -0.4], [0, 0.6, 0.3], [0, 0.16, 0.3])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(norms), 3))
  return g
}

const HULL_VERT = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vC;
varying float vA;
varying vec3 vN;
varying vec3 vV;
void main() {
  mat4 M = modelViewMatrix * instanceMatrix;
  vec4 mv = M * vec4(position, 1.0);
  vN = normalize(mat3(M) * normal);
  vV = normalize(-mv.xyz);
  vC = aColor;
  vA = aAlpha;
  gl_Position = projectionMatrix * mv;
}`

const HULL_FRAG = `
varying vec3 vC;
varying float vA;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  vec3 col = vC * (0.42 + rim * 2.0) + vec3(0.05, 0.06, 0.09);
  gl_FragColor = vec4(col, vA);
}`

const GLOW_VERT = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vC;
varying float vA;
varying vec2 vUv;
void main() {
  vC = aColor;
  vA = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const HALO_FRAG = `
uniform sampler2D uMap;
varying vec3 vC;
varying float vA;
varying vec2 vUv;
void main() {
  float a = texture2D(uMap, vUv).a;
  gl_FragColor = vec4(vC * vA * a, 1.0);
}`

const LIGHT_FRAG = `
varying vec3 vC;
varying float vA;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(vC * vA, 1.0);
}`

let radialTex: CanvasTexture | null = null
/** Soft round glow for halos. Shared, created on first use. */
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

// ---------------------------------------------------------------------------------------------
// The fleet

interface Ship {
  used: boolean
  id: string
  name: string
  color: Color
  status: AgentStatus
  file: string | undefined
  parentId: string | undefined
  sub: boolean
  k: number
  n: number
  scale: number
  leaving: number            // fx time the agent finished, or -1
  fresh: boolean             // first frame: descend from the sky, flash, shockwave
  arriveLive: boolean        // the arrival gets its flash and shockwave (live mode only)
  sparked: boolean
  bLayout: CityLayout | null // cache: the building and district for `file` in this layout
  bFile: string | undefined
  building: CityBuilding | undefined
  district: { x: number; z: number; r: number } | null
  phase: number
  pos: Vector3
  vel: Vector3
  target: Vector3
  heading: number
  pitch: number
  bank: number
  alpha: number
  alphaTo: number
  flash: number
  histN: number
  histHead: number
  cost: number
  tok: number
  lastCost: number
  lastTok: number
  pendCost: number
  pendTok: number
  lastPop: number
  lastTrailPos: Vector3
}

export interface ShipLabel {
  slot: number
  id: string
  name: string
  color: string
  status: AgentStatus
  cost: string
  tok: string
  sub: boolean
}

const scratchEuler = new Euler()
const hullQuat = new Quaternion()
const ringQuat = new Quaternion()
const camQuat = new Quaternion()
const scratchM = new Matrix4()
const scratchS = new Vector3()
const scratchP = new Vector3()
const scratchOff = { x: 0, y: 0, z: 0 }
const scratchA = new Vector3()
const scratchB = new Vector3()
const scratchC = new Vector3()
const scratchColor = new Color()
const WHITE = new Color(1, 1, 1)
const SQUASH = new Matrix4().makeScale(0, 0, 0)

/** Centre and half-size of the top-level district holding a file. Null when unknown. */
function districtOf(layout: CityLayout | null, file: string | undefined): { x: number; z: number; r: number } | null {
  if (!layout || !file) return null
  const top = file.split('/')[0]
  const d = layout.districts.find((x) => x.depth === 1 && x.name === top)
  if (!d) return null
  return { x: d.x + d.w / 2, z: d.z + d.d / 2, r: Math.max(d.w, d.d) / 2 }
}

export class Fleet implements FxSystem {
  readonly root = new Group()
  private readonly hull: InstancedMesh
  private readonly rings: InstancedMesh
  private readonly halos: InstancedMesh
  private readonly ribbon: Mesh
  private readonly ships: Ship[] = []
  private readonly slotOf = new Map<string, number>()
  private readonly anchors: (Object3D | null)[] = new Array<Object3D | null>(MAX_SHIPS).fill(null)
  private readonly hullColor = new Float32Array(MAX_SHIPS * 3)
  private readonly hullAlpha = new Float32Array(MAX_SHIPS)
  private readonly ringColor = new Float32Array(MAX_SHIPS * 2 * 3)
  private readonly ringAlpha = new Float32Array(MAX_SHIPS * 2)
  private readonly haloColor = new Float32Array(MAX_SHIPS * 3 * 3)
  private readonly haloAlpha = new Float32Array(MAX_SHIPS * 3)
  private readonly histPos = new Float32Array(MAX_SHIPS * HIST * 3)
  private readonly ribbonPos = new Float32Array(MAX_SHIPS * HIST * 2 * 3)
  private readonly ribbonCol = new Float32Array(MAX_SHIPS * HIST * 2 * 3)
  private readonly hullGeo: BufferGeometry
  private readonly hullMat: ShaderMaterial
  private readonly ringGeo: TorusGeometry
  private readonly ringMat: ShaderMaterial
  private readonly haloGeo: PlaneGeometry
  private readonly haloMat: ShaderMaterial
  private readonly ribbonGeo = new BufferGeometry()
  private readonly ribbonMat: MeshBasicMaterial
  private readonly rnd = makeRng(4242)
  private labelKey = ''
  private live = false
  private lastTime = 0
  private disposed = false

  constructor() {
    for (let i = 0; i < MAX_SHIPS; i++) {
      this.ships.push({
        used: false, id: '', name: '', color: new Color(), status: 'idle', file: undefined, parentId: undefined,
        sub: false, k: 0, n: 1, scale: HULL_SCALE, leaving: -1, fresh: false, arriveLive: false, sparked: false,
        phase: 0, pos: new Vector3(), vel: new Vector3(), target: new Vector3(), heading: 0, pitch: 0, bank: 0,
        alpha: 0, alphaTo: 0, flash: 0, histN: 0, histHead: 0, cost: 0, tok: 0, lastCost: 0, lastTok: 0,
        pendCost: 0, pendTok: 0, lastPop: -10, lastTrailPos: new Vector3(), bLayout: null, bFile: undefined,
        building: undefined, district: null
      })
    }

    this.hullGeo = buildShipGeometry()
    this.hullGeo.setAttribute('aColor', new InstancedBufferAttribute(this.hullColor, 3).setUsage(DynamicDrawUsage))
    this.hullGeo.setAttribute('aAlpha', new InstancedBufferAttribute(this.hullAlpha, 1).setUsage(DynamicDrawUsage))
    this.hullMat = new ShaderMaterial({ vertexShader: HULL_VERT, fragmentShader: HULL_FRAG, transparent: true, side: DoubleSide })
    this.hull = new InstancedMesh(this.hullGeo, this.hullMat, MAX_SHIPS)
    this.hull.frustumCulled = false
    this.hull.instanceMatrix.setUsage(DynamicDrawUsage)

    this.ringGeo = new TorusGeometry(1, 0.045, 6, 56)
    this.ringGeo.setAttribute('aColor', new InstancedBufferAttribute(this.ringColor, 3).setUsage(DynamicDrawUsage))
    this.ringGeo.setAttribute('aAlpha', new InstancedBufferAttribute(this.ringAlpha, 1).setUsage(DynamicDrawUsage))
    this.ringMat = new ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: LIGHT_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending })
    this.rings = new InstancedMesh(this.ringGeo, this.ringMat, MAX_SHIPS * 2)
    this.rings.frustumCulled = false
    this.rings.instanceMatrix.setUsage(DynamicDrawUsage)

    this.haloGeo = new PlaneGeometry(1, 1)
    this.haloGeo.setAttribute('aColor', new InstancedBufferAttribute(this.haloColor, 3).setUsage(DynamicDrawUsage))
    this.haloGeo.setAttribute('aAlpha', new InstancedBufferAttribute(this.haloAlpha, 1).setUsage(DynamicDrawUsage))
    this.haloMat = new ShaderMaterial({
      uniforms: { uMap: { value: glowTexture() } },
      vertexShader: GLOW_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.halos = new InstancedMesh(this.haloGeo, this.haloMat, MAX_SHIPS * 3)
    this.halos.frustumCulled = false
    this.halos.instanceMatrix.setUsage(DynamicDrawUsage)

    this.ribbonGeo.setAttribute('position', new BufferAttribute(this.ribbonPos, 3).setUsage(DynamicDrawUsage))
    this.ribbonGeo.setAttribute('color', new BufferAttribute(this.ribbonCol, 3).setUsage(DynamicDrawUsage))
    const index: number[] = []
    for (let s = 0; s < MAX_SHIPS; s++) {
      const base = s * HIST * 2
      for (let k = 0; k < HIST - 1; k++) {
        const a = base + 2 * k
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    this.ribbonGeo.setIndex(index)
    this.ribbonMat = new MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false
    })
    this.ribbon = new Mesh(this.ribbonGeo, this.ribbonMat)
    this.ribbon.frustumCulled = false
    this.root.add(this.hull, this.rings, this.halos, this.ribbon)
    for (let i = 0; i < MAX_SHIPS; i++) {
      this.hull.setMatrixAt(i, SQUASH)
      for (let r = 0; r < 2; r++) this.rings.setMatrixAt(i * 2 + r, SQUASH)
      for (let h = 0; h < 3; h++) this.halos.setMatrixAt(i * 3 + h, SQUASH)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.hullGeo.dispose()
    this.hullMat.dispose()
    this.ringGeo.dispose()
    this.ringMat.dispose()
    this.haloGeo.dispose()
    this.haloMat.dispose()
    this.ribbonGeo.dispose()
    this.ribbonMat.dispose()
    for (const s of this.ships) if (s.used) forgetDrone(s.id)
    this.slotOf.clear()
  }

  liveCount(): number {
    let n = 0
    for (const s of this.ships) if (s.used) n++
    return n
  }

  setAnchor(slot: number, o: Object3D | null): void {
    this.anchors[slot] = o
  }

  /**
   * Reconciles ships with the live agents. Returns true when the set of name tags changed, so the React side
   * re-renders them. Departures fly off in live mode and vanish at once in replay.
   */
  sync(sources: readonly (DroneSource & { parentId?: string })[], agents: readonly AgentInfo[], live: boolean): boolean {
    this.live = live
    const byId = new Map<string, AgentInfo>()
    for (const a of agents) byId.set(a.id, a)
    const seen = new Set<string>()
    const subCount = new Map<string, number>()
    for (const s of sources) if (s.parentId) subCount.set(s.parentId, (subCount.get(s.parentId) ?? 0) + 1)
    const subIndex = new Map<string, number>()
    for (const src of sources) {
      seen.add(src.id)
      const agent = byId.get(src.id)
      const cost = agent?.costUsd ?? 0
      const tok = tokenTotal(agent?.tokens)
      let slot = this.slotOf.get(src.id)
      if (slot === undefined) {
        slot = this.freeSlot()
        if (slot < 0) continue
        this.slotOf.set(src.id, slot)
        const s = this.ships[slot]!
        s.used = true
        s.fresh = true
        s.arriveLive = live
        s.sparked = false
        s.leaving = -1
        s.phase = unitHash(src.id) * Math.PI * 2
        s.histN = 0
        s.alpha = 0
        s.flash = 0
        s.lastCost = cost
        s.lastTok = tok
        s.pendCost = 0
        s.pendTok = 0
        s.lastPop = this.lastTime - POPUP_MERGE_S
        s.bLayout = null
      }
      const s = this.ships[slot]!
      if (s.leaving >= 0) {
        s.leaving = -1
        s.sparked = false
      }
      s.id = src.id
      s.name = src.name
      s.color.set(src.color)
      s.status = src.status
      s.file = src.file
      s.parentId = src.parentId
      s.sub = !!src.parentId
      if (s.sub) {
        s.k = subIndex.get(src.parentId!) ?? 0
        subIndex.set(src.parentId!, s.k + 1)
        s.n = subCount.get(src.parentId!) ?? 1
      } else {
        s.k = 0
        s.n = 1
      }
      s.scale = s.sub ? ESCORT_SCALE : HULL_SCALE
      s.alphaTo = src.status === 'idle' ? IDLE_ALPHA : 1
      if (cost > s.lastCost) s.pendCost += cost - s.lastCost
      if (tok > s.lastTok) s.pendTok += tok - s.lastTok
      s.lastCost = cost
      s.lastTok = tok
      s.cost = cost
      s.tok = tok
    }
    for (const [id, slot] of [...this.slotOf]) {
      if (seen.has(id)) continue
      const s = this.ships[slot]!
      if (!live) this.release(id, slot)
      else if (s.leaving < 0) {
        s.leaving = this.lastTime
        s.sparked = false
      }
    }
    const key = this.labelsKey()
    if (key === this.labelKey) return false
    this.labelKey = key
    return true
  }

  private freeSlot(): number {
    for (let i = 0; i < MAX_SHIPS; i++) if (!this.ships[i]!.used) return i
    return -1
  }

  private release(id: string, slot: number): void {
    const s = this.ships[slot]!
    s.used = false
    s.histN = 0
    s.alpha = 0
    this.slotOf.delete(id)
    forgetDrone(id)
    this.hull.setMatrixAt(slot, SQUASH)
    for (let r = 0; r < 2; r++) this.rings.setMatrixAt(slot * 2 + r, SQUASH)
    for (let h = 0; h < 3; h++) this.halos.setMatrixAt(slot * 3 + h, SQUASH)
  }

  private labelsKey(): string {
    let key = ''
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i]!
      if (!s.used || s.leaving >= 0) continue
      key += `${i}|${s.id}|${s.name}|${s.status}|${formatCost(s.cost)}|${formatTokens(s.tok)};`
    }
    return key
  }

  /** Labels for the name tags, one per visible ship. Called on sync, not per frame. */
  labelList(): ShipLabel[] {
    const out: ShipLabel[] = []
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i]!
      if (!s.used || s.leaving >= 0) continue
      out.push({
        slot: i,
        id: s.id,
        name: s.name,
        color: `#${s.color.getHexString()}`,
        status: s.status,
        cost: formatCost(s.cost),
        tok: formatTokens(s.tok),
        sub: s.sub
      })
    }
    return out
  }

  update(dt: number, ctx: FxCtx): void {
    this.lastTime = ctx.time
    if (ctx.camera) camQuat.copy(ctx.camera.quaternion)
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i]!
      if (s.used) this.stepShip(i, s, dt, ctx)
    }
    this.writeRibbon(ctx.camera)
    this.hull.instanceMatrix.needsUpdate = true
    this.rings.instanceMatrix.needsUpdate = true
    this.halos.instanceMatrix.needsUpdate = true
    this.hullGeo.getAttribute('aColor').needsUpdate = true
    this.hullGeo.getAttribute('aAlpha').needsUpdate = true
    this.ringGeo.getAttribute('aColor').needsUpdate = true
    this.ringGeo.getAttribute('aAlpha').needsUpdate = true
    this.haloGeo.getAttribute('aColor').needsUpdate = true
    this.haloGeo.getAttribute('aAlpha').needsUpdate = true
    this.ribbonGeo.getAttribute('position').needsUpdate = true
    this.ribbonGeo.getAttribute('color').needsUpdate = true
  }

  private stepShip(i: number, s: Ship, dt: number, ctx: FxCtx): void {
    const t = ctx.time
    const reduced = ctx.reduced
    const L = ctx.layout
    if (s.bLayout !== L || s.bFile !== s.file) {
      s.bLayout = L
      s.bFile = s.file
      s.building = L && s.file ? findBuilding(L, s.file) : undefined
      s.district = districtOf(L, s.file)
    }

    if (s.leaving >= 0) {
      // Finished: spark once, rise and fade, then free the slot.
      if (!s.sparked && !reduced) {
        s.sparked = true
        getParticles().burst(s.pos.x, s.pos.y, s.pos.z, 26, 6, 0.6, s.color, 1.1, -3, this.rnd)
      }
      if (reduced || t - s.leaving > LEAVE_S) {
        this.release(s.id, i)
        return
      }
      s.vel.y += 14 * dt
      s.vel.x *= Math.exp(-dt * 2)
      s.vel.z *= Math.exp(-dt * 2)
      s.pos.addScaledVector(s.vel, dt)
      s.alpha = Math.max(0, s.alpha - dt * 1.2)
      s.histN = 0
      this.writeShip(i, s, t, ctx, s.alpha)
      droneVec(s.id).copy(s.pos)
      return
    }

    // Where the ship wants to be: an escort in formation, over its building, perched, or orbiting.
    const parentSlot = s.parentId ? this.slotOf.get(s.parentId) : undefined
    const parent = parentSlot !== undefined ? this.ships[parentSlot] : undefined
    if (s.sub && parent && parent.used && parent.leaving < 0) {
      formationOffset(s.k, s.n, t, s.phase, scratchOff)
      s.target.set(parent.pos.x + scratchOff.x, parent.pos.y + scratchOff.y, parent.pos.z + scratchOff.z)
    } else if (s.building && L && s.status !== 'idle') {
      const c = visCenter(s.building, L)
      s.target.set(c.x, visHeight(s.building, L) + HOVER_ABOVE_ROOF + Math.sin(t * 1.7 + s.phase) * 0.3, c.z)
    } else {
      const cx = s.district?.x ?? 0
      const cz = s.district?.z ?? 0
      if (s.status === 'idle') {
        s.target.set(cx + Math.cos(t * 0.1 + s.phase) * 3, PERCH_HEIGHT + Math.sin(t * 0.9 + s.phase) * 0.25, cz + Math.sin(t * 0.1 + s.phase) * 3)
      } else {
        const ang = t * 0.22 + s.phase
        s.target.set(cx + Math.cos(ang) * ORBIT_RADIUS, ORBIT_HEIGHT + Math.sin(t * 0.9 + s.phase) * 0.6, cz + Math.sin(ang) * ORBIT_RADIUS)
      }
    }

    if (s.fresh) {
      s.fresh = false
      s.pos.copy(s.target)
      if (!reduced && !s.sub) s.pos.y += 60
      if (s.arriveLive && !reduced && !s.sub) {
        // Warp-in: a flash and a ring shockwave on the ground under the arrival point.
        s.flash = 1
        const c = s.district
        getRings().spawn(c?.x ?? 0, c?.z ?? 0, 1, Math.max(12, (c?.r ?? 10) * 0.9), 1.4, s.color, 0.9)
      }
    }

    if (reduced) {
      s.pos.copy(s.target)
      s.vel.set(0, 0, 0)
    } else {
      const ax = (s.target.x - s.pos.x) * SPRING_K - s.vel.x * SPRING_C
      const ay = (s.target.y - s.pos.y) * SPRING_K - s.vel.y * SPRING_C
      const az = (s.target.z - s.pos.z) * SPRING_K - s.vel.z * SPRING_C
      s.vel.x += ax * dt
      s.vel.y += ay * dt
      s.vel.z += az * dt
      s.pos.x += s.vel.x * dt
      s.pos.y += s.vel.y * dt
      s.pos.z += s.vel.z * dt
    }

    // Heading follows the horizontal velocity, the hull banks into turns and pitches with climb.
    const sp = Math.hypot(s.vel.x, s.vel.z)
    if (reduced) {
      s.bank = 0
      s.pitch = 0
    } else {
      if (sp > 0.6) {
        const hOld = s.heading
        s.heading += wrapAngle(headingOf(s.vel.x, s.vel.z) - hOld) * Math.min(1, dt * 4)
        const yawRate = wrapAngle(s.heading - hOld) / Math.max(dt, 1e-3)
        s.bank += (bankTarget(yawRate) - s.bank) * Math.min(1, dt * 3)
      }
      const pitchTo = Math.max(-0.45, Math.min(0.45, s.vel.y * 0.08))
      s.pitch += (pitchTo - s.pitch) * Math.min(1, dt * 4)
    }

    // Trails only near the target (no streaks across the sky during the descent).
    const gap = s.pos.distanceTo(s.target)
    const wantTrail = !reduced && trailOn(gap, s.histN > 0)
    if (!wantTrail) s.histN = 0
    if (wantTrail) {
      if (s.histN === 0 || s.pos.distanceTo(s.lastTrailPos) > 0.12) {
        s.histHead = (s.histHead + 1) % HIST
        s.lastTrailPos.copy(s.pos)
        s.histN = Math.min(HIST, s.histN + 1)
      }
      const o = (i * HIST + s.histHead) * 3
      this.histPos[o] = s.pos.x
      this.histPos[o + 1] = s.pos.y
      this.histPos[o + 2] = s.pos.z
    }

    s.alpha += (s.alphaTo - s.alpha) * Math.min(1, dt * 3)
    s.flash = Math.max(0, s.flash - dt * 0.75)

    // Popups for new spend: one merged line per agent per POPUP_MERGE_S window ('+$0.01 · 1.5k tok'). Live mode only.
    if (this.live && !reduced && popupDue(t, s.lastPop, s.pendCost, s.pendTok)) {
      const text = popupLine(s.pendCost, s.pendTok)
      if (text) {
        emitFx({ type: 'popup', agentId: s.id, text, color: `#${s.color.getHexString()}`, x: s.pos.x, y: s.pos.y + 4.6, z: s.pos.z })
      }
      s.pendCost = 0
      s.pendTok = 0
      s.lastPop = t
    }

    droneVec(s.id).copy(s.pos)
    const anchor = this.anchors[i]
    if (anchor) anchor.position.copy(s.pos)
    this.writeShip(i, s, t, ctx, s.alpha)
  }

  private writeShip(i: number, s: Ship, t: number, ctx: FxCtx, alpha: number): void {
    const reduced = ctx.reduced

    // Hull.
    scratchEuler.set(s.pitch, s.heading, s.bank, 'YXZ')
    hullQuat.setFromEuler(scratchEuler)
    const hs = s.scale * (reduced ? 1 : 1 + 0.02 * Math.sin(t * 3 + s.phase))
    scratchS.set(hs, hs, hs)
    scratchM.compose(s.pos, hullQuat, scratchS)
    this.hull.setMatrixAt(i, scratchM)
    const dim = s.status === 'idle' ? 0.6 : 1
    this.hullColor[i * 3] = s.color.r * dim
    this.hullColor[i * 3 + 1] = s.color.g * dim
    this.hullColor[i * 3 + 2] = s.color.b * dim
    this.hullAlpha[i] = alpha

    // Two ring lights, tilted and spinning around the hull.
    const rs = s.scale * 1.9
    scratchS.set(rs, rs, rs)
    for (let r = 0; r < 2; r++) {
      const spin = reduced ? 0.4 * r : r === 0 ? t * 1.1 + s.phase : -t * 0.8 + s.phase
      scratchEuler.set(Math.PI / 2 + (r === 0 ? 0.4 : -0.5), spin, r === 0 ? 0 : 0.6, 'XYZ')
      ringQuat.setFromEuler(scratchEuler)
      scratchM.compose(s.pos, ringQuat, scratchS)
      const ri = i * 2 + r
      this.rings.setMatrixAt(ri, scratchM)
      const pulse = reduced ? 0.8 : 0.6 + 0.4 * Math.sin(t * 2.5 + s.phase + r)
      this.ringColor[ri * 3] = s.color.r * 1.3
      this.ringColor[ri * 3 + 1] = s.color.g * 1.3
      this.ringColor[ri * 3 + 2] = s.color.b * 1.3
      this.ringAlpha[ri] = alpha * pulse
    }

    // Halos (billboards): core glow, arrival flash, engine glow at the tail.
    const billboard = ctx.camera ? camQuat : hullQuat
    const core = i * 3
    const coreS = 2.6 * s.scale
    scratchS.set(coreS, coreS, coreS)
    scratchM.compose(s.pos, billboard, scratchS)
    this.halos.setMatrixAt(core, scratchM)
    this.setHalo(core, s.color, alpha * (reduced ? 0.9 : 0.8 + 0.2 * Math.sin(t * 4 + s.phase)))

    const fl = reduced ? 0 : s.flash
    const flS = 3.2 * s.scale + fl * 10
    scratchS.set(flS, flS, flS)
    scratchM.compose(s.pos, billboard, scratchS)
    this.halos.setMatrixAt(core + 1, scratchM)
    scratchColor.copy(s.color).lerp(WHITE, 0.6)
    this.setHalo(core + 1, scratchColor, fl)

    const speed = Math.min(1, Math.hypot(s.vel.x, s.vel.y, s.vel.z) / 3)
    scratchP.set(0, 0, 1.3 * s.scale).applyQuaternion(hullQuat).add(s.pos)
    const eS = 1.4 * s.scale * (reduced ? 1 : 1 + 0.2 * Math.sin(t * 9 + s.phase))
    scratchS.set(eS, eS, eS)
    scratchM.compose(scratchP, billboard, scratchS)
    this.halos.setMatrixAt(core + 2, scratchM)
    scratchColor.copy(s.color).multiplyScalar(1.5)
    this.setHalo(core + 2, scratchColor, alpha * (0.35 + 0.65 * speed))
  }

  private setHalo(idx: number, c: Color, a: number): void {
    this.haloColor[idx * 3] = c.r
    this.haloColor[idx * 3 + 1] = c.g
    this.haloColor[idx * 3 + 2] = c.b
    this.haloAlpha[idx] = a
  }

  /** Each ship's ribbon: a camera-facing strip along its recorded path, fading toward the tail. */
  private writeRibbon(cam: Camera | null): void {
    const cx = cam ? cam.position.x : 0
    const cy = cam ? cam.position.y : 0
    const cz = cam ? cam.position.z : 0
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i]!
      const n = s.used && s.leaving < 0 ? s.histN : 0
      const hb = i * HIST * 3
      for (let k = 0; k < HIST; k++) {
        const v = (i * HIST + k) * 2
        // Beyond the recorded history, collapse onto the last valid point: stale slots would stretch a streak.
        const kv = Math.min(k, Math.max(0, n - 1))
        const p = hb + ((s.histHead - kv + HIST) % HIST) * 3
        const px = this.histPos[p] ?? 0
        const py = this.histPos[p + 1] ?? 0
        const pz = this.histPos[p + 2] ?? 0
        if (n < 2 || k >= n) {
          this.setRibbonVert(v, px, py, pz, 0, 0, 0)
          this.setRibbonVert(v + 1, px, py, pz, 0, 0, 0)
          continue
        }
        // Tangent toward the next older point (the tail uses its own predecessor).
        const older = Math.min(k + 1, n - 1)
        const q = hb + ((s.histHead - older + HIST) % HIST) * 3
        const tx = px - (this.histPos[q] ?? 0)
        const ty = py - (this.histPos[q + 1] ?? 0)
        const tz = pz - (this.histPos[q + 2] ?? 0)
        scratchA.set(tx, ty, tz)
        if (scratchA.lengthSq() < 1e-8) scratchA.set(0, 1, 0)
        scratchB.set(cx - px, cy - py, cz - pz)
        scratchC.crossVectors(scratchA, scratchB)
        if (scratchC.lengthSq() < 1e-8) scratchC.set(1, 0, 0)
        scratchC.normalize()
        const u = k / HIST
        const w = 0.55 * Math.pow(1 - u, 0.8)
        const f = Math.pow(1 - u, 1.6) * 0.9
        this.setRibbonVert(v, px + scratchC.x * w, py + scratchC.y * w, pz + scratchC.z * w, s.color.r * f, s.color.g * f, s.color.b * f)
        this.setRibbonVert(v + 1, px - scratchC.x * w, py - scratchC.y * w, pz - scratchC.z * w, s.color.r * f, s.color.g * f, s.color.b * f)
      }
    }
  }

  private setRibbonVert(v: number, x: number, y: number, z: number, r: number, g: number, b: number): void {
    const o = v * 3
    this.ribbonPos[o] = x
    this.ribbonPos[o + 1] = y
    this.ribbonPos[o + 2] = z
    this.ribbonCol[o] = r
    this.ribbonCol[o + 1] = g
    this.ribbonCol[o + 2] = b
  }
}

// ---------------------------------------------------------------------------------------------
// React side: the fleet's group, one name tag per visible ship, and the screen-space tag layout.

export function Drones() {
  const agents = useSky((s) => s.agents)
  const mode = useSky((s) => s.mode)
  const drones = useDroneSources()
  // Parent links are not in the drone sources; read them from the agents (subagents fly as escorts).
  const sources = useMemo(() => {
    const parents = new Map<string, string | undefined>()
    for (const a of agents) parents.set(a.id, a.parentId)
    return drones.map((d) => ({ ...d, parentId: parents.get(d.id) }))
  }, [drones, agents])
  const fleet = useMemo(() => new Fleet(), [])
  const [labels, setLabels] = useState<ShipLabel[]>([])

  useEffect(() => registerFx(fleet), [fleet])
  useEffect(() => registerCounter('ships', () => fleet.liveCount()), [fleet])
  useEffect(() => () => fleet.dispose(), [fleet])
  useEffect(() => {
    if (fleet.sync(sources, agents, mode === 'live')) setLabels(fleet.labelList())
  }, [fleet, sources, agents, mode])

  return (
    <>
      <primitive object={fleet.root} />
      {labels.map((l) => (
        <ShipTag key={l.slot} fleet={fleet} label={l} />
      ))}
      <TagLayout />
    </>
  )
}

function ShipTag({ fleet, label }: { fleet: Fleet; label: ShipLabel }) {
  const meta = STATUS_META[label.status]
  return (
    <group ref={(g) => fleet.setAnchor(label.slot, g)}>
      <Html position={[0, TAG_ANCHOR_Y, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className={`fx-tag${label.sub ? ' fx-tag--sub' : ''}`}
          data-status={label.status}
          ref={(el) => setTagEl(label.id, el)}
        >
          <span className="fx-tag__dot" style={{ background: label.color, boxShadow: `0 0 10px ${label.color}` }} />
          <span className="fx-tag__name">{label.name}</span>
          <span className="fx-tag__status" style={{ color: meta.color }}>{meta.label}</span>
          {!label.sub && <span className="fx-tag__cost">{label.cost}</span>}
          {!label.sub && <span className="fx-tag__tok">{label.tok}</span>}
        </div>
      </Html>
    </group>
  )
}

/**
 * Places the name tags in screen space. Only active agents get a tag, and at most MAX_TAGS of them (tagPolicy):
 * the rest stay as drones. The chosen tags are stacked so none overlaps another; a tag pushed off its drone gets a
 * leader line back to it. A shot hides every tag unless it asked for them.
 */
function TagLayout() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const sizes = useMemo(() => new WeakMap<HTMLElement, { w: number; h: number }>(), [])
  const tmp = useMemo(() => new Vector3(), [])

  useFrame(() => {
    const showTags = shotLayers().tags
    const cands: TagCandidate[] = []
    const els = new Map<string, { el: HTMLElement; w: number; h: number }>()
    for (const [id, el] of tagEntries()) {
      const v = getDroneVec(id)
      if (!v) continue
      tmp.set(v.x, v.y + TAG_ANCHOR_Y, v.z).project(camera)
      if (!showTags || tmp.z > 1 || tmp.z < -1) {
        el.style.visibility = 'hidden'
        continue
      }
      let m = sizes.get(el)
      if (!m && el.offsetWidth > 0) {
        m = { w: el.offsetWidth, h: el.offsetHeight }
        sizes.set(el, m)
      }
      const w = m?.w ?? 180
      const h = m?.h ?? 26
      els.set(id, { el, w, h })
      cands.push({
        id,
        status: (el.dataset.status as TagCandidate['status']) ?? 'idle',
        sub: el.classList.contains('fx-tag--sub'),
        depth: tmp.z,
        x: (tmp.x * 0.5 + 0.5) * size.width,
        y: (-tmp.y * 0.5 + 0.5) * size.height,
        w,
        h
      })
    }
    const shown = selectTags(cands)
    const visible = cands.filter((c) => shown.has(c.id))
    const offsets = stackTags(visible, TAG_GAP)
    for (const [id, { el }] of els) {
      if (!shown.has(id)) {
        el.style.visibility = 'hidden'
        continue
      }
      el.style.visibility = ''
      const dy = offsets.get(id) ?? 0
      el.style.translate = dy === 0 ? '' : `0px ${dy}px`
      const cand = visible.find((c) => c.id === id)
      const lead = cand ? Math.max(0, Math.abs(dy) - cand.h / 2) : 0
      if (lead > 0) {
        el.dataset.lead = dy > 0 ? 'up' : 'down'
        el.style.setProperty('--lead', `${Math.round(lead)}px`)
      } else {
        delete el.dataset.lead
        el.style.removeProperty('--lead')
      }
    }
  })
  return null
}
