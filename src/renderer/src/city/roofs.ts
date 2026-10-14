// Rooftop clutter and steam emitters (pure, no three.js), plus the per-layout caches the three components share.
//
// Density follows height: low roofs stay bare, mid-rise roofs get tanks, AC boxes, vents and parapet lips, tall
// roofs get bulkheads, masts, dishes, lit crowns and helipads, and the top 1.5 % by height get spires with red
// aviation beacons. Everything is thinned by distance from the city centre, and the whole plan is capped at
// ROOF_BUDGET instances. Positions use the rendered height (visHeight), so roofs sit on what is drawn.
import type { CityLayout } from '@shared/types'
import { visHeight } from './geom'
import { ROAD_PIECES, buildRoadPlan } from './streets'
import { hash01, planSigns, type PlanBuilding, type SignPlan } from './signs'

/** Instances the rooftop plan may use for the whole city (the brief allows 40 k for 20 k files). */
export const ROOF_BUDGET = 40_000
export const TALL_TOP = 22
export const MID_TOP = 4
/** Share of buildings that get a spire, the top of the height order. */
export const SPIRE_SHARE = 0.015
export const STEAM_ROOF = 40
export const STEAM_STREET = 80
/** Street emitters keep this far apart, so manholes do not stack into one plume. */
export const STEAM_SPACING = 7
export const HELIPAD_MAX = 80

export type BoxKind = 'ac' | 'bulkhead' | 'lip'
export type BeaconColor = 'red' | 'white' | 'green'

/** One instance: a point on a roof with its size (world units) and a stable tone in [0, 1) for colour variation. */
export interface RoofItem {
  building: number;
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  rot: number;
  /** Rotation about x, used by dishes to tilt toward the sky. */
  tilt: number;
  tone: number;
  kind?: BoxKind;
  /** Vents only: whether this vent is a steam source. */
  steam?: boolean;
}

/** A blinking light point. Red beacons are aviation lights on spires; white and green are helipad edge lights. */
export interface Beacon {
  building: number;
  x: number; y: number; z: number;
  phase: number;
  /** Blinks per second. */
  rate: number;
  color: BeaconColor;
  helipad: boolean;
}

export interface RooftopPlan {
  tanks: RoofItem[];
  boxes: RoofItem[];
  vents: RoofItem[];
  masts: RoofItem[];
  spires: RoofItem[];
  dishes: RoofItem[];
  gardens: RoofItem[];
  helipads: RoofItem[];
  crowns: RoofItem[];
  beacons: Beacon[];
}

export interface SteamEmitter {
  x: number; y: number; z: number;
  kind: 'roof' | 'street';
  seed: number;
}

export interface RoadTileLike { model: string; x: number; z: number }

/** Counts for the debug hook (window.__skylineRooftops). Components update it when they plan. */
export const skylineCounts = { tanks: 0, ac: 0, beacons: 0, signs: 0, steamEmitters: 0 }

