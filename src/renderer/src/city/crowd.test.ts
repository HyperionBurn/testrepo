import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../shared/layout'
import type { FileNode, RepoSnapshot } from '../../../shared/types'
import { isSignalNode, buildLanes, mulberry32 } from './lanes'
import { PED_FAR, PED_MAX, planPedestrians } from './Pedestrians'
import { pickKind, KIND_TAXI, paintFor } from './vehicleKinds'

function snapshot(): RepoSnapshot {
  const dirs = ['src/main', 'src/renderer/hud', 'src/renderer/city', 'src/shared', 'packages/core/src', 'docs', 'src/x/y', 'lib/z', 'lib/q']
  const files: FileNode[] = []
  let k = 0
  for (const d of dirs) {
    for (let i = 0; i < 60; i++, k++) {
      files.push({ path: `${d}/f${i}.ts`, lang: 'ts', loc: 20 + ((k * 37) % 400), bytes: 1, mtime: 0, imports: [] })
    }
  }
  return { root: '/x', name: 'x', files, scannedAt: 0 }
}

describe('pedestrians', () => {
  const layout = buildLayout(snapshot())
  const net = buildLanes(layout)

  it('never exceeds the crowd cap, and draws nothing beyond 120 units', () => {
    const p = planPedestrians(layout, net, mulberry32(1), 100_000)
    expect(p.walkers + p.crossers).toBeLessThanOrEqual(PED_MAX)
    expect(PED_FAR).toBe(120)
  })

  it('is deterministic for a seed', () => {
    const a = planPedestrians(layout, net, mulberry32(9))
    const b = planPedestrians(layout, net, mulberry32(9))
    expect(a.walkers).toBe(b.walkers)
    expect(Array.from(a.wSeg)).toEqual(Array.from(b.wSeg))
    expect(Array.from(a.cNode)).toEqual(Array.from(b.cNode))
  })

  it('crowds the middle of the city: more walkers per unit of street near the hotspot', () => {
    const p = planPedestrians(layout, net, mulberry32(4))
    const c = p.centre
    const half = layout.size / 4
    let inner = 0
    let outer = 0
    let innerLen = 0
    let outerLen = 0
    for (const s of net.segments) {
      const mx = (net.nodes[s.a]!.x + net.nodes[s.b]!.x) / 2
      const mz = (net.nodes[s.a]!.z + net.nodes[s.b]!.z) / 2
      const near = Math.hypot(mx - c.x, mz - c.z) < half
      if (near) innerLen += s.length
      else outerLen += s.length
    }
    for (let i = 0; i < p.walkers; i++) {
      const s = net.segments[p.wSeg[i]!]!
      const mx = (net.nodes[s.a]!.x + net.nodes[s.b]!.x) / 2
      const mz = (net.nodes[s.a]!.z + net.nodes[s.b]!.z) / 2
      if (Math.hypot(mx - c.x, mz - c.z) < half) inner++
      else outer++
    }
    expect(inner / Math.max(1e-6, innerLen)).toBeGreaterThan(outer / Math.max(1e-6, outerLen))
  })

  it('places crossers only at signalled junctions', () => {
    const p = planPedestrians(layout, net, mulberry32(2))
    for (let c = 0; c < p.crossers; c++) expect(isSignalNode(net, p.cNode[c]!)).toBe(true)
  })
})

describe('vehicle kinds', () => {
  it('makes about a third of the vehicles yellow cabs, and paints them yellow', () => {
    const rng = mulberry32(21)
    let taxis = 0
    const n = 4000
    for (let i = 0; i < n; i++) {
      const kind = pickKind(rng())
      if (kind === KIND_TAXI) {
        taxis++
        const [r, g, b] = paintFor(kind, rng())
        expect(r).toBeGreaterThan(0.9)
        expect(g).toBeGreaterThan(0.6)
        expect(b).toBeLessThan(0.2)
      }
    }
    const share = taxis / n
    expect(share).toBeGreaterThan(0.3)
    expect(share).toBeLessThan(0.4)
  })
})
