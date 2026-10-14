// Sign placement (pure, no three.js). Picks the buildings that carry signs, the face each one shows to the street,
// and where on that face each sign sits. Deterministic: the same buildings always get the same signs.
//
// Coordinates follow the layout: footprints are min-corner rectangles on the x/z plane and `top` is the rendered
// height (visHeight), so a sign's y is world height above the ground plane.
//
// Faces: N = -z, E = +x, S = +z, W = -x (the streets.ts convention). A sign's yaw turns its local +z to the outward
// normal of its face. Blades stand out from the facade, so their plane runs along the normal and their yaw uses the
// facade tangent instead.
//
// Times Square: the tallest buildings among the nearest to the layout centroid form the hotspot. Each hotspot
// building gets a billboard and a ground-floor marquee on its street face, and a neon blade on another face.
// Elsewhere a few buildings get a blade, and the tallest of them a billboard.

export type Face = 'N' | 'E' | 'S' | 'W'
export type SignKind = 'billboard' | 'blade' | 'marquee'

/** A building as the planners see it: min-corner footprint and rendered top (visHeight), world units. */
export interface PlanBuilding { path: string; x: number; z: number; w: number; d: number; top: number }

export interface SignSpec {
  kind: SignKind;
  /** Index into the buildings the plan was made from. */
  building: number;
  path: string;
  face: Face;
  /** Centre of the sign plane, world units. y is the centre height above the ground. */
  x: number; y: number; z: number;
  /** Plane width (local x) and height (local y). Blades: w is the protrusion from the facade. */
  w: number; h: number;
  /** Rotation about +y: local +z is the front of the sign. */
  yaw: number;
  hot: boolean;
  /** Neon colour (hex). Billboards ignore it. */
  color: string;
  /** Billboards: atlas index and slot inside it. Others: -1. */
  atlas: number; slot: number;
  /** [0, 1), stable per sign. */
  seed: number;
}

export interface SignPlan {
  signs: SignSpec[];
  /** Building indices of the Times Square hotspot, tallest first. Empty when the city is too small for one. */
  hotspot: number[];
  centroid: { x: number; z: number };
}

/** Hotspot size. The brief asks for 12 to 20 buildings. */
export const HOTSPOT_SIZE = 16
export const HOTSPOT_MIN = 12
/** The hotspot is drawn from this many buildings nearest the centroid. */
export const HOTSPOT_POOL = 60
/** Billboard slots: two 1024 atlases, each cut into 2 by 4 slots of 512 by 256. */
export const ATLAS_COUNT = 2
export const SLOTS_PER_ATLAS = 8
export const BILLBOARD_MAX = ATLAS_COUNT * SLOTS_PER_ATLAS
/** Hotspot billboards come first; the rest of the slots go to sparse billboards elsewhere. */
export const HOTSPOT_BILLBOARDS = 12
/** Mounting gap between a sign and the facade it hangs on. */
export const SIGN_OFFSET = 0.06
/** Free space a sign face needs in front of it (below this the face is hidden by a neighbour). */
export const FREE_MIN = 0.4
/** How far the street-facing ray looks before it counts as open. */
export const RAY_MAX = 12
const RAY_STEP = 0.2
const GRID_CELL = 6

export const NEON_COLORS: readonly string[] = [
  '#ffb347', '#ff3b4e', '#3fd6ff', '#ff58c8', '#8dff5a', '#fff3d6', '#6f86ff', '#ffe14d'
]

const FACES: readonly Face[] = ['N', 'E', 'S', 'W']
const NORMALS: Readonly<Record<Face, { x: number; z: number }>> = {
  N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 }
}

