import { describe, expect, it } from 'vitest'
import { buildFacadeBox } from './geometry'
import { FACADE_SETS } from './sets'

describe('buildFacadeBox', () => {
  const g = buildFacadeBox({ width: 40, depth: 30, height: 60, facade: 2, lit: 0.4, seed: 0.25, x: 10 })
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')

  it('writes the facade attributes per vertex', () => {
    const n = pos.count
    for (const name of ['aFacade', 'aFacadeUV', 'aLit', 'aSeed', 'normal', 'uv']) {
      expect(g.getAttribute(name).count, name).toBe(n)
    }
    expect(n % 3).toBe(0)
    const fac = g.getAttribute('aFacade')
    for (let i = 0; i < n; i++) expect(fac.getX(i)).toBe(2)
  })

  it('reports metres up the wall, from grade to the box height', () => {
    const uv = g.getAttribute('aFacadeUV')
    let maxV = 0
    let minV = Infinity
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(nor.getY(i)) > 0.5) continue   // roof vertices carry roof-plane metres instead
      maxV = Math.max(maxV, uv.getY(i))
      minV = Math.min(minV, uv.getY(i))
    }
    expect(minV).toBeCloseTo(0)
    expect(maxV).toBeCloseTo(60)
  })

  it('has unit normals that point out of the box', () => {
    for (let i = 0; i < pos.count; i++) {
      const len = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))
      expect(len).toBeCloseTo(1)
    }
    // Every triangle's geometric normal agrees with its vertex normal (outward winding).
    for (let t = 0; t < pos.count; t += 3) {
      const a = [pos.getX(t), pos.getY(t), pos.getZ(t)]
      const b = [pos.getX(t + 1), pos.getY(t + 1), pos.getZ(t + 1)]
      const c = [pos.getX(t + 2), pos.getY(t + 2), pos.getZ(t + 2)]
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      const dot = gn[0] * nor.getX(t) + gn[1] * nor.getY(t) + gn[2] * nor.getZ(t)
      expect(dot, `triangle ${t / 3}`).toBeGreaterThan(0)
    }
  })

  it('rejects an unknown facade set', () => {
    expect(() => buildFacadeBox({ width: 10, depth: 10, height: 10, facade: FACADE_SETS.length, lit: 0, seed: 0 })).toThrow()
  })
})
