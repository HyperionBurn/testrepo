// All buildings as one InstancedMesh, plus the per-instance state that drives them.
// Plain TypeScript (no React): BuildingField is rebuilt when the layout changes, carrying over
// the animation state of buildings that survive, and it is stepped every frame by Buildings.tsx.
import { BoxGeometry, Color, InstancedBufferAttribute, InstancedMesh, type MeshStandardMaterial } from 'three'
import type { CityLayout } from '@shared/types'
import type { Heat, Mode } from '../state/store'
import { towerHeight } from './geom'

/** Seconds for a touch glow to fade from 1 to 0. */
export const HEAT_DECAY_S = 25
const SPRING_K = 60
const SPRING_C = 2 * Math.sqrt(SPRING_K) // critical damping
const SHIMMER_RATE = 1.6

export interface FieldGate {
  mode: Mode;
  gitTs: number | null;
  firstSeen: Record<string, number>;
}

interface Slot {
  path: string;
  x: number; z: number; w: number; d: number;
  baseH: number;          // height in the layout
  h: number; v: number;   // animated height and its velocity
  target: number;
  shim: number;           // construction shimmer, decays to 0
  seed: number;           // [0,1), stable per path
  ghost: boolean;         // file left the repo: sinking into the ground
  dead: boolean;          // finished sinking, hidden until the next layout
  lr: number; lg: number; lb: number; // language color, linear
  writtenH: number;       // height last written to the instance buffers
}

function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

export class BuildingField {
  readonly mesh: InstancedMesh;
  readonly slots: Slot[];
  private readonly geometry: BoxGeometry;
  private readonly byPath = new Map<string, number>();
  private readonly aSize: InstancedBufferAttribute;
  private readonly aLang: InstancedBufferAttribute;
  private readonly aGlow: InstancedBufferAttribute;
  private readonly aGlowColor: InstancedBufferAttribute;
  private readonly aSel: InstancedBufferAttribute;
  private readonly aShim: InstancedBufferAttribute;
  private readonly aSeed: InstancedBufferAttribute;
  private hotRef: Record<string, Heat> | null = null;
  private hot: { idx: number; heat: Heat }[] = [];
  private lit: number[] = [];
  private hoverIdx = -1;
  private selIdx = -1;
  private dirtyGeom = false;
  private dirtyAttr = false;

  constructor(layout: CityLayout, material: MeshStandardMaterial, prev: BuildingField | null, gate: FieldGate) {
    const nowPaths = new Set<string>()
    const slots: Slot[] = []

    for (const b of layout.buildings) {
      nowPaths.add(b.path)
      const old = prev?.slotFor(b.path)
      const c = new Color(b.color)
      slots.push({
        path: b.path,
        x: b.x, z: b.z, w: b.w, d: b.d,
        baseH: towerHeight(b.h),
        // Buildings that survive keep their height and shimmer; new ones rise from the ground with a shimmer.
        h: old ? old.h : 0,
        v: old ? old.v : 0,
        target: towerHeight(b.h),
        shim: old ? old.shim : 1,
        seed: hashSeed(b.path),
        ghost: false,
        dead: false,
        lr: c.r, lg: c.g, lb: c.b,
        writtenH: -1
      })
    }

    // Files that left the layout keep their footprint and sink into the ground.
    if (prev) {
      for (const old of prev.slots) {
        if (old.dead || nowPaths.has(old.path)) continue
        slots.push({ ...old, ghost: true, target: 0, shim: 0, writtenH: -1 })
      }
    }

    this.slots = slots
    const n = Math.max(1, slots.length)
    this.geometry = new BoxGeometry(1, 1, 1)
    this.geometry.translate(0, 0.5, 0) // base sits at y = 0
    this.aSize = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.aLang = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.aGlow = new InstancedBufferAttribute(new Float32Array(n), 1)
    this.aGlowColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.aSel = new InstancedBufferAttribute(new Float32Array(n), 1)
    this.aShim = new InstancedBufferAttribute(new Float32Array(n), 1)
    this.aSeed = new InstancedBufferAttribute(new Float32Array(n), 1)
    this.geometry.setAttribute('aSize', this.aSize)
    this.geometry.setAttribute('aLang', this.aLang)
    this.geometry.setAttribute('aGlow', this.aGlow)
    this.geometry.setAttribute('aGlowColor', this.aGlowColor)
    this.geometry.setAttribute('aSel', this.aSel)
    this.geometry.setAttribute('aShim', this.aShim)
    this.geometry.setAttribute('aSeed', this.aSeed)

    this.mesh = new InstancedMesh(this.geometry, material, n)
    this.mesh.count = slots.length
    this.mesh.frustumCulled = false

    slots.forEach((s, i) => {
      if (!s.ghost) this.byPath.set(s.path, i)
      this.aLang.setXYZ(i, s.lr, s.lg, s.lb)
      this.aSeed.setX(i, s.seed)
      this.aShim.setX(i, s.shim)
      this.writeGeom(i)
    })
    this.retarget(gate.mode, gate.gitTs, gate.firstSeen)
    this.commit()
  }

  /** Slot for a live (non-ghost) building path. */
  slotFor(path: string): Slot | undefined {
    const i = this.byPath.get(path)
    return i === undefined ? undefined : this.slots[i]
  }