/** FNV-1a of `key` (and a salt), mapped to [0, 1). Deterministic; the same key always gives the same value. */
export function hash01(key: string, salt = ''): number {
  let h = 0x811c9dc5
  const s = salt ? `${key}#${salt}` : key
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

/** Outward normal of a face, in the x/z plane. */
export function faceNormal(face: Face): { x: number; z: number } {
  return NORMALS[face]
}

/** Length of a face along its tangent: N and S run along x, E and W along z. */
export function faceSpan(b: PlanBuilding, face: Face): number {
  return face === 'N' || face === 'S' ? b.w : b.d
}

/** The point on a face at distance u from its start (u increases with x on N and S, with z on E and W). */
export function facePoint(b: PlanBuilding, face: Face, u: number): { x: number; z: number } {
  switch (face) {
    case 'N': return { x: b.x + u, z: b.z }
    case 'S': return { x: b.x + u, z: b.z + b.d }
    case 'E': return { x: b.x + b.w, z: b.z + u }
    case 'W': return { x: b.x, z: b.z + u }
  }
}

/** Yaw that turns local +z to the direction (nx, nz). */
export function yawFor(nx: number, nz: number): number {
  return Math.atan2(nx, nz)
}

/** The street-facing face of one building (builds its own grid, so use planSigns for many buildings). */
export function facingOf(buildings: readonly PlanBuilding[], idx: number): Face {
  return streetFace(new FootprintGrid(buildings), buildings, idx)
}

/** Uniform grid over footprints, so a free-space ray only tests buildings in the cells it crosses. */
class FootprintGrid {
  private readonly cells = new Map<number, number[]>()

  constructor(private readonly buildings: readonly PlanBuilding[]) {
    buildings.forEach((b, i) => {
      const x0 = Math.floor(b.x / GRID_CELL), x1 = Math.floor((b.x + b.w) / GRID_CELL)
      const z0 = Math.floor(b.z / GRID_CELL), z1 = Math.floor((b.z + b.d) / GRID_CELL)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz)
          const list = this.cells.get(k)
          if (list) list.push(i)
          else this.cells.set(k, [i])
        }
      }
    })
  }

  /** True when (x, z) lies inside a footprint other than `except`. */
  blocked(x: number, z: number, except: number): boolean {
    const list = this.cells.get(key(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL)))
    if (!list) return false
    for (const j of list) {
      if (j === except) continue
      const b = this.buildings[j]
      if (!b) continue
      if (x >= b.x && x <= b.x + b.w && z >= b.z && z <= b.z + b.d) return true
    }
    return false
  }
}

