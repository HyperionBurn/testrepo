// The building field: every file as a real Kenney model, one InstancedMesh per model id, plus the per-instance
// state that drives it. Plain TypeScript (no React). Buildings.tsx rebuilds the field when the layout changes,
// carries the animation state of surviving buildings over, and steps it every frame.
//
// Layers: the procedural boxes are shown until the models are ready, then the models crossfade in by instance scale
// (adoptModels). Per-slot state (colors, glow, selection, shimmer, height) lives in slot-indexed arrays and is written
// to every layer's instance attributes, so a layer can be added at any time.
//
// Picking: pickRay answers "which building does this ray hit" through BuildingPicker (picking.ts), so no
// THREE.Raycaster runs over the instances. Each mesh's raycast() reports only the building it owns.
import { BoxGeometry, BufferGeometry, Color, InstancedBufferAttribute, InstancedMesh, Vector3, type Intersection, type Ray, type Raycaster, type MeshStandardMaterial } from 'three'
import type { CityLayout } from '@shared/types'
import type { Heat, Mode } from '../state/store'
import { visHeight } from './geom'
import { DEFAULT_LOC, hashPath, planBudget, type Placement, type PickInput } from './modelPicker'
import { BuildingPicker } from './picking'
import type { LoadedModel } from './assets/loader'
import type { BuildingMaterials } from './buildingShader'

/** Seconds for a touch glow to fade from 1 to 0. */
export const HEAT_DECAY_S = 25
/** Seconds for a building to move from one color mode's color to the next. */
export const COLOR_FADE_S = 0.4
/** Seconds for the boxes to hand over to the models. */
export const CROSSFADE_S = 0.6
const SPRING_K = 60
const SPRING_C = 2 * Math.sqrt(SPRING_K) // critical damping
const SHIMMER_RATE = 1.6

export interface FieldGate {
  mode: Mode;
  gitTs: number | null;
  firstSeen: Record<string, number>;
  /** Building colors by path for the current color mode. Missing paths keep the layout's language color. */
  colors?: ReadonlyMap<string, string> | null;
  /** Lines of code by path, which picks each file's model. Missing paths count as DEFAULT_LOC. */
  loc?: ReadonlyMap<string, number> | null;
  /** Models already in memory. When all the ids this field needs are here it starts with them, with no boxes. */
  models?: ReadonlyMap<string, LoadedModel> | null;
}

export interface Slot {
  path: string;
  x: number; z: number; w: number; d: number;
  baseH: number;          // rendered height at build time
  h: number; v: number;   // animated height and its velocity
  target: number;
  shim: number;           // construction shimmer, decays to 0
  seed: number;           // [0,1), stable per path
  ghost: boolean;         // file left the repo: sinking into the ground
  dead: boolean;          // finished sinking, hidden until the next layout
  base: string;           // the layout's color (language), used when a color mode has no entry for the path
  writtenH: number;       // height last written to the instance buffers
  place: Placement;       // model for this file (kept while the file is a ghost)
}

interface Batch {
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  /** Local instance index to slot index. */
  slots: Int32Array;
  aSize: InstancedBufferAttribute;
  aLang: InstancedBufferAttribute;
  aGlow: InstancedBufferAttribute;
  aGlowColor: InstancedBufferAttribute;
  aSel: InstancedBufferAttribute;
  aShim: InstancedBufferAttribute;
  aSeed: InstancedBufferAttribute;
}

interface Layer {
  kind: 'boxes' | 'models';
  batches: Batch[];
  /** Slot index to batch index, and to the local instance index inside that batch. */
  slotBatch: Int32Array;
  slotLocal: Int32Array;
  /** Instance scale factor of the whole layer (crossfade). */
  fade: number;
  /** Whether hover and click reach this layer. */
  pickable: boolean;
  dirtyMatrix: boolean;
  dirtyAttr: boolean;
  dirtyColor: boolean;
}

export interface PickedBuilding {
  slot: number;
  distance: number;
  point: Vector3;
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t)
}

export class BuildingField {
  readonly slots: Slot[];
  /** Called when the set of meshes changes (models adopted, boxes removed). */
  onChange: (() => void) | null = null;