export function rooftopCount(plan: RooftopPlan): number {
  return plan.tanks.length + plan.boxes.length + plan.vents.length + plan.masts.length + plan.spires.length +
    plan.dishes.length + plan.gardens.length + plan.helipads.length + plan.crowns.length + plan.beacons.length
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Centre coordinate for an item of half-size `half` inside [lo, hi], at fraction r of the free range. Items that do
 * not fit get the middle.
 */
function inside(lo: number, hi: number, half: number, r: number): number {
  const a = lo + half + 0.05
  const c = hi - half - 0.05
  if (c <= a) return (lo + hi) / 2
  return a + r * (c - a)
}

interface Build {
  buildings: readonly PlanBuilding[];
  keepScale: number;
  dist: Float64Array;
  maxDist: number;
  spires: Set<number>;
}

/** Thinning by distance band: the centre keeps everything, the far edge keeps a fifth. */
function keepFor(bd: Build, i: number): number {
  const band = bd.maxDist > 0 ? bd.dist[i]! / bd.maxDist : 0
  const base = band < 0.45 ? 1 : band < 0.75 ? 0.55 : 0.2
  return base * bd.keepScale
}

function emptyPlan(): RooftopPlan {
  return {
    tanks: [], boxes: [], vents: [], masts: [], spires: [], dishes: [], gardens: [], helipads: [], crowns: [], beacons: []
  }
}

function buildPlan(bd: Build): RooftopPlan {
  const plan = emptyPlan()
  let helipads = 0
  bd.buildings.forEach((b, i) => {
    const top = b.top
    if (top < 3 || b.w * b.d < 0.6) return
    const keep = keepFor(bd, i)
    const r = (key: string): number => hash01(b.path, key)
    const kept = (key: string): boolean => r(key) < keep
    const tall = top >= TALL_TOP
    const mid = top >= MID_TOP
    const cx = b.x + b.w / 2
    const cz = b.z + b.d / 2
    const minSide = Math.min(b.w, b.d)
    const base = (building: number, x: number, z: number, y: number, extra: Partial<RoofItem>): RoofItem => ({
      building, x, y, z, sx: 1, sy: 1, sz: 1, rot: 0, tilt: 0, tone: 0, ...extra
    })

    // Parapet lip: a thin cornice slab a few centimetres over the roof edge.
    if (mid && kept('lip') && r('lip') < 0.55) {
      plan.boxes.push(base(i, cx, cz, top - 0.02, {
        sx: b.w + 0.1, sy: 0.16, sz: b.d + 0.1, tone: r('lip-tone'), kind: 'lip'
      }))
    }

    // Water tank on stilts: the New York icon. Fills most of the mid-rise roofs and some tall ones.
    if (minSide >= 1.2 && mid && kept('tank') && r('tank') < (tall ? 0.5 : 0.3)) {
      const rad = clamp(minSide * 0.16, 0.22, 0.55)
      const count = tall && r('tank-2') < 0.2 ? 2 : 1
      for (let k = 0; k < count; k++) {
        const key = `tank-${k}`
        plan.tanks.push(base(i, inside(b.x, b.x + b.w, rad, r(`${key}-x`)), inside(b.z, b.z + b.d, rad, r(`${key}-z`)), top, {
          sx: rad, sy: 0.9 + 0.7 * r(`${key}-h`), sz: rad, tone: r(`${key}-tone`)
        }))
      }
    }

    // AC boxes: a few per roof, more on tall ones.
    const acCount = tall ? 2 + Math.floor(r('ac-n') * 4) : mid ? Math.floor(r('ac-n') * 3) : 0
    for (let k = 0; k < acCount; k++) {
      if (!kept(`ac-${k}`)) continue
      const s = clamp(minSide * 0.14, 0.25, 0.5) * (0.8 + 0.4 * r(`ac-${k}-s`))
      plan.boxes.push(base(i, inside(b.x, b.x + b.w, s * 0.7, r(`ac-${k}-x`)), inside(b.z, b.z + b.d, s * 0.7, r(`ac-${k}-z`)), top, {
        sx: s, sy: 0.22 + 0.2 * r(`ac-${k}-h`), sz: s * 1.4, tone: r(`ac-${k}-tone`), kind: 'ac'
      }))
    }

    // Stair and elevator bulkheads sit in a roof corner. Tall buildings almost always have one.
    if (((tall && r('bulk') < 0.85) || (top >= 10 && r('bulk') < 0.3)) && kept('bulk')) {
      const sx = b.w * (0.3 + 0.12 * r('bulk-w'))
      const sz = b.d * (0.3 + 0.15 * r('bulk-d'))
      const east = r('bulk-c') < 0.5
      const north = r('bulk-n') < 0.5
      plan.boxes.push(base(i,
        east ? b.x + b.w - sx / 2 - 0.05 : b.x + sx / 2 + 0.05,
        north ? b.z + sz / 2 + 0.05 : b.z + b.d - sz / 2 - 0.05,
        top,
        { sx, sy: clamp(top * 0.05, 0.9, 2.6), sz, tone: r('bulk-tone'), kind: 'bulkhead' }))
    }

    // Vent stacks; about half of them breathe steam.
    if (mid && kept('vent') && r('vent') < 0.4) {
      const n = 1 + (r('vent-2') < 0.4 ? 1 : 0)
      for (let k = 0; k < n; k++) {
        const rad = 0.05 + 0.05 * r(`vent-${k}-r`)
        plan.vents.push(base(i, inside(b.x, b.x + b.w, rad, r(`vent-${k}-x`)), inside(b.z, b.z + b.d, rad, r(`vent-${k}-z`)), top, {
          sx: rad, sy: 0.5 + 0.8 * r(`vent-${k}-h`), sz: rad, tone: r(`vent-${k}-tone`),
          steam: r(`vent-${k}-steam`) < 0.5
        }))
      }
    }

    // Antenna masts on the taller roofs (not spires).
    if (top >= 14 && kept('mast') && r('mast') < 0.25 && !bd.spires.has(i)) {
      plan.masts.push(base(i, inside(b.x, b.x + b.w, 0.1, r('mast-x')), inside(b.z, b.z + b.d, 0.1, r('mast-z')), top, {
        sx: 1, sy: 1.6 + 2.2 * r('mast-h'), sz: 1, tone: r('mast-tone')
      }))
    }

    // Satellite dishes, tilted to the sky.
    if (top >= 10 && kept('dish') && r('dish') < 0.12) {
      const s = 0.35 + 0.25 * r('dish-s')
      plan.dishes.push(base(i, inside(b.x, b.x + b.w, s, r('dish-x')), inside(b.z, b.z + b.d, s, r('dish-z')), top, {
        sx: s, sy: s, sz: s, rot: r('dish-rot') * Math.PI * 2, tilt: 0.45 + 0.35 * r('dish-tilt'), tone: r('dish-tone')
      }))
    }

    // Rooftop gardens: a green slab on a roof big enough for one.
    if (b.w * b.d >= 9 && mid && top < 60 && kept('garden') && r('garden') < 0.1) {
      plan.gardens.push(base(i, cx, cz, top, {
        sx: b.w * 0.7, sy: 0.22, sz: b.d * 0.7, tone: r('garden-tone')
      }))
    }

    // Helipads on the tallest, widest roofs in the middle of the city: a painted disc and a ring of edge lights.
    if (tall && b.w >= 4.5 && b.d >= 4.5 && keepFor(bd, i) > 0.5 && kept('heli') && r('heli') < 0.3 && helipads < HELIPAD_MAX) {
      helipads++
      const size = minSide * 0.6
      plan.helipads.push(base(i, cx, cz, top + 0.03, { sx: size, sy: 1, sz: size, tone: r('heli-tone') }))
      const ring = size * 0.5 + 0.05
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        plan.beacons.push({
          building: i, x: cx + Math.cos(a) * ring, y: top + 0.12, z: cz + Math.sin(a) * ring,
          phase: (k / 8) * Math.PI * 2, rate: 1.1, color: k % 2 === 0 ? 'white' : 'green', helipad: true
        })
      }
    }

    // Lit crowns: warm uplights at the top of a few tall buildings.
    if (tall && kept('crown') && r('crown') < 0.14) {
      plan.crowns.push(base(i, cx, cz, top, {
        sx: Math.max(0.6, minSide * 0.35), sy: 3 + 3 * r('crown-h'), sz: Math.max(0.6, minSide * 0.35), tone: r('crown-tone')
      }))
    }

    // Spires and their red aviation beacon.
    if (bd.spires.has(i)) {
      const sx = clamp(minSide * 0.22, 0.25, 1.2)
      const sy = clamp(top * 0.2, 4, 11)
      plan.spires.push(base(i, cx, cz, top, { sx, sy, sz: sx, tone: r('spire-tone') }))
      plan.beacons.push({
        building: i, x: cx, y: top + sy * 1.4, z: cz, phase: r('beacon-phase') * Math.PI * 2,
        rate: 0.6 + 0.4 * r('beacon-rate'), color: 'red', helipad: false
      })
      if (r('spire-crown') < 0.7) {
        plan.crowns.push(base(i, cx, cz, top, { sx: sx * 2.5, sy: 5, sz: sx * 2.5, tone: r('spire-crown-tone') }))
      }
    }
  })
  return plan
}

