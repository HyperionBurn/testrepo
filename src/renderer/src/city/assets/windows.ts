// Per-window IDs for the model geometry. A window is a connected group of window triangles (the triangles whose
// UV centroid lands on a window texel of the colormap): triangles that share a vertex position belong to the same
// window. Every window gets one ID, written per vertex as `aWin` (0 for wall and other non-window triangles), so the
// shader can light each pane as a whole instead of per pixel.
import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three'

const Q = 1e4 // position quantum for vertex identity (1e-4 units)

function vkey(x: number, y: number, z: number): string {
  return `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`
}

/** Hash of a window's quantised centre, in (0.01, 1): never 0, so 0 can mean "not a window". */
export function windowId(cx: number, cy: number, cz: number): number {
  const a = Math.round(cx / 0.02)
  const b = Math.round(cy / 0.02)
  const c = Math.round(cz / 0.02)
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return ((h >>> 0) / 4294967296) * 0.98 + 0.01
}

/**
 * Adds the `aWin` attribute to a non-indexed geometry (indexed input is converted). `isWindowUV(u, v)` decides whether
 * a triangle's UV centroid is on a window. Pure: no DOM, no textures.
 */
export function tagWindows(geometry: BufferGeometry, isWindowUV: (u: number, v: number) => boolean): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  const pos = g.getAttribute('position') as BufferAttribute
  const uv = g.getAttribute('uv') as BufferAttribute | undefined
  const n = pos.count
  const nTri = Math.floor(n / 3)
  const aWin = new Float32Array(n)
  if (!uv) {
    g.setAttribute('aWin', new Float32BufferAttribute(aWin, 1))
    return g
  }

  const win = new Uint8Array(nTri)
  for (let t = 0; t < nTri; t++) {
    const cu = (uv.getX(3 * t) + uv.getX(3 * t + 1) + uv.getX(3 * t + 2)) / 3
    const cv = (uv.getY(3 * t) + uv.getY(3 * t + 1) + uv.getY(3 * t + 2)) / 3
    win[t] = isWindowUV(cu, cv) ? 1 : 0
  }

  // Union-find over window triangles, joined through shared vertex positions.
  const parent = new Int32Array(nTri)
  for (let t = 0; t < nTri; t++) parent[t] = t
  const find = (t: number): number => {
    while (parent[t] !== t) {
      parent[t] = parent[parent[t]!]!
      t = parent[t]!
    }
    return t
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const firstTri = new Map<string, number>()
  for (let t = 0; t < nTri; t++) {
    if (!win[t]) continue
    for (let k = 0; k < 3; k++) {
      const i = 3 * t + k
      const key = vkey(pos.getX(i), pos.getY(i), pos.getZ(i))
      const other = firstTri.get(key)
      if (other === undefined) firstTri.set(key, t)
      else union(t, other)
    }
  }

  // One centre per window (mean of its vertices), then one ID per window.
  const sum = new Map<number, [number, number, number, number]>()
  for (let t = 0; t < nTri; t++) {
    if (!win[t]) continue
    const r = find(t)
    const s = sum.get(r) ?? [0, 0, 0, 0]
    for (let k = 0; k < 3; k++) {
      const i = 3 * t + k
      s[0] += pos.getX(i)
      s[1] += pos.getY(i)
      s[2] += pos.getZ(i)
      s[3] += 1
    }
    sum.set(r, s)
  }
  const idOf = new Map<number, number>()
  for (const [r, s] of sum) idOf.set(r, windowId(s[0] / s[3], s[1] / s[3], s[2] / s[3]))

  for (let t = 0; t < nTri; t++) {
    if (!win[t]) continue
    const id = idOf.get(find(t)) ?? 0
    aWin[3 * t] = id
    aWin[3 * t + 1] = id
    aWin[3 * t + 2] = id
  }
  g.setAttribute('aWin', new Float32BufferAttribute(aWin, 1))
  return g
}