  private readonly mats: BuildingMaterials;
  private layers: Layer[] = [];
  private meshList: InstancedMesh[] = [];
  private readonly byPath = new Map<string, number>();
  private readonly picker: BuildingPicker;
  private disposed = false;
  private fadeT = 1;

  // Slot-indexed state. Written to the layers through the flush helpers.
  private readonly colorCur: Float32Array;
  private colorFrom = new Float32Array(0);
  private colorTo = new Float32Array(0);
  private colorT = 1;
  private readonly glow: Float32Array;
  private readonly glowCol: Float32Array;
  private readonly sel: Float32Array;
  private hotRef: Record<string, Heat> | null = null;
  private hot: { idx: number; heat: Heat }[] = [];
  private lit: number[] = [];
  private hoverIdx = -1;
  private selIdx = -1;

  // Pick memo: the same ray twice (R3F asks once per mesh) costs one query.
  private rayKey = new Float64Array([NaN, NaN, NaN, NaN, NaN, NaN]);
  private rayValid = false;
  private rayHit = -1;
  private rayT = Infinity;
  private rayLen = 1;
  private readonly hitPoint = new Vector3();

  constructor(layout: CityLayout, mats: BuildingMaterials, prev: BuildingField | null, gate: FieldGate) {
    this.mats = mats
    const inputs: PickInput[] = layout.buildings.map((b) => ({
      path: b.path,
      w: b.w,
      d: b.d,
      h: visHeight(b, layout),
      loc: gate.loc?.get(b.path) ?? DEFAULT_LOC
    }))
    const plan = planBudget(inputs)

    const nowPaths = new Set<string>()
    const slots: Slot[] = []
    layout.buildings.forEach((b, k) => {
      nowPaths.add(b.path)
      const old = prev?.slotFor(b.path)
      const target = inputs[k]!.h
      slots.push({
        path: b.path,
        x: b.x, z: b.z, w: b.w, d: b.d,
        baseH: target,
        // Buildings that survive keep their height and shimmer; new ones rise from the ground with a shimmer.
        h: old ? old.h : 0,
        v: old ? old.v : 0,
        target,
        shim: old ? old.shim : 1,
        seed: hashPath(b.path),
        ghost: false,
        dead: false,
        base: b.color,
        writtenH: -1,
        place: plan[k]!
      })
    })
    // Files that left the layout keep their footprint and model, and sink into the ground.
    if (prev) {
      for (const old of prev.slots) {
        if (old.dead || nowPaths.has(old.path)) continue
        slots.push({ ...old, ghost: true, target: 0, shim: 0, writtenH: -1 })
      }
    }
    this.slots = slots
    const n = slots.length

    this.colorCur = new Float32Array(n * 3)
    this.glow = new Float32Array(n)
    this.glowCol = new Float32Array(n * 3)
    this.sel = new Float32Array(n)
    const tmp = new Color()
    slots.forEach((s, i) => {
      if (!s.ghost) this.byPath.set(s.path, i)
      tmp.set(gate.colors?.get(s.path) ?? s.base)
      this.colorCur[i * 3] = tmp.r
      this.colorCur[i * 3 + 1] = tmp.g
      this.colorCur[i * 3 + 2] = tmp.b
    })

    this.picker = new BuildingPicker(
      slots,
      slots.map((s) => !s.ghost),
      slots.map((s) => (s.ghost || s.dead ? 0 : s.h))
    )

    const ready = gate.models
    const needed = this.modelIds()
    if (ready && needed.every((id) => ready.has(id))) {
      this.fadeT = 1
      this.addLayer(this.buildLayer('models', ready))
    } else {
      this.fadeT = 1
      this.addLayer(this.buildLayer('boxes', null))
    }
    this.retarget(gate.mode, gate.gitTs, gate.firstSeen)
    this.commit()
  }

  // ---------- public API ----------

  get hasModels(): boolean {
    return this.layers.some((L) => L.kind === 'models')
  }

  /** Every instanced mesh that should be in the scene right now. */
  get meshes(): readonly InstancedMesh[] {
    return this.meshList
  }

