import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../shared/layout'
import type { CityLayout, FileNode, RepoSnapshot } from '../../../shared/types'
import { buildLanes, componentOf, createVehicles, lanePoint, mulberry32, nearestNode, routeTo, stepVehicle } from './lanes'

// Two top-level plates a street (2.4) apart, and a nested plate inside the first.
const layout: CityLayout = {
  size: 120,
  buildings: [],
  districts: [
    { name: 'a', x: -50, z: -50, w: 20, d: 100, depth: 1 },
    { name: 'b', x: -27.6, z: -50, w: 20, d: 100, depth: 1 },
    { name: 'a/inner', x: -45, z: -45, w: 10, d: 10, depth: 2 }
  ]
}

function snapshot(): RepoSnapshot {
  const dirs = ['src/main', 'src/renderer/hud', 'src/renderer/city', 'src/shared', 'packages/core/src', 'docs']
  const files: FileNode[] = []
  let k = 0
  for (const d of dirs) {
    for (let i = 0; i < 25; i++, k++) {
      files.push({ path: `${d}/f${i}.ts`, lang: 'ts', loc: 20 + ((k * 37) % 400), bytes: 1, mtime: 0, imports: [] })
    }
  }
  files.push({ path: 'README.md', lang: 'md', loc: 30, bytes: 1, mtime: 0, imports: [] })
  return { root: '/x', name: 'x', files, scannedAt: 0 }
}

describe('buildLanes', () => {
  it('dedupes the shared street between neighbouring plates into one segment', () => {
    const net = buildLanes(layout)
    // Plate a's right lane and plate b's left lane are both at x = -28.8: one segment, not two.
    // Centre lines snap to the quarter-unit grid: -28.8 becomes -28.75.
    const onStreet = net.segments.filter((s) => !s.horizontal && net.nodes[s.a]!.x === -28.75)
    expect(onStreet).toHaveLength(1)
    expect(onStreet[0]!.length).toBeCloseTo(102.5, 6)
  })

  it('puts street centre lines 1.2 outside top-level plates and 0.6 outside nested ones', () => {
    const net = buildLanes(layout)
    const xs = new Set(net.nodes.map((n) => n.x))
    expect(xs.has(-51.25)).toBe(true) // a's outer west street (-51.2 snapped)
    expect(xs.has(-28.75)).toBe(true) // between a and b (-28.8 snapped)
    expect(xs.has(-45.5)).toBe(true) // nested plate's west street (-45.6 snapped)
    expect(xs.has(-50)).toBe(false) // no street sits on a plate edge itself
  })

  it('connects every segment to at least one node, on both ends', () => {
    const net = buildLanes(layout)
    expect(net.segments.length).toBeGreaterThan(0)
    for (const s of net.segments) {
      expect(net.nodes[s.a]!.segments).toContain(s.id)
      expect(net.nodes[s.b]!.segments).toContain(s.id)
    }
  })

  it('builds a real layout without degenerate segments', () => {
    const net = buildLanes(buildLayout(snapshot()))
    expect(net.segments.length).toBeGreaterThan(10)
    for (const s of net.segments) expect(s.length).toBeGreaterThan(0)
    for (const n of net.nodes) expect(n.segments.length).toBeGreaterThan(0)
  })
})

describe('stepVehicle', () => {
  it('keeps every vehicle on the network over 10 000 steps', () => {
    const net = buildLanes(buildLayout(snapshot()))
    const rng = mulberry32(42)
    const v = createVehicles(120, net, rng)
    let bad = 0
    let moved = new Set<number>()
    for (let step = 0; step < 10_000; step++) {
      stepVehicle(v, 1 / 30, net, rng)
      for (let i = 0; i < v.count; i++) {
        const s = net.segments[v.seg[i]!]
        moved.add(v.seg[i]!)
        if (!s || (v.dir[i] !== 1 && v.dir[i] !== -1)) bad++
        else if (!(v.t[i]! >= 0 && v.t[i]! <= s.length + 1e-4) || !Number.isFinite(v.speed[i]!)) bad++
      }
    }
    expect(bad).toBe(0)
    expect(moved.size).toBeGreaterThan(net.segments.length / 2) // vehicles really travel, not just sit

  })

  it('is deterministic for a seed', () => {
    const net = buildLanes(buildLayout(snapshot()))
    const run = () => {
      const rng = mulberry32(7)
      const v = createVehicles(60, net, rng)
      for (let step = 0; step < 2000; step++) stepVehicle(v, 1 / 30, net, rng)
      return v
    }
    const a = run()
    const b = run()
    expect(Array.from(a.seg)).toEqual(Array.from(b.seg))
    expect(Array.from(a.t)).toEqual(Array.from(b.t))
    expect(Array.from(a.dir)).toEqual(Array.from(b.dir))
  })

  it('slows vehicles on dragged segments', () => {
    const net = buildLanes(layout)
    const rng = mulberry32(3)
    const free = createVehicles(1, net, rng)
    const jam = createVehicles(1, net, mulberry32(3))
    const drag = new Float32Array(net.segments.length).fill(0.2)
    for (let i = 0; i < 120; i++) {
      stepVehicle(free, 1 / 30, net, rng)
      stepVehicle(jam, 1 / 30, net, rng, drag)
    }
    expect(jam.speed[0]!).toBeLessThan(free.speed[0]! * 0.5)
  })
})

describe('routeTo', () => {
  it('leads every node of the goal component to the goal', () => {
    const net = buildLanes(buildLayout(snapshot()))
    const goal = nearestNode(net, 0, 0)
    const comp = componentOf(net)
    const table = routeTo(net, goal)
    let failures = 0
    for (let start = 0; start < net.nodes.length; start++) {
      if (comp[start] !== comp[goal]) continue
      let node = start
      for (let hop = 0; hop < net.nodes.length && node !== goal; hop++) {
        const sid = table[node]!
        if (sid < 0) break
        const seg = net.segments[sid]!
        node = seg.a === node ? seg.b : seg.a
      }
      if (node !== goal) failures++
    }
    expect(failures).toBe(0)
  })

  it('finds components, with the top-level streets joined into one', () => {
    const net = buildLanes(layout)
    const comp = componentOf(net)
    // Plates a and b share their street, so their outer loops are one component.
    expect(new Set(comp).size).toBeGreaterThanOrEqual(1)
    const outer = net.nodes.find((n) => n.x === -51.25 && n.z === -51.25)!
    const other = net.nodes.find((n) => n.x === -28.75 && n.z === -51.25)!
    expect(comp[outer.id]).toBe(comp[other.id])
  })

  it('places a point on the lane offset to one side of the centre line', () => {
    const net = buildLanes(layout)
    const out = new Float32Array(3)
    const s = net.segments.find((x) => x.horizontal)!
    const az = net.nodes[s.a]!.z
    lanePoint(net, s.id, 1, 0, out, 0, 0.2)
    const zPlus = out[2]!
    lanePoint(net, s.id, -1, 0, out, 0, 0.2)
    const zMinus = out[2]!
    // Opposite directions ride opposite sides of the centre line, 0.25 away from it.
    expect(Math.abs(zPlus - az)).toBeCloseTo(0.25, 6)
    expect(Math.abs(zMinus - az)).toBeCloseTo(0.25, 6)
    expect(zPlus).not.toBeCloseTo(zMinus, 6)
    expect(out[1]).toBeCloseTo(0.2, 6)
  })
})
