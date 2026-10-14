import { describe, expect, it } from 'vitest'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { tagWindows } from './windows'

/** Non-indexed geometry from triangles (each triangle = 3 positions and 3 uvs). */
function geom(tris: { p: number[][]; uv: number[][] }[]): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(tris.flatMap((t) => t.p.flat()), 3))
  g.setAttribute('uv', new Float32BufferAttribute(tris.flatMap((t) => t.uv.flat()), 2))
  return g
}

/** A unit quad at (x0, 0, 0) as two triangles, all UVs at (uu, vv) so the classifier decides for the whole quad. */
function quad(x0: number, uu: number, vv: number, z0 = 0) {
  const a = [x0, 0, z0]
  const b = [x0 + 1, 0, z0]
  const c = [x0 + 1, 1, z0]
  const d = [x0, 1, z0]
  const uv = [uu, vv]
  return [
    { p: [a, b, c], uv: [uv, uv, uv] },
    { p: [a, c, d], uv: [uv, uv, uv] }
  ]
}

const isWin = (u: number, _v: number) => u > 0.5
const idsPerTri = (g: BufferGeometry) => {
  const a = g.getAttribute('aWin') as Float32BufferAttribute
  const out: number[] = []
  for (let t = 0; t < a.count / 3; t++) out.push(a.getX(3 * t))
  return out
}

describe('tagWindows', () => {
  it('gives two separate window quads two different ids, and walls 0', () => {
    const wall = { p: [[0, 0, 5], [1, 0, 5], [1, 1, 5]], uv: [[0.1, 0.1], [0.1, 0.1], [0.1, 0.1]] }
    const g = geom([...quad(0, 0.9, 0.5), ...quad(3, 0.9, 0.5), wall])
    const ids = idsPerTri(tagWindows(g, isWin))
    expect(ids[0]).toBeGreaterThan(0)
    expect(ids[1]).toBe(ids[0]) // both triangles of the first quad
    expect(ids[2]).toBeGreaterThan(0)
    expect(ids[3]).toBe(ids[2])
    expect(ids[2]).not.toBe(ids[0])
    expect(ids[4]).toBe(0)
  })

  it('merges triangles that share vertices, and keeps a wall triangle at a corner out of the window', () => {
    // The two triangles of one quad share the diagonal (a, c): one window, not two.
    const g = geom(quad(0, 0.9, 0.5))
    const ids = idsPerTri(tagWindows(g, isWin))
    expect(new Set(ids).size).toBe(1)
    // A wall triangle touching the window at corner (1,1,0) is not a window triangle.
    const touching = { p: [[1, 1, 0], [2, 1, 0], [2, 2, 0]], uv: [[0.1, 0.1], [0.1, 0.1], [0.1, 0.1]] }
    const g2 = geom([...quad(0, 0.9, 0.5), touching])
    const ids2 = idsPerTri(tagWindows(g2, isWin))
    expect(ids2[2]).toBe(0)
    expect(new Set(ids2.slice(0, 2)).size).toBe(1)
  })

  it('gives every triangle of a window the same id even when the window is split into more triangles', () => {
    const q = quad(0, 0.9, 0.5)
    // Split the second triangle again through a midpoint on the diagonal: still one window.
    const extra = { p: [[0, 0, 0], [0.5, 0.5, 0], [1, 1, 0]], uv: [[0.9, 0.5], [0.9, 0.5], [0.9, 0.5]] }
    const ids = idsPerTri(tagWindows(geom([q[0]!, extra]), isWin))
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBeGreaterThan(0)
  })

  it('is deterministic for the same geometry', () => {
    const a = idsPerTri(tagWindows(geom(quad(2, 0.9, 0.5)), isWin))
    const b = idsPerTri(tagWindows(geom(quad(2, 0.9, 0.5)), isWin))
    expect(a).toEqual(b)
  })
})