  /** Triangles one frame draws for this field: instances times triangles per model, over the meshes in the scene. */
  get triangleCount(): number {
    let n = 0
    for (const L of this.layers) {
      for (const b of L.batches) {
        const tris = (b.geometry.index ? b.geometry.index.count : (b.geometry.getAttribute('position')?.count ?? 0)) / 3
        n += tris * b.mesh.count
      }
    }
    return n
  }

  /** Model ids this field needs (ghosts included). */
  modelIds(): string[] {
    return [...new Set(this.slots.map((s) => s.place.modelId))]
  }

  /** Model placement for a live building, for tests and debugging. */
  placementOf(path: string): Placement | undefined {
    const i = this.byPath.get(path)
    return i === undefined ? undefined : this.slots[i]?.place
  }

  /**
   * Adopts the models: builds their layer, which grows from zero while the boxes shrink. Returns false when a model is
   * missing (the boxes stay) or the field is gone.
   */
  adoptModels(models: ReadonlyMap<string, LoadedModel>): boolean {
    if (this.disposed || this.hasModels) return false
    if (!this.modelIds().every((id) => models.has(id))) return false
    const layer = this.buildLayer('models', models)
    layer.fade = 0
    layer.pickable = true
    for (const L of this.layers) if (L.kind === 'boxes') L.pickable = false
    this.addLayer(layer)
    this.fadeT = 0
    this.writeAllMatrices()
    this.commit()
    return true
  }

  /** Recolors the buildings for a color mode. Animated buildings ease from their current color over COLOR_FADE_S; animate=false applies at once. */
  setColors(colors: ReadonlyMap<string, string>, animate = true): void {
    const n = this.slots.length
    const to = new Float32Array(n * 3)
    const c = new Color()
    for (let i = 0; i < n; i++) {
      const s = this.slots[i]!
      if (s.ghost) {
        to[i * 3] = this.colorCur[i * 3]!
        to[i * 3 + 1] = this.colorCur[i * 3 + 1]!
        to[i * 3 + 2] = this.colorCur[i * 3 + 2]!
        continue
      }
      c.set(colors.get(s.path) ?? s.base)
      to[i * 3] = c.r
      to[i * 3 + 1] = c.g
      to[i * 3 + 2] = c.b
    }
    if (!animate) {
      this.colorCur.set(to)
      this.colorT = 1
      for (let i = 0; i < n; i++) this.flushColor(i)
      this.commitLayers('color')
      return
    }
    this.colorFrom = this.colorCur.slice(0, n * 3)
    this.colorTo = to
    this.colorT = 0
  }

  /** Current color of a live building, as r, g, b in 0..1. Empty for unknown paths. */
  colorOf(path: string): number[] {
    const i = this.byPath.get(path)
    if (i === undefined) return []
    return [this.colorCur[i * 3]!, this.colorCur[i * 3 + 1]!, this.colorCur[i * 3 + 2]!]
  }

  /** Slot for a live (non-ghost) building path. */
  slotFor(path: string): Slot | undefined {
    const i = this.byPath.get(path)
    return i === undefined ? undefined : this.slots[i]
  }

  indexOf(path: string): number {
    return this.byPath.get(path) ?? -1
  }

