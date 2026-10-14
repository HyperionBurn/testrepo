// Construction sites around buildings an agent is editing: cones, barrier segments, fence panels and a blinking
// amber light on the footprint, a lattice tower crane with a slowly turning jib and a glowing cargo block, and
// weld sparks at the work point. Sites stand LINGER_S after the last edit, then the props sink away.
// Instanced throughout: seven draw calls for up to MAX_SITES sites.
import { useEffect, useState } from 'react'
import {
  BoxGeometry, BufferGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshLambertMaterial,
  Quaternion, Vector3, type Material
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { findBuilding } from '@shared/layout'
import type { CityBuilding, CityLayout } from '@shared/types'
import { visHeight } from './geom'
import { loadModels, type LoadedModel } from './assets'
import { onFx, registerCounter, registerFx, fxCtx, type FxEvent, type FxSystem } from './fx/core'
import { getParticles } from './fx/pools'
import {
  canAdmitSite, FENCE_MAX, makeRng, MAX_SITES, newSite, perimeterAt, perimeterLength, SITE_CONES_MAX, SITE_CONES_MIN,
  sinkOf, stepSite, touchSite, unitHash, type SiteState
} from './fx/model'

const PROP_S = 3.5             // scale of the Kenney construction props (native sizes are ~0.1 units)
const CONES = SITE_CONES_MAX
const BARRIERS = 2
const FENCES = FENCE_MAX
const CRANE_UNIT = 12          // the crane is modelled 12 units tall and scaled to the building
const JIB_Y = 11.6
const SINK_DEPTH = 1.5
const BUILD_IN_S = 1.6         // props and crane rise over this long after a site starts
const WAIT_S = 8               // a touch on a file the layout does not know yet waits this long for it
const AMBER = new Color('#ffb020')

interface Site {
  used: boolean
  file: string
  color: Color
  state: SiteState
  created: number
  building: CityBuilding | undefined
  seed: number
  coneN: number
  fenceN: number
  craneX: number
  craneZ: number
  craneYaw0: number
  craneH: number
  lightX: number
  lightZ: number
  workX: number
  workZ: number
  nextSpark: number
  cleared: boolean
}

interface Waiting { file: string; color: Color; kind: 'edit' | 'create'; until: number; used: boolean }

const ID_LIST = ['construction-cone', 'construction-barrier', 'construction-fence', 'construction-light']

/** Lattice mast and jib, in crane units (12 tall, origin at the mast foot). Merged; one geometry per part. */
export function buildCraneGeometries(): { mast: BufferGeometry; jib: BufferGeometry; cargo: BufferGeometry } {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry => {
    const g = new BoxGeometry(w, h, d).toNonIndexed()
    g.translate(x, y, z)
    return g
  }
  const mastParts: BufferGeometry[] = []
  const LEG = 0.36
  const LEG_W = 0.1
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) mastParts.push(box(LEG_W, CRANE_UNIT, LEG_W, sx * LEG, CRANE_UNIT / 2, sz * LEG))
  }
  for (let y = 0.5; y < CRANE_UNIT - 0.4; y += 1) {
    mastParts.push(box(LEG * 2 + LEG_W, 0.07, 0.07, 0, y, LEG))
    mastParts.push(box(LEG * 2 + LEG_W, 0.07, 0.07, 0, y, -LEG))
    mastParts.push(box(0.07, 0.07, LEG * 2 + LEG_W, LEG, y, 0))
    mastParts.push(box(0.07, 0.07, LEG * 2 + LEG_W, -LEG, y, 0))
  }
  mastParts.push(box(0.7, 0.7, 0.7, 0, CRANE_UNIT - 0.35, 0)) // cab
  const mast = mergeGeometries(mastParts) ?? new BufferGeometry()

  const jibParts: BufferGeometry[] = [
    box(10.5, 0.14, 0.14, 2.75, JIB_Y, 0),      // main arm, +X
    box(1.6, 0.14, 0.14, -3.2, JIB_Y, 0),       // counter arm
    box(0.9, 0.5, 0.8, -3.9, JIB_Y - 0.3, 0),   // counterweight
    box(0.05, 4.4, 0.05, 5, JIB_Y - 2.2, 0)     // hook rope
  ]
  for (let x = -2; x <= 8; x += 2.5) jibParts.push(box(0.09, 0.09, 0.9, x, JIB_Y - 0.1, 0)) // ties
  const jib = mergeGeometries(jibParts) ?? new BufferGeometry()
  const cargo = box(0.7, 0.7, 0.7, 0, 0, 0)
  return { mast, jib, cargo }
}

