// City layout: squarified treemap (Bruls, Huijbregts, van Wijk 2000) over the directory tree.
// Pure and deterministic: the same snapshot always yields the same layout.
//
// Coordinates: x/z are the MINIMUM corner of a building or district footprint, in world units
// on the ground plane (y is up). The city is a CITY_SIZE square centered on the origin.
// Use buildingCenter() for the footprint center.
import type { CityBuilding, CityDistrict, CityLayout, FileNode, RepoSnapshot } from './types'
import { LANG_COLORS } from './lang'

/** Side length of the whole city square, in world units. */
export const CITY_SIZE = 120

const HALF = CITY_SIZE / 2
const MIN_WEIGHT = 8             // weight = max(loc, MIN_WEIGHT)
const STREET_TOP = 2.4           // street width between sibling top-level districts (depth 1)
const STREET = 1.2               // street width between sibling districts nested deeper (depth 2+)
const BUILDING_INSET = 0.15      // building inset per side, as a fraction of its cell
const MIN_FOOTPRINT = 0.4        // smallest building footprint, where the cell allows it
const MIN_CELL_AREA = 0.36       // floor on a file's treemap area, so tiny files can still hold a MIN_FOOTPRINT building
const EPS = 1e-9

/** Axis-aligned rectangle on the ground plane. x/z is the minimum corner. */
export interface Rect { x: number; z: number; w: number; d: number }

interface FileChild {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly file: FileNode;
  area: number;
}

interface DirChild {
  readonly kind: 'dir';
  readonly name: string;
  readonly node: DirNode;
  area: number;
}

type Child = FileChild | DirChild

interface DirNode {
  readonly name: string;
  readonly path: string;   // repo-relative, '' for the root
  readonly depth: number;  // 0 for the root
  readonly children: Map<string, Child>;
}

// ---------------------------------------------------------------------------------------------
// Path helpers

// Matches anything that normalizePath would change: backslashes, empty or '.' segments.
const NEEDS_NORMALIZING = /\\|(^|\/)\.?(\/|$)|\/\//

/** Normalizes to repo-relative forward-slash form: no leading './' or '/', no empty segments. */
function normalizePath(p: string): string {
  if (!NEEDS_NORMALIZING.test(p)) return p // fast path: the common case, no allocation
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/')
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------------------------
// Tree

interface Tree {
  root: DirNode;
  leaves: FileChild[];
}

function buildTree(files: readonly FileNode[]): Tree {
  const root: DirNode = { name: '', path: '', depth: 0, children: new Map() }
  const leaves: FileChild[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const path = normalizePath(file.path)
    if (path === '' || seen.has(path)) continue // every file gets exactly one building
    seen.add(path)

    const parts = path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? ''
      // Directories are keyed with a trailing slash so a file and a directory of the same name can coexist.
      const key = `${seg}/`
      let child = cur.children.get(key)
      if (child?.kind !== 'dir') {
        const childPath = cur.path === '' ? seg : `${cur.path}/${seg}`
        child = {
          kind: 'dir',
          name: seg,
          node: { name: seg, path: childPath, depth: cur.depth + 1, children: new Map() },
          area: 0
        }
        cur.children.set(key, child)
      }
      cur = child.node
    }

    const leafName = parts[parts.length - 1] ?? path
    const leaf: FileChild = { kind: 'file', name: leafName, path, file, area: 0 }
    cur.children.set(leafName, leaf)
    leaves.push(leaf)
  }
  return { root, leaves }
}

function leafWeight(file: FileNode): number {
  const loc = Number.isFinite(file.loc) && file.loc > 0 ? file.loc : 0
  return Math.max(loc, MIN_WEIGHT)
}

/**
 * Leaf areas are proportional to max(loc, MIN_WEIGHT), but each file is floored at MIN_CELL_AREA
 * so buildings stay legible in huge repos. The scale k is found by bisection so the areas sum to the city.
 */