  /** Path of the building behind an instance of one of this field's meshes, or null for ghosts and hidden slots. */
  pathAt(mesh: InstancedMesh, instanceId: number): string | null {
    for (const L of this.layers) {
      for (const b of L.batches) {
        if (b.mesh !== mesh) continue
        const i = b.slots[instanceId]
        if (i === undefined) return null
        const s = this.slots[i]
        return s && !s.ghost && !s.dead ? s.path : null
      }
    }
    return null
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

  /** Advances the height springs, shimmer, ghost sinking, color transition and layer crossfade. dt in seconds. */
  step(dt: number, realDt: number = dt): void {
    if (this.colorT < 1) this.stepColor(dt)
    if (this.fadeT < 1) this.stepFade(realDt)
    const slots = this.slots
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!
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
        if (Math.abs(hVal - s.writtenH) > 1e-4) this.writeMatrix(i)
      }
      if (s.shim > 0) {
        s.shim = s.shim * Math.exp(-dt * SHIMMER_RATE)
        if (s.shim < 0.002) s.shim = 0
        for (const L of this.layers) {
          const b = L.batches[L.slotBatch[i]!]!
          b.aShim.setX(L.slotLocal[i]!, s.shim)
          L.dirtyAttr = true
        }
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
    for (const idx of this.lit) {
      this.glow[idx] = 0
      this.flushGlow(idx)
    }
    this.lit = []
    for (const { idx, heat: h } of this.hot) {
      const k = 1 - (nowMs - h.ts) / 1000 / HEAT_DECAY_S
      if (k <= 0) continue
      const g = (h.kind === 'read' ? 0.35 : 1) * Math.pow(k, 1.5)
      if (g < 0.002) continue
      const c = colorOf(h.agentId)
      this.glow[idx] = g
      this.glowCol[idx * 3] = c.r
      this.glowCol[idx * 3 + 1] = c.g
      this.glowCol[idx * 3 + 2] = c.b
      this.flushGlow(idx)
      this.lit.push(idx)
    }
    if (hadLit || this.lit.length > 0) this.commitLayers('attr')
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
      this.sel[idx] = idx === this.selIdx ? 1 : idx === this.hoverIdx ? 0.5 : 0
      this.flushSel(idx)
    }
    this.commitLayers('attr')
  }

  /** The building a ray hits first, through the grid accelerator. Memoised on the ray (R3F asks once per mesh). */
  pickRay(ray: Ray): PickedBuilding | null {
    const o = ray.origin
    const d = ray.direction
    const k = this.rayKey
    if (!this.rayValid || k[0] !== o.x || k[1] !== o.y || k[2] !== o.z || k[3] !== d.x || k[4] !== d.y || k[5] !== d.z) {
      k[0] = o.x; k[1] = o.y; k[2] = o.z; k[3] = d.x; k[4] = d.y; k[5] = d.z
      this.rayHit = this.picker.pick(o.x, o.y, o.z, d.x, d.y, d.z)
      this.rayT = this.picker.lastT
      this.rayLen = Math.hypot(d.x, d.y, d.z) || 1
      this.rayValid = true
    }
    if (this.rayHit < 0) return null
    const distance = this.rayT * this.rayLen
    this.hitPoint.set(o.x + (d.x / this.rayLen) * distance, o.y + (d.y / this.rayLen) * distance, o.z + (d.z / this.rayLen) * distance)
    return { slot: this.rayHit, distance, point: this.hitPoint.clone() }
  }

  /** Uploads whatever changed this frame. */
  commit(): void {
    this.commitLayers('matrix')
    this.commitLayers('attr')
    this.commitLayers('color')
  }

  dispose(): void {
    this.disposed = true
    for (const L of this.layers) this.disposeLayer(L)
    this.layers = []
    this.meshList = []
  }

  // ---------- layers ----------

  private addLayer(L: Layer): void {
    this.layers.push(L)
    this.refreshMeshes()
  }

  private refreshMeshes(): void {
    this.meshList = this.layers.flatMap((L) => L.batches.map((b) => b.mesh))
    this.onChange?.()
  }

  private disposeLayer(L: Layer): void {
    for (const b of L.batches) {
      b.geometry.dispose()
      b.mesh.dispose()
    }
  }

  /** Builds a layer: boxes, or one batch per model id. Every slot is in exactly one batch of the layer. */
  private buildLayer(kind: 'boxes' | 'models', models: ReadonlyMap<string, LoadedModel> | null): Layer {
    const n = this.slots.length
    const groups = new Map<string, number[]>()
    if (kind === 'boxes') {
      groups.set('box', this.slots.map((_, i) => i))
    } else {
      for (let i = 0; i < n; i++) {
        const id = this.slots[i]!.place.modelId
        let g = groups.get(id)
        if (!g) groups.set(id, (g = []))
        g.push(i)
      }
    }
    const layer: Layer = {
      kind,
      batches: [],
      slotBatch: new Int32Array(n),
      slotLocal: new Int32Array(n),
      fade: 1,
      pickable: true,
      dirtyMatrix: true,
      dirtyAttr: true,
      dirtyColor: true
    }
    let bi = 0
    for (const [id, idx] of groups) {
      let geometry: BufferGeometry
      let material: MeshStandardMaterial
      if (kind === 'boxes') {
        geometry = new BoxGeometry(1, 1, 1)
        geometry.translate(0, 0.5, 0) // base sits at y = 0
        material = this.mats.boxes
      } else {
        const src = models?.get(id)
        if (!src) throw new Error(`model not loaded: ${id}`)
        geometry = shareGeometry(src.geometry)
        material = this.mats.models
      }
      const batch = makeBatch(geometry, material, idx)
      layer.batches.push(batch)
      for (let l = 0; l < idx.length; l++) {
        layer.slotBatch[idx[l]!] = bi
        layer.slotLocal[idx[l]!] = l
      }
      batch.mesh.raycast = (rc: Raycaster, hits: Intersection[]) => this.raycastBatch(layer, batch, rc, hits)
      bi++
    }
    this.syncLayer(layer)
    return layer
  }