const SQUASH = new Matrix4().makeScale(0, 0, 0)
const scratchM = new Matrix4()
const scratchQ = new Quaternion()
const scratchV = new Vector3()
const scratchS = new Vector3()
const scratchC = new Color()
const up = new Vector3(0, 1, 0)
const perim = { x: 0, z: 0, yaw: 0 }
const scratchHot = new Color()

export class ConstructionSystem implements FxSystem {
  readonly root = new Group()
  private readonly sites: Site[] = []
  private readonly waiting: Waiting[] = []
  private readonly cones: InstancedMesh
  private readonly barriers: InstancedMesh
  private readonly fences: InstancedMesh
  private readonly lights: InstancedMesh
  private readonly mast: InstancedMesh
  private readonly jib: InstancedMesh
  private readonly cargo: InstancedMesh
  private readonly mats: Material[] = []
  private readonly geos: BufferGeometry[] = []   // crane geometry only: loaded models belong to the loader cache
  private readonly rnd = makeRng(777)
  private started = false
  private unsub: (() => void) | null = null
  private unreg: (() => void) | null = null
  private unstat: (() => void) | null = null

  constructor(models: { cone: LoadedModel; barrier: LoadedModel; fence: LoadedModel; light: LoadedModel }) {
    for (let i = 0; i < MAX_SITES; i++) {
      this.sites.push({
        used: false, file: '', color: new Color(), state: { stage: 'gone', lastEdit: 0, dismantleAt: 0 }, created: 0,
        building: undefined, seed: 0, coneN: 0, fenceN: 0, craneX: 0, craneZ: 0, craneYaw0: 0, craneH: 0,
        lightX: 0, lightZ: 0, workX: 0, workZ: 0, nextSpark: 0, cleared: true
      })
    }
    const lit = (map: LoadedModel['map']): MeshLambertMaterial => {
      const m = new MeshLambertMaterial({ map })
      this.mats.push(m)
      return m
    }
    const mkBasic = (opts: ConstructorParameters<typeof MeshBasicMaterial>[0]): MeshBasicMaterial => {
      const m = new MeshBasicMaterial(opts)
      this.mats.push(m)
      return m
    }
    const crane = buildCraneGeometries()
    this.geos.push(crane.mast, crane.jib, crane.cargo)
    const mkMesh = (geo: BufferGeometry, mat: Material, n: number): InstancedMesh => {
      const m = new InstancedMesh(geo, mat, n)
      m.frustumCulled = false
      for (let i = 0; i < n; i++) m.setMatrixAt(i, SQUASH)
      this.root.add(m)
      return m
    }
    this.cones = mkMesh(models.cone.geometry, lit(models.cone.map), MAX_SITES * CONES)
    this.barriers = mkMesh(models.barrier.geometry, lit(models.barrier.map), MAX_SITES * BARRIERS)
    this.fences = mkMesh(models.fence.geometry, lit(models.fence.map), MAX_SITES * FENCES)
    this.lights = mkMesh(models.light.geometry, mkBasic({ map: models.light.map, toneMapped: false }), MAX_SITES)
    this.mast = mkMesh(crane.mast, mkBasic({ color: new Color('#8d98b3'), toneMapped: false }), MAX_SITES)
    this.jib = mkMesh(crane.jib, mkBasic({ color: new Color('#9aa6c4'), toneMapped: false }), MAX_SITES)
    this.cargo = mkMesh(crane.cargo, mkBasic({ color: new Color('#ffffff'), toneMapped: false }), MAX_SITES)
    for (let i = 0; i < MAX_SITES; i++) {
      this.lights.setColorAt(i, AMBER)
      this.cargo.setColorAt(i, AMBER)
    }
  }

