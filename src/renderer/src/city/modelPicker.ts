// Chooses which Kenney model stands for each file, and how it is scaled to its footprint and height.
// Pure (no three.js): BuildingField turns the placements into instance matrices.
import { modelsByClass, type ModelClass, type ModelDef } from './assets/manifest'
import { TEMPLATES, templatesWith, templateTris, type Template } from './facade/templates'
import { facadeSetFor, litFor } from './facade/massing'
import { FACADE_SETS } from './facade/photo/sets'
import { KIT_BUILDINGS, type KitBuilding, type KitTier } from './kit/kitManifest'

/** Share of the file's footprint the model fills; the rest stays street and plaza. */
export const FILL = 0.9
/** Allowed vertical stretch: rendered height over footprint scale. Outside it another model is picked, never a distortion. */
export const MIN_STRETCH = 0.5
export const MAX_STRETCH = 3
/**
 * Wider range for the classes whose models are plain, squat blocks (houses, low-detail): a squat file gets a squat
 * house instead of a distorted tower, so out-of-range placements stay rare on small repos.
 */
export const WIDE_MIN_STRETCH = 0.35
export const WIDE_MAX_STRETCH = 4
/**
 * Low-detail models are plain blocks with no windows to distort, so they may be stretched further: a tiny flat file
 * becomes a flat low-detail block. Outside this range even they are not used.
 */
export const LOW_DETAIL_MIN_STRETCH = 0.1
export const LOW_DETAIL_MAX_STRETCH = 10
/** Triangles the city may draw in total. */
export const TRI_BUDGET = 3_000_000
/** Repos above this many files are large: their tiniest files may use the low-detail models. */
export const BIG_REPO = 1500
/** Files shorter than this many lines are tiny. */
export const TINY_LOC = 25
/** LOC percentile below which a file counts as tiny. */
const TINY_PCT = 0.35
/** Top share of files by LOC: skyscrapers. */
const SKY_PCT = 0.98
/** Next share: towers. */
const TOWER_PCT = 0.88
/** Log-aspect distance within which two models count as equally good; the path hash picks among them. */
const NEAR_TIE = 0.08
/** LOC assumed for a file the caller has no count for: a middling file. */
export const DEFAULT_LOC = 100

export interface PickInput {
  path: string;
  /** Footprint, world units. */
  w: number;
  d: number;
  /** Rendered height, world units (visHeight). */
  h: number;
  loc: number;
}

export interface Placement {
  modelId: string;
  cls: ModelClass;
  tris: number;
  /** Model x and z scale: the model's footprint, FILL of the file's footprint. */
  sx: number;
  sz: number;
  /** Multiply the rendered height by this for the model's y scale (the model's base sits at y = 0). */
  invY: number;
  /** Rendered height over footprint scale: sy / max(sx, sz). Within [MIN_STRETCH, MAX_STRETCH] unless no model fits. */
  stretch: number;
}