  /** Writes every per-slot value into one layer. */
  private syncLayer(L: Layer): void {
    for (let i = 0; i < this.slots.length; i++) {
      const b = L.batches[L.slotBatch[i]!]!
      const l = L.slotLocal[i]!
      const s = this.slots[i]!
      b.aSeed.setX(l, s.seed)
      b.aShim.setX(l, s.shim)
      b.aGlow.setX(l, this.glow[i]!)
      b.aGlowColor.setXYZ(l, this.glowCol[i * 3]!, this.glowCol[i * 3 + 1]!, this.glowCol[i * 3 + 2]!)
      b.aSel.setX(l, this.sel[i]!)
      b.aLang.setXYZ(l, this.colorCur[i * 3]!, this.colorCur[i * 3 + 1]!, this.colorCur[i * 3 + 2]!)
      this.writeMatrix(i)
    }
    L.dirtyMatrix = true
    L.dirtyAttr = true
    L.dirtyColor = true
  }

  private layerOf(kind: 'boxes' | 'models'): Layer | undefined {
    return this.layers.find((L) => L.kind === kind)
  }

  private stepFade(dt: number): void {
    this.fadeT = Math.min(1, this.fadeT + dt / CROSSFADE_S)
    const e = smooth01(this.fadeT)
    const models = this.layerOf('models')
    const boxes = this.layerOf('boxes')
    if (models) models.fade = e
    if (boxes) boxes.fade = 1 - e
    this.writeAllMatrices()
    if (this.fadeT >= 1 && boxes) {
      this.disposeLayer(boxes)
      this.layers = this.layers.filter((L) => L !== boxes)
      this.refreshMeshes()
    }
  }

  private raycastBatch(L: Layer, b: Batch, rc: Raycaster, hits: Intersection[]): void {
    if (!L.pickable) return
    const hit = this.pickRay(rc.ray)
    if (!hit) return
    if (L.batches[L.slotBatch[hit.slot]!] !== b) return
    if (hit.distance < rc.near || hit.distance > rc.far) return
    hits.push({ distance: hit.distance, point: hit.point, object: b.mesh, instanceId: L.slotLocal[hit.slot] } as Intersection)
  }

  // ---------- per-slot writes ----------

  /** Instance matrix and size of slot i in every layer, from its live height. Keeps the picker's top in step. */
  private writeMatrix(i: number): void {
    const s = this.slots[i]!
    const hh = s.dead ? 0 : Math.max(0, s.h)
    if (!s.ghost) this.picker.setTop(i, hh)
    this.rayValid = false
    for (const L of this.layers) {
      const b = L.batches[L.slotBatch[i]!]!
      const l = L.slotLocal[i]!
      const m = b.mesh.instanceMatrix.array as Float32Array
      const o = l * 16
      const k = L.fade
      const on = hh > 0 && k > 0
      const boxed = L.kind === 'boxes'
      const sx = boxed ? s.w : s.place.sx
      const sz = boxed ? s.d : s.place.sz
      const sy = boxed ? hh : hh * s.place.invY
      m[o] = on ? sx * k : 0
      m[o + 5] = on ? sy * k : 0
      m[o + 10] = on ? sz * k : 0
      m[o + 12] = s.x + s.w / 2
      m[o + 14] = s.z + s.d / 2
      b.aSize.setXYZ(l, s.w, hh, s.d)
      L.dirtyMatrix = true
    }
    s.writtenH = hh
  }