  /** Starts listening for edits and registers for stepping. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsub = onFx((e) => this.onEvent(e))
    this.unreg = registerFx(this)
    this.unstat = registerCounter('sites', () => this.liveCount())
  }

  dispose(): void {
    this.unsub?.()
    this.unreg?.()
    this.unstat?.()
    this.started = false
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const m of [this.cones, this.barriers, this.fences, this.lights, this.mast, this.jib, this.cargo]) m.dispose()
  }

  liveCount(): number {
    let n = 0
    for (const s of this.sites) if (s.used) n++
    return n
  }

  private onEvent(e: FxEvent): void {
    if (e.type !== 'touch' || !e.agent) return
    const now = fxCtx.time
    const existing = this.sites.find((s) => s.used && s.file === e.file)
    if (existing) {
      existing.state = touchSite(existing.state, now)
      existing.color.set(e.color)
      return
    }
    if (!canAdmitSite(this.liveCount())) return // over the cap: the building keeps its cage, no site
    const L = fxCtx.layout
    const b = L ? findBuilding(L, e.file) : undefined
    if (!b) {
      // The layout may not know a new file yet: wait briefly for the next repo scan.
      const w = this.waiting.find((x) => x.used && x.file === e.file) ?? this.waiting.find((x) => !x.used)
      if (w) {
        w.used = true
        w.file = e.file
        w.color.set(e.color)
        w.kind = e.kind
        w.until = now + WAIT_S
      }
      return
    }
    if (L) this.admit(b, e.file, e.color, now, L)
  }

  private admit(b: CityBuilding, file: string, color: string, now: number, layout: CityLayout): void {
    const idx = this.sites.findIndex((s) => !s.used)
    const s = this.sites[idx]
    if (!s) return
    s.used = true
    s.file = file
    s.color.set(color)
    s.state = newSite(now)
    s.created = now
    s.building = b
    s.seed = unitHash(file, 3)
    s.cleared = false
    s.coneN = SITE_CONES_MIN + Math.floor(s.seed * (CONES - SITE_CONES_MIN + 1))
    s.nextSpark = now
    const P = perimeterLength(b.w, b.d, 0.7)
    // Fence panels: about one per 1.3 units of perimeter, capped.
    const fenceP = perimeterLength(b.w, b.d, 1.45)
    s.fenceN = Math.max(4, Math.min(FENCES, Math.round(fenceP / (0.375 * PROP_S * 1.05))))
    // Crane: at a perimeter spot outside the footprint, its height just above the building.
    perimeterAt(b.w, b.d, 2.2, perimeterLength(b.w, b.d, 2.2) * s.seed, perim)
    s.craneX = b.x + perim.x
    s.craneZ = b.z + perim.z
    s.craneYaw0 = s.seed * Math.PI * 2
    s.craneH = Math.min(46, Math.max(8, visHeight(b, layout) + 2.5))
    perimeterAt(b.w, b.d, 0.7, P * (0.15 + 0.5 * s.seed), perim)
    s.lightX = b.x + perim.x
    s.lightZ = b.z + perim.z
    // Work point on the front face; swept along the face by time in update.
    s.workX = b.x
    s.workZ = b.z + b.d + 0.05
  }

  update(_dt: number, ctx: { time: number; reduced: boolean; layout: CityLayout | null }): void {
    const now = ctx.time
    const reduced = ctx.reduced
    // Deferred sites: their building has appeared in the layout.
    for (const w of this.waiting) {
      if (!w.used) continue
      if (now > w.until) {
        w.used = false
        continue
      }
      const b = ctx.layout ? findBuilding(ctx.layout, w.file) : undefined
      if (b) {
        w.used = false
        if (canAdmitSite(this.liveCount()) && ctx.layout) this.admit(b, w.file, '#' + w.color.getHexString(), now, ctx.layout)
      }
    }

    for (let i = 0; i < MAX_SITES; i++) {
      const s = this.sites[i]!
      if (!s.used) continue
      let st = stepSite(s.state, now)
      if (reduced && st.stage === 'dismantle') st = { ...st, stage: 'gone' }
      s.state = st
      if (st.stage === 'gone' || !s.building || !ctx.layout) {
        this.clear(i)
        continue
      }
      this.placeSite(i, s, now, reduced, ctx.layout)
    }
    this.commit()
  }

  private clear(i: number): void {
    const s = this.sites[i]!
    s.used = false
    if (s.cleared) return
    s.cleared = true
    for (let k = 0; k < CONES; k++) this.cones.setMatrixAt(i * CONES + k, SQUASH)
    for (let k = 0; k < BARRIERS; k++) this.barriers.setMatrixAt(i * BARRIERS + k, SQUASH)
    for (let k = 0; k < FENCES; k++) this.fences.setMatrixAt(i * FENCES + k, SQUASH)
    this.lights.setMatrixAt(i, SQUASH)
    this.mast.setMatrixAt(i, SQUASH)
    this.jib.setMatrixAt(i, SQUASH)
    this.cargo.setMatrixAt(i, SQUASH)
  }

  private placeSite(i: number, s: Site, now: number, reduced: boolean, layout: CityLayout): void {
    const b = s.building!
    const sink = reduced ? 0 : sinkOf(s.state, now)
    const grow = reduced ? 1 : Math.min(1, (now - s.created) / BUILD_IN_S)
    const ease = grow * grow * (3 - 2 * grow)
    const dropY = -sink * SINK_DEPTH
    const P = perimeterLength(b.w, b.d, 0.7)
    const rise = (1 - ease) * -0.6
    // Cones around the footprint.
    for (let k = 0; k < CONES; k++) {
      const idx = i * CONES + k
      if (k >= s.coneN) {
        this.cones.setMatrixAt(idx, SQUASH)
        continue
      }
      perimeterAt(b.w, b.d, 0.7, (P * k) / s.coneN + s.seed * 0.3, perim)
      this.propMatrix(this.cones, idx, b.x + perim.x, dropY + rise, b.z + perim.z, perim.yaw, PROP_S * ease)
    }
    // Two barrier segments along one edge, and fence panels on the outer line.
    for (let k = 0; k < BARRIERS; k++) {
      perimeterAt(b.w, b.d, 1.1, P * (0.1 + 0.2 * s.seed) + k * 1.1, perim)
      this.propMatrix(this.barriers, i * BARRIERS + k, b.x + perim.x, dropY + rise, b.z + perim.z, perim.yaw, PROP_S * ease)
    }
    const FP = perimeterLength(b.w, b.d, 1.45)
    for (let k = 0; k < FENCES; k++) {
      const idx = i * FENCES + k
      if (k >= s.fenceN) {
        this.fences.setMatrixAt(idx, SQUASH)
        continue
      }
      perimeterAt(b.w, b.d, 1.45, (FP * k) / s.fenceN, perim)
      this.propMatrix(this.fences, idx, b.x + perim.x, dropY + rise, b.z + perim.z, perim.yaw, PROP_S * ease)
    }
    // Construction light: blinks amber (on for half of each second, out of phase per site).
    const blinkOn = reduced ? true : (now * 1.2 + s.seed) % 1 < 0.5
    scratchC.copy(AMBER).multiplyScalar(blinkOn ? 2.6 : 0.2)
    this.lights.setColorAt(i, scratchC)
    this.propMatrix(this.lights, i, s.lightX, dropY, s.lightZ, 0, PROP_S * ease)

    // Crane: mast rises, jib turns, cargo hangs from the jib tip.
    const cs = (s.craneH / CRANE_UNIT) * ease
    const yaw = reduced ? s.craneYaw0 : s.craneYaw0 + now * 0.22
    const baseY = -sink * s.craneH
    scratchV.set(s.craneX, baseY, s.craneZ)
    scratchS.set(cs, cs, cs)
    scratchQ.identity()
    scratchM.compose(scratchV, scratchQ, scratchS)
    this.mast.setMatrixAt(i, scratchM)
    scratchQ.setFromAxisAngle(up, yaw)
    this.jib.setMatrixAt(i, scratchM.compose(scratchV, scratchQ, scratchS))
    // Cargo: jib-local (5, 7.2, 0) rotated by the jib yaw.
    const cx = Math.cos(yaw) * 5 * cs
    const cz = -Math.sin(yaw) * 5 * cs
    scratchV.set(s.craneX + cx, baseY + 7.2 * cs, s.craneZ + cz)
    scratchS.set(cs, cs, cs)
    this.cargo.setMatrixAt(i, scratchM.compose(scratchV, scratchQ.identity(), scratchS))
    this.cargo.setColorAt(i, scratchC.copy(AMBER).multiplyScalar(1.8 + (reduced ? 0 : 0.4 * Math.sin(now * 2.2 + s.seed * 9))))

    // Weld sparks at the work point while the site is active.
    if (!reduced && s.state.stage === 'active' && now >= s.nextSpark) {
      s.nextSpark = now + 0.09
      const sweep = (now * 0.13 + s.seed) % 1
      const wx = b.x + b.w * (0.15 + 0.7 * sweep)
      const wy = Math.max(0.6, visHeight(b, layout) * (0.35 + 0.25 * Math.sin(now * 1.1 + s.seed * 6)))
      const hot = scratchHot.set('#ffd9a0').multiplyScalar(2.4)
      getParticles().emit(wx, wy, s.workZ, (this.rnd() - 0.5) * 2.2, 0.6 + this.rnd() * 1.6, (this.rnd() - 0.5) * 1.2, hot, 0.22, 0.35 + this.rnd() * 0.3, -9)
    }
  }

  private propMatrix(mesh: InstancedMesh, idx: number, x: number, y: number, z: number, yaw: number, s: number): void {
    scratchQ.setFromAxisAngle(up, yaw)
    scratchV.set(x, y, z)
    scratchS.set(s, s, s)
    mesh.setMatrixAt(idx, scratchM.compose(scratchV, scratchQ, scratchS))
  }

  private commit(): void {
    this.cones.instanceMatrix.needsUpdate = true
    this.barriers.instanceMatrix.needsUpdate = true
    this.fences.instanceMatrix.needsUpdate = true
    this.lights.instanceMatrix.needsUpdate = true
    this.mast.instanceMatrix.needsUpdate = true
    this.jib.instanceMatrix.needsUpdate = true
    this.cargo.instanceMatrix.needsUpdate = true
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true
    if (this.cargo.instanceColor) this.cargo.instanceColor.needsUpdate = true
  }
}

/** Mounts the construction system once its models are loaded. */
export function FxConstruction() {
  const [sys, setSys] = useState<ConstructionSystem | null>(null)
  useEffect(() => {
    let alive = true
    let made: ConstructionSystem | null = null
    loadModels(ID_LIST)
      .then(([cone, barrier, fence, light]) => {
        if (!alive || !cone || !barrier || !fence || !light) return
        made = new ConstructionSystem({ cone, barrier, fence, light })
        made.start()
        setSys(made)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      made?.dispose()
    }
  }, [])
  if (!sys) return null
  return <primitive object={sys.root} />
}