/** FNV-1a of a path, in [0, 1). Deterministic: the same file always gets the same tie-break. */
export function hashPath(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

const DETAILED_CLASSES: ModelClass[] = ['house', 'lowrise', 'midrise', 'tower', 'skyscraper']
const CANDIDATES = new Map<ModelClass, ModelDef[]>(
  [...DETAILED_CLASSES, 'lowdetail' as const].map((c) => [c, modelsByClass(c)])
)
/** Detailed building models: what a file gets unless the budget or the repo size says otherwise. */
const DETAILED = DETAILED_CLASSES.flatMap((c) => CANDIDATES.get(c) ?? [])
const ALL_BUILDINGS = [...DETAILED, ...(CANDIDATES.get('lowdetail') ?? [])]
const BY_TRIS = [...ALL_BUILDINGS].sort((a, b) => a.tris - b.tris)
const LOW_DETAIL = CANDIDATES.get('lowdetail') ?? []

/** Model scale for a footprint and height, and the resulting stretch. Pure. */
export function stretchOf(w: number, d: number, h: number, m: ModelDef): number {
  const sx = (Math.max(w, 1e-6) * FILL) / m.size.x
  const sz = (Math.max(d, 1e-6) * FILL) / m.size.z
  return (h / m.size.y) / Math.max(sx, sz)
}

/** |log(target aspect / model aspect)|, aspect = height over the wider side. Lower is closer. */
export function aspectError(w: number, d: number, h: number, m: ModelDef): number {
  const target = h / Math.max(w, d, 1e-6)
  const model = m.size.y / Math.max(m.size.x, m.size.z)
  return Math.abs(Math.log(target / model))
}

/** Allowed stretch range for a model class. */
export function stretchRange(cls: ModelClass): readonly [number, number] {
  if (cls === 'lowdetail') return [LOW_DETAIL_MIN_STRETCH, LOW_DETAIL_MAX_STRETCH]
  if (cls === 'house') return [WIDE_MIN_STRETCH, WIDE_MAX_STRETCH]
  return [MIN_STRETCH, MAX_STRETCH]
}

function inRange(m: ModelDef, s: number): boolean {
  const [lo, hi] = stretchRange(m.cls)
  return s >= lo && s <= hi
}

function placementOf(input: PickInput, m: ModelDef): Placement {
  return {
    modelId: m.id,
    cls: m.cls,
    tris: m.tris,
    sx: (Math.max(input.w, 1e-6) * FILL) / m.size.x,
    sz: (Math.max(input.d, 1e-6) * FILL) / m.size.z,
    invY: 1 / m.size.y,
    stretch: stretchOf(input.w, input.d, input.h, m)
  }
}

/**
 * Best model among `candidates` whose stretch is in range: the smallest aspect error, with the path hash choosing
 * among the near-equal ones so neighbours differ. Null when no candidate fits (the caller tries another class).
 */
export function pickFrom(input: PickInput, candidates: readonly ModelDef[]): Placement | null {
  let min = Infinity
  const ok: { m: ModelDef; err: number }[] = []
  for (const m of candidates) {
    if (!inRange(m, stretchOf(input.w, input.d, input.h, m))) continue
    const err = aspectError(input.w, input.d, input.h, m)
    ok.push({ m, err })
    if (err < min) min = err
  }
  if (ok.length === 0) return null
  const near = ok.filter((e) => e.err <= min + NEAR_TIE)
  const pick = near[Math.min(near.length - 1, Math.floor(hashPath(input.path) * near.length))]
  return pick ? placementOf(input, pick.m) : null
}

/** Last resort when no detailed model fits: the one closest to the target stretch. Out of range on purpose. */
function closestAny(input: PickInput): Placement {
  let best = DETAILED[0]!
  let bestErr = Infinity
  for (const m of DETAILED) {
    const s = stretchOf(input.w, input.d, input.h, m)
    const err = Math.abs(Math.log(Math.max(s, 1e-9)) - Math.log(1))
    if (err < bestErr) {
      bestErr = err
      best = m
    }
  }
  return placementOf(input, best)
}

/** Cheapest (fewest triangles) model that fits; the cheapest overall when none does. */
function cheapestFit(input: PickInput): Placement {
  for (const m of BY_TRIS) {
    if (inRange(m, stretchOf(input.w, input.d, input.h, m))) return placementOf(input, m)
  }
  return placementOf(input, BY_TRIS[0]!)
}

/** Share of files strictly shorter than a given line count, in [0, 1). */
export class LocRank {
  private readonly sorted: Float64Array

  constructor(locs: ArrayLike<number>) {
    this.sorted = Float64Array.from(locs).sort()
  }

  percentile(loc: number): number {
    const n = this.sorted.length
    if (n === 0) return 0
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.sorted[mid]! < loc) lo = mid + 1
      else hi = mid
    }
    return lo / n
  }
}

/** Model classes to try, in order, for a file with this LOC and percentile. */
export function classChain(loc: number, pct: number, big: boolean): ModelClass[] {
  if (loc < TINY_LOC || pct < TINY_PCT) return big ? ['lowdetail', 'house', 'lowrise'] : ['house', 'lowrise', 'midrise']
  if (pct >= SKY_PCT) return ['skyscraper', 'tower', 'midrise']
  if (pct >= TOWER_PCT) return ['tower', 'midrise', 'skyscraper']
  return ['lowrise', 'midrise', 'house']
}

/** The model for one file, before the triangle budget. */
export function pickPlacement(input: PickInput, rank: LocRank, big: boolean): Placement {
  const pct = rank.percentile(input.loc)
  for (const cls of classChain(input.loc, pct, big)) {
    const p = pickFrom(input, CANDIDATES.get(cls) ?? [])
    if (p) return p
  }
  // Big repos may use a stretched low-detail block for a squat file; small repos keep a detailed model.
  return pickFrom(input, DETAILED) ?? (big ? pickFrom(input, LOW_DETAIL) : null) ?? closestAny(input)
}

/**
 * Models for every building, within the triangle budget. Pure and deterministic.
 * Over budget, the smallest files (by LOC) are degraded, and only as many as needed: the smallest k files, where k is
 * the least that brings the total under budget. Stage 1 gives them their cheapest model that fits the footprint (low-detail
 * models come first, as they are the cheapest). If that is not enough, stage 2 gives the same files the cheapest model at all,
 * even out of range: squat files need this at 10k+ files, and a tiny stretched block costs far less than a broken budget.
 * The largest files keep their detailed models. Returns placements in input order.
 */