function assignLeafAreas(leaves: readonly FileChild[]): void {
  const n = leaves.length
  if (n === 0) return
  const total = CITY_SIZE * CITY_SIZE
  const floor = Math.min(MIN_CELL_AREA, (0.5 * total) / n)

  const weights = Float64Array.from(leaves, (l) => leafWeight(l.file))
  let weightSum = 0
  for (let i = 0; i < n; i++) weightSum += weights[i] ?? 0

  const sumAt = (k: number): number => {
    let s = 0
    for (let i = 0; i < n; i++) s += Math.max(floor, (weights[i] ?? 0) * k)
    return s
  }

  // sumAt is non-decreasing in k; sumAt(total / weightSum) >= total always holds.
  let lo = 0
  let hi = total / weightSum
  for (let iter = 0; iter < 50; iter++) {
    const mid = (lo + hi) / 2
    if (sumAt(mid) < total) lo = mid
    else hi = mid
  }
  leaves.forEach((leaf, i) => {
    leaf.area = Math.max(floor, (weights[i] ?? 0) * hi)
  })
}

/** Bottom-up: each directory's area is the sum of its children's areas. */
function sumDirAreas(node: DirNode): void {
  for (const child of node.children.values()) {
    if (child.kind === 'dir') {
      sumDirAreas(child.node)
      child.area = sumChildAreas(child.node)
    }
  }
}