/**
 * The rooftop plan for a list of buildings. Pure and deterministic. The count is capped at ROOF_BUDGET by thinning
 * the whole plan once more when the first pass is over it.
 */
export function planRooftops(buildings: readonly PlanBuilding[], budget = ROOF_BUDGET): RooftopPlan {
  const n = buildings.length
  if (n === 0) return emptyPlan()
  let cx = 0, cz = 0
  for (const b of buildings) {
    cx += b.x + b.w / 2
    cz += b.z + b.d / 2
  }
  cx /= n
  cz /= n
  const dist = new Float64Array(n)
  let maxDist = 0
  buildings.forEach((b, i) => {
    const dx = b.x + b.w / 2 - cx, dz = b.z + b.d / 2 - cz
    dist[i] = Math.sqrt(dx * dx + dz * dz)
    if (dist[i]! > maxDist) maxDist = dist[i]!
  })

  // Spires: the tallest 1.5 % of buildings (at least one for a city of 10 or more), if tall enough.
  const spires = new Set<number>()
  if (n >= 10) {
    const order = buildings.map((_, i) => i).sort((a, b) => buildings[b]!.top - buildings[a]!.top || (buildings[a]!.path < buildings[b]!.path ? -1 : 1))
    const count = Math.max(1, Math.round(n * SPIRE_SHARE))
    for (let k = 0; k < count && k < order.length; k++) {
      const i = order[k]!
      if (buildings[i]!.top >= 12) spires.add(i)
    }
  }

  let scale = 1
  let plan = buildPlan({ buildings, keepScale: scale, dist, maxDist, spires })
  let total = rooftopCount(plan)
  // Thinning is not linear in the scale (each item is a threshold test), so the scale is corrected by the ratio.
  for (let pass = 0; pass < 6 && total > budget; pass++) {
    scale = Math.min(1, scale * (budget / total) * 0.97)
    plan = buildPlan({ buildings, keepScale: scale, dist, maxDist, spires })
    total = rooftopCount(plan)
  }
  return total > budget ? truncate(plan, budget) : plan
}