export function planBudget(inputs: readonly PickInput[], budget = TRI_BUDGET): Placement[] {
  const rank = new LocRank(inputs.map((i) => i.loc))
  const big = inputs.length > BIG_REPO
  const plan = inputs.map((i) => pickPlacement(i, rank, big))
  let total = 0
  for (const p of plan) total += p.tris
  if (total <= budget) return plan

  const hashes = inputs.map((i) => hashPath(i.path))
  const order = inputs.map((_, i) => i).sort((a, b) => inputs[a]!.loc - inputs[b]!.loc || hashes[a]! - hashes[b]!)
  total = degradeSmallest(plan, inputs.map(cheapestFit), order, total, budget)
  if (total > budget) {
    total = degradeSmallest(plan, inputs.map((i) => placementOf(i, BY_TRIS[0]!)), order, total, budget)
  }
  return plan
}

/**
 * Degrades the fewest files, taken in `order`, to their `alts` placement (only where that saves triangles), until the
 * total is within budget. Returns the new total.
 */
function degradeSmallest(plan: Placement[], alts: Placement[], order: readonly number[], total: number, budget: number): number {
  const gain = order.map((i) => Math.max(0, plan[i]!.tris - alts[i]!.tris))
  let t = total
  let k = 0
  while (t > budget && k < order.length) {
    t -= gain[k]!
    k++
  }
  for (let j = 0; j < k; j++) {
    const i = order[j]!
    if (alts[i]!.tris < plan[i]!.tris) plan[i] = alts[i]!
  }
  return t
}

// ---------- 'real' style: kit towers and photographic massing ----------

/** Share of files (by LOC) drawn as kit towers, at least one. The single largest file is always a candidate. */
export const KIT_SHARE = 0.04
/**
 * Distortion limit for a kit tower: its footprint may be stretched to the file's aspect by at most this factor, and its
 * height may differ from the footprint's geometric mean by at most this factor either way. Past it, the file keeps its
 * photographic massing.
 */
export const KIT_MAX_DISTORTION = 1.6

/** Share of the footprint a facade fills: the rest is the street gap the layout leaves between cells. */
export const FACADE_FILL = 0.97
/** Smallest footprint side a facade is drawn at, so a tiny file still reads as a small building. */
export const FACADE_MIN_FOOT = 0.22
/** Rendered height below which a file is a squat plate. */
export const PLATE_MAX_H = 1.6
/** LOC percentile where spires start: the top 1.5 % (the same cut as the height model). */
const FACADE_SUPER_PCT = 0.985

/** The massing template for one file. Pure: the path hash picks among the templates of the right kind. */
export function facadePlacement(input: PickInput, pct: number): Placement {
  const spire = pct >= FACADE_SUPER_PCT
  const tower = pct >= TOWER_PCT
  const squat = input.h < PLATE_MAX_H
  const wide = Math.max(input.w, input.d) / Math.max(Math.min(input.w, input.d), 1e-6) > 1.6
  let pool: readonly Template[]
  if (spire) pool = templatesWith('spire')
  else if (tower) pool = templatesWith('tower')
  else if (squat) pool = templatesWith('plate')
  else if (wide) pool = templatesWith('complex')
  else pool = templatesWith('mid')
  const t = pool[Math.min(pool.length - 1, Math.floor(hashPath(input.path) * pool.length))] ?? TEMPLATES[0]!
  const sx = Math.max(input.w * FACADE_FILL, FACADE_MIN_FOOT)
  const sz = Math.max(input.d * FACADE_FILL, FACADE_MIN_FOOT)
  const cls: ModelClass = spire ? 'skyscraper' : tower ? 'tower' : squat ? 'lowrise' : 'midrise'
  return {
    modelId: t.id,
    cls,
    tris: templateTris(t),
    sx,
    sz,
    invY: 1,
    stretch: input.h / Math.max(sx, sz)
  }
}

/** Kit geometry sizes in world units (the manifest gives metres: 10 m per unit). */
export function kitSize(k: KitBuilding): { w: number; d: number; h: number } {
  return { w: k.footprintM.w / 10, d: k.footprintM.d / 10, h: k.heightM / 10 }
}

/** How a kit tower would be scaled onto one file. Instance scales multiply the kit geometry, which is in world units. */
export interface KitFit {
  sx: number;
  sz: number;
  /** Instance y scale per world unit of rendered height: y scale = rendered height x invY. */
  invY: number;
  /** Footprint stretch: the larger side scale over the smaller (1 = the file's own aspect is the model's). */
  footprintDistortion: number;
  /** Vertical scale over the footprint's geometric mean scale (1 = true proportions). */
  verticalStretch: number;
}