/** Canonical name order (directories before files on a tie). Used for float-stable sums and tie-breaks. */
function byName(a: Child, b: Child): number {
  return compareStrings(a.name, b.name) || (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
}

function sumChildAreas(node: DirNode): number {
  // Summed in canonical order so the result does not depend on the order files were inserted.
  let s = 0
  for (const child of [...node.children.values()].sort(byName)) s += child.area
  return s
}

/** Children largest first (by area), ties broken by name, so the biggest districts get the best cells. */
function sortedChildren(node: DirNode): Child[] {
  return [...node.children.values()].sort((a, b) => b.area - a.area || byName(a, b))
}

// ---------------------------------------------------------------------------------------------
// Squarified treemap

function worstRatio(sum: number, min: number, max: number, side: number): number {
  const w2 = side * side
  const s2 = sum * sum
  return Math.max((w2 * max) / s2, s2 / (w2 * min))
}

/**
 * Lays out `values` (all > 0) as an exact partition of `rect`, in the given order.
 * Returns one rect per value, in the same order.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const n = values.length
  const out: Rect[] = []
  if (n === 0) return out

  let total = 0
  for (const v of values) total += v
  const scale = total > 0 ? (rect.w * rect.d) / total : 0
  const areas = values.map((v) => Math.max(v * scale, EPS * EPS))

  let cur: Rect = { x: rect.x, z: rect.z, w: Math.max(rect.w, EPS), d: Math.max(rect.d, EPS) }
  let start = 0
  while (start < n) {
    const side = Math.min(cur.w, cur.d)
    let end = start
    let sum = 0
    let min = Infinity
    let max = 0
    let worst = Infinity
    while (end < n) {
      const a = areas[end] ?? 0
      const nSum = sum + a
      const nMin = Math.min(min, a)
      const nMax = Math.max(max, a)
      const nWorst = worstRatio(nSum, nMin, nMax, side)
      if (end > start && nWorst > worst) break
      sum = nSum
      min = nMin
      max = nMax
      worst = nWorst
      end++
    }
    cur = layoutRow(areas, start, end, sum, cur, out)
    start = end
  }
  return out
}

/** Places areas[start..end) as a strip along the short side of `rect` and returns the remaining rect. */
function layoutRow(
  areas: readonly number[],
  start: number,
  end: number,
  sum: number,
  rect: Rect,
  out: Rect[]
): Rect {
  if (rect.w >= rect.d) {
    // Wider than tall: a full-height column on the left.
    const colW = Math.max(EPS, Math.min(rect.w, sum / Math.max(rect.d, EPS)))
    let z = rect.z
    for (let i = start; i < end; i++) {
      const h = (areas[i] ?? 0) / colW
      out.push({ x: rect.x, z, w: colW, d: h })
      z += h
    }
    return { x: rect.x + colW, z: rect.z, w: Math.max(0, rect.w - colW), d: rect.d }
  }
  // Taller than wide: a full-width row along the top.
  const rowD = Math.max(EPS, Math.min(rect.d, sum / Math.max(rect.w, EPS)))
  let x = rect.x
  for (let i = start; i < end; i++) {
    const w = (areas[i] ?? 0) / rowD
    out.push({ x, z: rect.z, w, d: rowD })
    x += w
  }
  return { x: rect.x, z: rect.z + rowD, w: rect.w, d: Math.max(0, rect.d - rowD) }
}

/**
 * Shrinks a rect by `margin` on every side, clamped to 20% of its smaller side so the result
 * is always strictly positive in both dimensions.
 */
function inset(rect: Rect, margin: number): Rect {
  const m = Math.min(margin, 0.2 * Math.min(rect.w, rect.d))
  return { x: rect.x + m, z: rect.z + m, w: rect.w - 2 * m, d: rect.d - 2 * m }
}

// ---------------------------------------------------------------------------------------------
// Buildings and districts

function buildingHeight(loc: number): number {
  const l = Number.isFinite(loc) && loc > 0 ? loc : 0
  return 0.6 + 2.2 * Math.log2(1 + l / 20)
}

/** Per side: half the street between siblings at this depth, so sibling plates are a full street apart. */
function plateInset(depth: number): number {
  return (depth === 1 ? STREET_TOP : STREET) / 2
}

function buildingFor(leaf: FileChild, cell: Rect, district: string): CityBuilding {
  const f = leaf.file
  const w = Math.min(cell.w, Math.max(MIN_FOOTPRINT, cell.w * (1 - 2 * BUILDING_INSET)))
  const d = Math.min(cell.d, Math.max(MIN_FOOTPRINT, cell.d * (1 - 2 * BUILDING_INSET)))
  const lang = f.lang
  return {
    path: leaf.path,
    x: cell.x + (cell.w - w) / 2,
    z: cell.z + (cell.d - d) / 2,
    w,
    d,
    h: buildingHeight(f.loc),
    lang,
    color: LANG_COLORS[lang],
    district
  }
}

interface Output {
  buildings: CityBuilding[];
  districts: CityDistrict[];
}

function layoutChildren(node: DirNode, rect: Rect, out: Output, district: string): void {
  const kids = sortedChildren(node)
  if (kids.length === 0) return
  const cells = squarify(kids.map((k) => k.area), rect)

  kids.forEach((kid, i) => {
    const cell = cells[i]
    if (!cell) return
    if (kid.kind === 'file') {
      out.buildings.push(buildingFor(kid, cell, district))
      return
    }
    // Directories: the plate is the cell minus half a street on each side, so sibling plates are a
    // street apart (2.4 for top-level districts, 1.2 for nested ones).
    const plate = inset(cell, plateInset(kid.node.depth))
    // Top-level directories name their own district; nested ones inherit it.
    const topName = node.depth === 0 ? kid.name : district
    out.districts.push({
      name: kid.node.path,
      x: plate.x,
      z: plate.z,
      w: plate.w,
      d: plate.d,
      depth: kid.node.depth
    })
    layoutChildren(kid.node, plate, out, topName)
  })
}

/**
 * Lays out a repo snapshot as a city: one building per file, one district plate per directory.
 * Sibling districts are separated by 2.4 unit streets at the top level and 1.2 unit streets deeper,
 * and the whole city fits in a CITY_SIZE square centered on the origin. Children are squarified largest first (area descending,
 * ties by name). The result depends only on the set of files, not on their input order.
 */
export function buildLayout(snapshot: RepoSnapshot): CityLayout {
  const { root, leaves } = buildTree(snapshot.files)
  leaves.sort((a, b) => compareStrings(a.path, b.path)) // canonical order for float-stable sums
  assignLeafAreas(leaves)
  sumDirAreas(root)

  const out: Output = { buildings: [], districts: [] }
  layoutChildren(root, { x: -HALF, z: -HALF, w: CITY_SIZE, d: CITY_SIZE }, out, '')
  return { buildings: out.buildings, districts: out.districts, size: CITY_SIZE }
}

// ---------------------------------------------------------------------------------------------
// Queries

const indexCache = new WeakMap<CityLayout, Map<string, CityBuilding>>()

/** Building for a repo-relative file path, or undefined. The index is cached per layout object. */
export function findBuilding(layout: CityLayout, path: string): CityBuilding | undefined {
  let index = indexCache.get(layout)
  if (!index) {
    index = new Map()
    for (const b of layout.buildings) index.set(b.path, b)
    indexCache.set(layout, index)
  }
  return index.get(normalizePath(path))
}

/** Footprint center on the ground plane, plus the vertical midpoint (y) for a box standing on y=0. */
export function buildingCenter(b: CityBuilding): { x: number; y: number; z: number } {
  return { x: b.x + b.w / 2, y: b.h / 2, z: b.z + b.d / 2 }
}

/** Bounds of the city square. Every building and district lies inside it. O(1). */
export function layoutBounds(layout: CityLayout): { minX: number; maxX: number; minZ: number; maxZ: number; size: number } {
  const h = layout.size / 2
  return { minX: -h, maxX: h, minZ: -h, maxZ: h, size: layout.size }
}

// ---------------------------------------------------------------------------------------------
// Neighborhoods: the groups a city is colored and labeled by. A neighborhood is a directory,
// usually one or two levels below the root, so a repo that keeps everything under src/ still
// reads as several areas (src/main, src/renderer, ...) rather than one.

/** Most directory levels the neighborhood search descends through. */
export const NEIGHBORHOOD_LEVELS = 3
/** A directory holding more than this share of all files is split one level further. */
export const NEIGHBORHOOD_SHARE = 0.7

export interface Neighborhood {
  /** Repo-relative directory, or '' for files at the repo root. */
  key: string;
  count: number;
}

export interface NeighborhoodIndex {
  /** Directories the search descended through, outermost first. Empty when top-level directories split the repo. */
  chain: string[];
  /** Neighborhood key for each (normalized) file path. */
  keyOf: Map<string, string>;
  /** Largest first, ties by key. */
  groups: Neighborhood[];
}

/** Neighborhood key of one file, given the descent chain. Files directly in the deepest chain directory key to that directory. */
export function neighborhoodOf(path: string, chain: readonly string[]): string {
  const p = normalizePath(path)
  let base = ''
  for (const dir of chain) {
    if (!p.startsWith(`${dir}/`)) break
    base = dir
  }
  const rest = p.slice(base === '' ? 0 : base.length + 1).split('/')
  if (rest.length < 2) return base
  return base === '' ? (rest[0] ?? '') : `${base}/${rest[0] ?? ''}`
}

function distinctNeighborhoods(paths: readonly string[], chain: readonly string[]): number {
  const keys = new Set<string>()
  for (const p of paths) keys.add(neighborhoodOf(p, chain))
  return keys.size
}

/**
 * The directory chain that defines the neighborhoods. Starting at the root, the search descends into a
 * directory while one of its subdirectories holds more than NEIGHBORHOOD_SHARE of all files, for at most
 * NEIGHBORHOOD_LEVELS directories. A descent is kept only if it actually splits the files into at least two
 * neighborhoods (trailing levels that do not are dropped).
 */
export function neighborhoodChain(paths: readonly string[]): string[] {
  const files = [...new Set(paths.map(normalizePath))].filter((p) => p !== '')
  const total = files.length
  const chain: string[] = []
  if (total === 0) return chain

  while (chain.length < NEIGHBORHOOD_LEVELS) {
    const base = chain[chain.length - 1] ?? ''
    const prefix = base === '' ? '' : `${base}/`
    const counts = new Map<string, number>()
    for (const p of files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length).split('/')
      if (rest.length < 2) continue // directly in base: not part of a subdirectory
      const child = `${prefix}${rest[0] ?? ''}`
      counts.set(child, (counts.get(child) ?? 0) + 1)
    }
    let best = ''
    let bestN = 0
    for (const [dir, n] of counts) {
      if (n > bestN || (n === bestN && dir < best)) {
        best = dir
        bestN = n
      }
    }
    if (bestN === 0 || bestN <= NEIGHBORHOOD_SHARE * total) break
    chain.push(best)
  }

  while (chain.length > 0 && distinctNeighborhoods(files, chain) < 2) chain.pop()
  return chain
}

/** Neighborhoods for a set of file paths: the chain, each file's key, and the groups by size. */
export function neighborhoodIndex(paths: readonly string[]): NeighborhoodIndex {
  const files = [...new Set(paths.map(normalizePath))].filter((p) => p !== '')
  const chain = neighborhoodChain(files)
  const keyOf = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const p of files) {
    const key = neighborhoodOf(p, chain)
    keyOf.set(p, key)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const groups = [...counts].map(([key, count]) => ({ key, count }))
  groups.sort((a, b) => b.count - a.count || compareStrings(a.key, b.key))
  return { chain, keyOf, groups }
}