  private writeAllMatrices(): void {
    for (let i = 0; i < this.slots.length; i++) this.writeMatrix(i)
  }

  private flushColor(i: number): void {
    for (const L of this.layers) {
      const b = L.batches[L.slotBatch[i]!]!
      b.aLang.setXYZ(L.slotLocal[i]!, this.colorCur[i * 3]!, this.colorCur[i * 3 + 1]!, this.colorCur[i * 3 + 2]!)
      L.dirtyColor = true
    }
  }

  private flushGlow(i: number): void {
    for (const L of this.layers) {
      const b = L.batches[L.slotBatch[i]!]!
      const l = L.slotLocal[i]!
      b.aGlow.setX(l, this.glow[i]!)
      b.aGlowColor.setXYZ(l, this.glowCol[i * 3]!, this.glowCol[i * 3 + 1]!, this.glowCol[i * 3 + 2]!)
      L.dirtyAttr = true
    }
  }

  private flushSel(i: number): void {
    for (const L of this.layers) {
      const b = L.batches[L.slotBatch[i]!]!
      b.aSel.setX(L.slotLocal[i]!, this.sel[i]!)
      L.dirtyAttr = true
    }
  }

  private stepColor(dt: number): void {
    this.colorT = Math.min(1, this.colorT + dt / COLOR_FADE_S)
    const e = smooth01(this.colorT)
    const from = this.colorFrom
    const to = this.colorTo
    const m = Math.min(this.colorCur.length, from.length, to.length)
    for (let k = 0; k < m; k++) this.colorCur[k] = (from[k] ?? 0) + ((to[k] ?? 0) - (from[k] ?? 0)) * e
    for (let i = 0; i < this.slots.length; i++) this.flushColor(i)
  }

  private commitLayers(what: 'matrix' | 'attr' | 'color'): void {
    for (const L of this.layers) {
      if (what === 'matrix' && L.dirtyMatrix) {
        for (const b of L.batches) {
          b.mesh.instanceMatrix.needsUpdate = true
          b.aSize.needsUpdate = true
        }
        L.dirtyMatrix = false
      } else if (what === 'attr' && L.dirtyAttr) {
        for (const b of L.batches) {
          b.aShim.needsUpdate = true
          b.aGlow.needsUpdate = true
          b.aGlowColor.needsUpdate = true
          b.aSel.needsUpdate = true
        }
        L.dirtyAttr = false
      } else if (what === 'color' && L.dirtyColor) {
        for (const b of L.batches) b.aLang.needsUpdate = true
        L.dirtyColor = false
      }
    }
  }
}

/** A geometry for one batch that shares the model's vertex buffers (the model stays cached and unchanged). */
function shareGeometry(src: BufferGeometry): BufferGeometry {
  const g = new BufferGeometry()
  for (const name of ['position', 'normal', 'uv', 'aWin']) {
    const a = src.getAttribute(name)
    if (a) g.setAttribute(name, a)
  }
  if (src.index) g.setIndex(src.index)
  return g
}

function makeBatch(geometry: BufferGeometry, material: MeshStandardMaterial, slotIdx: number[]): Batch {
  const n = slotIdx.length
  const attr = (size: number) => new InstancedBufferAttribute(new Float32Array(n * size), size)
  const batch: Batch = {
    mesh: null!,
    geometry,
    slots: Int32Array.from(slotIdx),
    aSize: attr(3),
    aLang: attr(3),
    aGlow: attr(1),
    aGlowColor: attr(3),
    aSel: attr(1),
    aShim: attr(1),
    aSeed: attr(1)
  }
  geometry.setAttribute('aSize', batch.aSize)
  geometry.setAttribute('aLang', batch.aLang)
  geometry.setAttribute('aGlow', batch.aGlow)
  geometry.setAttribute('aGlowColor', batch.aGlowColor)
  geometry.setAttribute('aSel', batch.aSel)
  geometry.setAttribute('aShim', batch.aShim)
  geometry.setAttribute('aSeed', batch.aSeed)
  batch.mesh = new InstancedMesh(geometry, material, n)
  batch.mesh.frustumCulled = false
  return batch
}