/** Fit of one kit tower to one file, or null when the stretch would exceed KIT_MAX_DISTORTION. Pure. */
export function kitFit(input: PickInput, k: KitBuilding): KitFit | null {
  const s = kitSize(k)
  const sx = (Math.max(input.w, 1e-6) * FACADE_FILL) / s.w
  const sz = (Math.max(input.d, 1e-6) * FACADE_FILL) / s.d
  const invY = 1 / s.h
  const footprintDistortion = Math.max(sx, sz) / Math.min(sx, sz)
  const verticalStretch = (input.h * invY) / Math.sqrt(sx * sz)
  if (footprintDistortion > KIT_MAX_DISTORTION) return null
  if (verticalStretch > KIT_MAX_DISTORTION || verticalStretch < 1 / KIT_MAX_DISTORTION) return null
  return { sx, sz, invY, footprintDistortion, verticalStretch }
}

type KitBand = 'top' | 'high' | 'rest'

/** Tier penalties by rank band: the largest file wants a supertall, the next quarter towers, the rest mid-rise. */
const KIT_TIER_PENALTY: Record<KitBand, Record<KitTier, number>> = {
  top: { supertall: 0, tower: 0.6, midrise: 1.2, lowrise: 2 },
  high: { supertall: 0.25, tower: 0, midrise: 0.6, lowrise: 1.5 },
  rest: { supertall: 1, tower: 0.3, midrise: 0, lowrise: 0.4 }
}

const KIT_CLASS: Record<KitTier, ModelClass> = { supertall: 'skyscraper', tower: 'tower', midrise: 'midrise', lowrise: 'lowrise' }

/** How many files are drawn as kit towers in a repo of n files. */
export function kitCount(n: number): number {
  return n <= 0 ? 0 : Math.max(1, Math.round(n * KIT_SHARE))
}

/** The kit tower for one file of LOC rank `rank` (0 = largest), or null when none fits within the stretch limit. */
export function pickKit(input: PickInput, rank: number, count: number, kits: readonly KitBuilding[] = KIT_BUILDINGS): Placement | null {
  const band: KitBand = rank === 0 ? 'top' : rank < count / 4 ? 'high' : 'rest'
  let min = Infinity
  const ok: { k: KitBuilding; fit: KitFit; score: number }[] = []
  for (const k of kits) {
    const fit = kitFit(input, k)
    if (!fit) continue
    const score = KIT_TIER_PENALTY[band][k.tier] + Math.abs(Math.log(fit.verticalStretch))
    ok.push({ k, fit, score })
    if (score < min) min = score
  }
  if (ok.length === 0) return null
  const near = ok.filter((e) => e.score <= min + NEAR_TIE)
  const pick = near[Math.min(near.length - 1, Math.floor(hashPath(input.path + '|kit') * near.length))]!
  const { k, fit } = pick
  return {
    modelId: k.id,
    cls: KIT_CLASS[k.tier],
    tris: k.tris,
    sx: fit.sx,
    sz: fit.sz,
    invY: fit.invY,
    stretch: fit.verticalStretch
  }
}

/** One file in the 'real' style: a kit tower or the photographic massing, with the facade set and lit share of its wall. */
export interface RealPlacement {
  /** True: drawn as the kit tower in `place`. False: drawn as the massing in `place`. */
  kit: boolean;
  /** What is drawn: the kit model, or the massing template. */
  place: Placement;
  /** The massing, always computed: what a file shows before the kit models are in, and when it is not a kit. */
  massing: Placement;
  /** Index into FACADE_SETS (the atlas cell and the aFacade value). */
  facadeSet: number;
  /** Lit share of the windows, 0..1 (aLit). */
  lit: number;
}

/**
 * The real style's plan for every file, in input order. The top kitCount(n) files by LOC are kit towers where one fits the
 * stretch limit; the rest, and any file no kit fits, are massing. Pure and deterministic.
 */
export function planReal(inputs: readonly PickInput[]): RealPlacement[] {
  const rank = new LocRank(inputs.map((i) => i.loc))
  const order = inputs.map((_, i) => i).sort((a, b) => inputs[b]!.loc - inputs[a]!.loc || hashPath(inputs[a]!.path) - hashPath(inputs[b]!.path))
  const rankOf = new Int32Array(inputs.length)
  order.forEach((idx, r) => { rankOf[idx] = r })
  const count = kitCount(inputs.length)
  return inputs.map((input, i) => {
    const massing = facadePlacement(input, rank.percentile(input.loc))
    const facadeSet = facadeSetFor(input.h, hashPath(input.path + '|set'))
    const lit = litFor(FACADE_SETS[facadeSet]!, hashPath(input.path + '|lit'))
    const kit = rankOf[i]! < count ? pickKit(input, rankOf[i]!, count) : null
    return kit ? { kit: true, place: kit, massing, facadeSet, lit } : { kit: false, place: massing, massing, facadeSet, lit }
  })
}

/** Lines of code by path, from a scan's files. */
export function locByPath(files: readonly { path: string; loc: number }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const f of files) m.set(f.path, f.loc)
  return m
}