  indexOf(path: string): number {
    return this.byPath.get(path) ?? -1
  }

  /** Path of the building behind an instance id, or null for ghosts and hidden slots. */
  pathAt(i: number): string | null {
    const s = this.slots[i]
    return s && !s.ghost && !s.dead ? s.path : null
  }

  /** Git time-lapse: buildings first seen after gitTs are held at zero height; the rest rise to their height. */
  retarget(mode: Mode, gitTs: number | null, firstSeen: Record<string, number>): void {
    for (const s of this.slots) {
      if (s.ghost) {
        s.target = 0
        continue
      }
      const seen: number | undefined = firstSeen[s.path]
      const hidden = mode === 'git' && gitTs !== null && seen !== undefined && seen > gitTs
      s.target = hidden ? 0 : s.baseH
    }
  }

  /** Advances the height springs, shimmer and ghost sinking. dt in seconds. */
  step(dt: number): void {
    const slots = this.slots
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]
      if (!s) continue
      if (!s.dead) {
        const diff = s.target - s.h
        if (Math.abs(diff) < 1e-4 && Math.abs(s.v) < 1e-4) {
          s.h = s.target
          s.v = 0
        } else {
          s.v += (diff * SPRING_K - s.v * SPRING_C) * dt
          s.h += s.v * dt
        }
        if (s.ghost && s.h < 0.03 && Math.abs(s.v) < 0.05) {
          s.dead = true
          s.h = 0
          s.v = 0
        }
        const hVal = s.dead ? 0 : s.h
        if (Math.abs(hVal - s.writtenH) > 1e-4) this.writeGeom(i)
      }
      if (s.shim > 0) {
        s.shim = s.shim * Math.exp(-dt * SHIMMER_RATE)
        if (s.shim < 0.002) s.shim = 0
        this.aShim.setX(i, s.shim)
        this.dirtyAttr = true
      }
    }
  }

  /** Glow for touched buildings: 1 at the touch, fading over HEAT_DECAY_S. Reads are dimmer. */
  applyHeat(nowMs: number, heat: Record<string, Heat>, colorOf: (agentId: string) => Color): void {
    if (heat !== this.hotRef) {
      this.hotRef = heat
      this.hot = []
      for (const path in heat) {
        const idx = this.byPath.get(path)
        const h = heat[path]
        if (idx !== undefined && h) this.hot.push({ idx, heat: h })
      }
    }
    const hadLit = this.lit.length > 0
    for (const idx of this.lit) this.aGlow.setX(idx, 0)
    this.lit = []
    for (const { idx, heat: h } of this.hot) {
      const k = 1 - (nowMs - h.ts) / 1000 / HEAT_DECAY_S
      if (k <= 0) continue
      const g = (h.kind === 'read' ? 0.35 : 1) * Math.pow(k, 1.5)
      if (g < 0.002) continue
      const c = colorOf(h.agentId)
      this.aGlow.setX(idx, g)
      this.aGlowColor.setXYZ(idx, c.r, c.g, c.b)
      this.lit.push(idx)
    }
    if (hadLit || this.lit.length > 0) this.dirtyAttr = true
  }

  /** Hover gets a white rim (0.5 in aSel), selection a bright outline (1). */
  setHighlight(hover: string | null, sel: string | null): void {
    const hi = hover !== null ? this.indexOf(hover) : -1
    const si = sel !== null ? this.indexOf(sel) : -1
    if (hi === this.hoverIdx && si === this.selIdx) return
    const prevHover = this.hoverIdx
    const prevSel = this.selIdx
    this.hoverIdx = hi
    this.selIdx = si
    for (const idx of [prevHover, prevSel, hi, si]) {
      if (idx < 0) continue
      const v = idx === this.selIdx ? 1 : idx === this.hoverIdx ? 0.5 : 0
      this.aSel.setX(idx, v)
    }
    this.dirtyAttr = true
  }

  /** Uploads whatever changed this frame. */
  commit(): void {
    if (this.dirtyGeom) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.aSize.needsUpdate = true
    }
    if (this.dirtyAttr) {
      this.aShim.needsUpdate = true
      this.aGlow.needsUpdate = true
      this.aGlowColor.needsUpdate = true
      this.aSel.needsUpdate = true
    }
    this.dirtyGeom = false
    this.dirtyAttr = false
  }

  dispose(): void {
    this.geometry.dispose()
    this.mesh.dispose()
  }

  /** Writes the instance matrix (column-major: scale on the diagonal, translation in column 3) and the size attribute. */
  private writeGeom(i: number): void {
    const s = this.slots[i]
    if (!s) return
    const h = s.dead ? 0 : Math.max(0, s.h)
    const m = this.mesh.instanceMatrix.array as Float32Array
    const o = i * 16
    m[o] = h > 0 ? s.w : 0
    m[o + 5] = h
    m[o + 10] = h > 0 ? s.d : 0
    m[o + 12] = s.x + s.w / 2
    m[o + 14] = s.z + s.d / 2
    this.aSize.setXYZ(i, s.w, h, s.d)
    s.writtenH = h
    this.dirtyGeom = true
  }
}