/** Last resort: keep the first items of each list, in order, until the plan fits the budget. */
function truncate(plan: RooftopPlan, budget: number): RooftopPlan {
  const total = rooftopCount(plan)
  const f = budget / total
  const cut = <T>(list: T[]): T[] => list.slice(0, Math.floor(list.length * f))
  return {
    tanks: cut(plan.tanks), boxes: cut(plan.boxes), vents: cut(plan.vents), masts: cut(plan.masts),
    spires: cut(plan.spires), dishes: cut(plan.dishes), gardens: cut(plan.gardens), helipads: cut(plan.helipads),
    crowns: cut(plan.crowns), beacons: cut(plan.beacons)
  }
}

/**
 * Steam emitters: roof vents that breathe steam (up to STEAM_ROOF) and manholes on straight avenue tiles
 * (up to STEAM_STREET, kept STEAM_SPACING apart). Deterministic. About 120 in all.
 */
export function planSteam(vents: readonly RoofItem[], roads: readonly RoadTileLike[]): SteamEmitter[] {
  const out: SteamEmitter[] = []
  for (const v of vents) {
    if (!v.steam || out.length >= STEAM_ROOF) continue
    out.push({ x: v.x, y: v.y + v.sy, z: v.z, kind: 'roof', seed: hash01(`${v.x.toFixed(2)},${v.z.toFixed(2)}`, 'steam') })
  }
  const straights = roads.filter((t) => t.model === ROAD_PIECES.straight.model)
  const ranked = straights
    .map((t) => ({ t, k: hash01(`${t.x.toFixed(2)},${t.z.toFixed(2)}`, 'manhole') }))
    .sort((a, b) => a.k - b.k)
  const street: SteamEmitter[] = []
  for (const { t, k } of ranked) {
    if (street.length >= STEAM_STREET) break
    let ok = true
    for (const s of street) {
      const dx = s.x - t.x, dz = s.z - t.z
      if (dx * dx + dz * dz < STEAM_SPACING * STEAM_SPACING) {
        ok = false
        break
      }
    }
    if (ok) street.push({ x: t.x, y: 0.05, z: t.z, kind: 'street', seed: k })
  }
  return out.concat(street)
}

// ---- Per-layout caches: each layout is planned once, whichever component asks first. -------------------------------

const footprintCache = new WeakMap<CityLayout, PlanBuilding[]>()
const roofCache = new WeakMap<CityLayout, RooftopPlan>()
const signCache = new WeakMap<CityLayout, SignPlan>()
const steamCache = new WeakMap<CityLayout, SteamEmitter[]>()

/** Footprints with the rendered heights, in layout order. */
export function footprintsFor(layout: CityLayout): PlanBuilding[] {
  let list = footprintCache.get(layout)
  if (!list) {
    list = layout.buildings.map((b) => ({ path: b.path, x: b.x, z: b.z, w: b.w, d: b.d, top: visHeight(b, layout) }))
    footprintCache.set(layout, list)
  }
  return list
}

export function rooftopsFor(layout: CityLayout): RooftopPlan {
  let plan = roofCache.get(layout)
  if (!plan) {
    plan = planRooftops(footprintsFor(layout))
    roofCache.set(layout, plan)
  }
  return plan
}

export function signsFor(layout: CityLayout): SignPlan {
  let plan = signCache.get(layout)
  if (!plan) {
    plan = planSigns(footprintsFor(layout))
    signCache.set(layout, plan)
  }
  return plan
}

export function steamFor(layout: CityLayout): SteamEmitter[] {
  let list = steamCache.get(layout)
  if (!list) {
    const roads = buildRoadPlan(layout).tiles
    list = planSteam(rooftopsFor(layout).vents, roads)
    steamCache.set(layout, list)
  }
  return list
}