function key(cx: number, cz: number): number {
  return ((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff)
}

/** Average distance a ray from three points across the face travels before it meets another footprint. */
export function freeDistance(grid: FootprintGrid, buildings: readonly PlanBuilding[], idx: number, face: Face): number {
  const b = buildings[idx]
  if (!b) return 0
  const n = faceNormal(face)
  const span = faceSpan(b, face)
  let total = 0
  for (const f of [0.25, 0.5, 0.75]) {
    const p = facePoint(b, face, span * f)
    let dist = RAY_MAX
    for (let t = RAY_STEP; t <= RAY_MAX; t += RAY_STEP) {
      if (grid.blocked(p.x + n.x * t, p.z + n.z * t, idx)) {
        dist = t
        break
      }
    }
    total += dist
  }
  return total / 3
}

/** The face with the most open space in front of it: the one that faces the nearest street. Ties go to the hash. */
export function streetFace(grid: FootprintGrid, buildings: readonly PlanBuilding[], idx: number): Face {
  const b = buildings[idx]
  if (!b) return 'S'
  let best: Face = 'S'
  let bestScore = -Infinity
  for (const face of FACES) {
    const score = freeDistance(grid, buildings, idx, face) + hash01(b.path, `face-${face}`) * 0.01
    if (score > bestScore) {
      bestScore = score
      best = face
    }
  }
  return best
}

interface Rect { u0: number; u1: number; v0: number; v1: number }

/** The widest face with at least FREE_MIN of open space in front of it (the street face if none qualifies). */
function widestOpenFace(grid: FootprintGrid, buildings: readonly PlanBuilding[], idx: number): Face {
  const b = buildings[idx]!
  let best: Face = 'S'
  let bestSpan = -1
  for (const f of FACES) {
    const span = faceSpan(b, f)
    if (span > bestSpan && freeDistance(grid, buildings, idx, f) >= FREE_MIN) {
      bestSpan = span
      best = f
    }
  }
  return best
}

/** Face-local rectangles already used, per building and face. A new sign must clear all of them. */
class FaceBoard {
  private readonly used = new Map<number, Rect[]>()

  fits(slot: number, r: Rect): boolean {
    const list = this.used.get(slot)
    if (!list) return true
    for (const o of list) {
      if (r.u0 < o.u1 + 0.15 && o.u0 < r.u1 + 0.15 && r.v0 < o.v1 + 0.15 && o.v0 < r.v1 + 0.15) return false
    }
    return true
  }

  add(slot: number, r: Rect): void {
    const list = this.used.get(slot)
    if (list) list.push(r)
    else this.used.set(slot, [r])
  }
}

interface PlaceArgs {
  kind: SignKind;
  idx: number;
  b: PlanBuilding;
  face: Face;
  /** Along the face: the sign's centre (u) and its extent along the face (uw), and its bottom and height (v, h). */
  u: number; uw: number; v: number; h: number;
  /** Plane width (local x) for billboards and marquees. Blades: the protrusion. */
  w: number;
  hot: boolean;
  seed: number;
  color: string;
}

function place(board: FaceBoard, a: PlaceArgs): SignSpec | null {
  const { b } = a
  const span = faceSpan(b, a.face)
  const r: Rect = { u0: a.u - a.uw / 2, u1: a.u + a.uw / 2, v0: a.v, v1: a.v + a.h }
  if (r.u0 < 0.15 || r.u1 > span - 0.15) return null
  if (r.v0 < 0 || r.v1 > b.top - 0.25) return null
  const slot = a.idx * 4 + FACES.indexOf(a.face)
  if (!board.fits(slot, r)) return null
  board.add(slot, r)

  const p = facePoint(b, a.face, a.u)
  const n = faceNormal(a.face)
  const depth = a.kind === 'blade' ? a.w : 0.1
  const off = SIGN_OFFSET + depth / 2
  const yaw = a.kind === 'blade' ? yawFor(-n.z, n.x) : yawFor(n.x, n.z)
  return {
    kind: a.kind,
    building: a.idx,
    path: b.path,
    face: a.face,
    x: p.x + n.x * off,
    y: a.v + a.h / 2,
    z: p.z + n.z * off,
    w: a.w,
    h: a.h,
    yaw,
    hot: a.hot,
    color: a.color,
    atlas: -1,
    slot: -1,
    seed: a.seed
  }
}

/** Buildings with a top of at least this many units can carry a sign at all (most repos are low-rise). */
const MIN_SIGN_TOP = 1.8
/** A city with fewer candidate buildings than this gets no Times Square. */
const MIN_HOTSPOT = 4

/** Hotspot: the tallest of the nearest HOTSPOT_POOL buildings to the centroid. Empty when there are too few. */
export function hotspotOf(buildings: readonly PlanBuilding[], cx: number, cz: number): number[] {
  const cand: number[] = []
  buildings.forEach((b, i) => {
    if (b.top >= MIN_SIGN_TOP) cand.push(i)
  })
  const d2 = (i: number): number => {
    const b = buildings[i]!
    const dx = b.x + b.w / 2 - cx, dz = b.z + b.d / 2 - cz
    return dx * dx + dz * dz
  }
  cand.sort((a, b) => d2(a) - d2(b) || (buildings[a]!.path < buildings[b]!.path ? -1 : 1))
  const near = cand.slice(0, HOTSPOT_POOL)
  if (near.length < MIN_HOTSPOT) return []
  near.sort((a, b) => buildings[b]!.top - buildings[a]!.top || (buildings[a]!.path < buildings[b]!.path ? -1 : 1))
  return near.slice(0, HOTSPOT_SIZE)
}

function pickColor(path: string, salt: string): string {
  const i = Math.floor(hash01(path, salt) * NEON_COLORS.length)
  return NEON_COLORS[Math.min(NEON_COLORS.length - 1, i)] ?? NEON_COLORS[0]!
}

/**
 * Places every sign for the given buildings. Pure and deterministic. No two signs on one building face overlap, and
 * every sign stays inside its facade.
 */
export function planSigns(buildings: readonly PlanBuilding[]): SignPlan {
  const n = buildings.length
  let sx = 0, sz = 0
  for (const b of buildings) {
    sx += b.x + b.w / 2
    sz += b.z + b.d / 2
  }
  const centroid = n > 0 ? { x: sx / n, z: sz / n } : { x: 0, z: 0 }
  const hotspot = hotspotOf(buildings, centroid.x, centroid.z)
  const hotSet = new Set(hotspot)
  const grid = new FootprintGrid(buildings)
  const board = new FaceBoard()
  const signs: SignSpec[] = []
  let billboards = 0

  const push = (s: SignSpec | null): void => {
    if (!s) return
    if (s.kind === 'billboard') {
      s.atlas = Math.floor(billboards / SLOTS_PER_ATLAS)
      s.slot = billboards % SLOTS_PER_ATLAS
      billboards++
    }
    signs.push(s)
  }

  const billboardSize = (span: number): number => Math.min(6, Math.max(1.6, span * 0.78))

  // Hotspot first: billboard and marquee on the street face, a neon blade on the most open other face.
  for (const idx of hotspot) {
    const b = buildings[idx]!
    const face = streetFace(grid, buildings, idx)
    const span = faceSpan(b, face)
    const seed = hash01(b.path, 'hot')
    if (billboards < HOTSPOT_BILLBOARDS) {
      // The street face when it is wide enough, else the widest open face: a billboard needs a facade, not a street.
      const bbFace = span >= 2.2 ? face : widestOpenFace(grid, buildings, idx)
      const bbSpan = faceSpan(b, bbFace)
      const w = billboardSize(bbSpan)
      const h = Math.min(3, Math.max(0.8, w * 0.5), b.top - 2.8)
      if (bbSpan >= 2.2 && h >= 0.8) {
        const v = Math.max(2.2, Math.min(b.top * 0.45, b.top - h - 0.6))
        push(place(board, {
          kind: 'billboard', idx, b, face: bbFace, u: bbSpan / 2, uw: w, v, h, w, hot: true, seed, color: '#ffffff'
        }))
      }
    }
    if (b.top >= 2.6 && span >= 1.2) {
      push(place(board, {
        kind: 'marquee', idx, b, face, u: span / 2, uw: Math.min(7, Math.max(1, span * 0.86)), v: 0.95, h: 0.5,
        w: Math.min(7, Math.max(1, span * 0.86)), hot: true, seed, color: pickColor(b.path, 'marquee')
      }))
    }
    if (b.top >= 3.6) {
      let other: Face = face
      let best = -Infinity
      for (const f of FACES) {
        if (f === face) continue
        const score = freeDistance(grid, buildings, idx, f)
        if (score > best) {
          best = score
          other = f
        }
      }
      const h = Math.min(2.6, b.top - 1.8)
      if (best >= FREE_MIN && h >= 0.8) {
        push(place(board, {
          kind: 'blade', idx, b, face: other, u: faceSpan(b, other) * (seed < 0.5 ? 0.25 : 0.75), uw: 0.6,
          v: 1, h, w: 0.9, hot: true, seed, color: pickColor(b.path, 'blade-hot')
        }))
      }
    }
  }

  // Elsewhere: a few neon blades on the street face, and a few billboards on the tallest of the rest.
  buildings.forEach((b, idx) => {
    if (hotSet.has(idx)) return
    const p = hash01(b.path, 'sparse')
    const span = Math.max(b.w, b.d)
    if (b.top >= 8 && p < 0.02 && billboards < BILLBOARD_MAX) {
      const face = streetFace(grid, buildings, idx)
      const fspan = faceSpan(b, face)
      if (fspan >= 2) {
        const w = Math.min(4.5, Math.max(1.4, fspan * 0.7))
        const h = w * 0.5
        push(place(board, {
          kind: 'billboard', idx, b, face, u: fspan / 2, uw: w, v: Math.min(b.top * 0.5, b.top - h - 0.6), h, w,
          hot: false, seed: hash01(b.path, 'sparse-bb'), color: '#ffffff'
        }))
      }
    } else if (b.top >= 3.6 && span >= 1.4 && p < 0.05) {
      const face = streetFace(grid, buildings, idx)
      const h = Math.min(2.4, b.top - 1.8)
      if (h >= 0.8) {
        push(place(board, {
          kind: 'blade', idx, b, face, u: faceSpan(b, face) * 0.5, uw: 0.6, v: 1, h, w: 0.9,
          hot: false, seed: hash01(b.path, 'sparse-blade'), color: pickColor(b.path, 'blade')
        }))
      }
    }
  })

  return { signs, hotspot, centroid }
}
