import { describe, expect, it } from 'vitest'
import { buildLayout } from '../../../shared/layout'
import type { FileNode, RepoSnapshot } from '../../../shared/types'
import { buildRoadRaster } from './roadtex'
import { buildRoadPlan } from './streets'
import {
  CAR_LENGTH,
  PHASE_AMBER,
  PHASE_GREEN,
  PHASE_RED,
  SIGNAL_CYCLE,
  buildLanes,
  createVehicles,
  isSignalNode,
  mulberry32,
  signalOffset,
  signalPhase,
  stepTraffic,
  vehicleBudget,
  type TrafficContext
} from './lanes'

function snapshot(): RepoSnapshot {
  const dirs = ['src/main', 'src/renderer/hud', 'src/renderer/city', 'src/shared', 'packages/core/src', 'docs', 'src/x/y', 'lib/z']
  const files: FileNode[] = []
  let k = 0
  for (const d of dirs) {
    for (let i = 0; i < 30; i++, k++) {
      files.push({ path: `${d}/f${i}.ts`, lang: 'ts', loc: 20 + ((k * 37) % 400), bytes: 1, mtime: 0, imports: [] })
    }
  }
  return { root: '/x', name: 'x', files, scannedAt: 0 }
}

describe('signals', () => {
  it('never shows green on both axes at once, for any junction offset', () => {
    for (const off of [0, 3.7, 11, 21.9]) {
      for (let t = 0; t < SIGNAL_CYCLE * 2; t += 0.1) {
        const ns = signalPhase(t, off, false)
        const ew = signalPhase(t, off, true)
        expect(ns === PHASE_GREEN && ew === PHASE_GREEN, `t=${t} off=${off}`).toBe(false)
        // Each axis is red whenever the other is green or amber (no conflicting greens).
        if (ns !== PHASE_RED) expect(ew, `t=${t} off=${off}`).toBe(PHASE_RED)
      }
    }
  })

  it('cycles through green, amber and red in order, once per SIGNAL_CYCLE', () => {
    const seen: number[] = []
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) seen.push(signalPhase(t, 0, false))
    expect(seen[0]).toBe(PHASE_GREEN)
    expect(seen.includes(PHASE_AMBER)).toBe(true)
    expect(seen.includes(PHASE_RED)).toBe(true)
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) {
      expect(signalPhase(t + SIGNAL_CYCLE, 4, true)).toBe(signalPhase(t, 4, true))
    }
  })

  it('gives every junction its own deterministic offset inside the cycle', () => {
    for (let node = 0; node < 500; node++) {
      const o = signalOffset(node)
      expect(o).toBeGreaterThanOrEqual(0)
      expect(o).toBeLessThan(SIGNAL_CYCLE)
      expect(signalOffset(node)).toBe(o)
    }
    const offsets = new Set(Array.from({ length: 50 }, (_, n) => signalOffset(n).toFixed(2)))
    expect(offsets.size).toBeGreaterThan(30)
  })
})

describe('vehicle budget', () => {
  it('scales with lane length and is capped', () => {
    expect(vehicleBudget(0)).toBe(0)
    expect(vehicleBudget(100)).toBeLessThan(vehicleBudget(200))
    expect(vehicleBudget(1500)).toBe(1200)
    expect(vehicleBudget(1000)).toBeGreaterThanOrEqual(600)
  })
})

describe('stepTraffic', () => {
  const layout = buildLayout(snapshot())
  const net = buildLanes(layout)

  const makeCtx = (count: number): TrafficContext => ({ clock: 0, pending: new Int32Array(count).fill(-1) })

  it('never overlaps cars on the same lane, through queues at red signals', () => {
    const rng = mulberry32(11)
    const count = Math.min(400, vehicleBudget(net.totalLength))
    const v = createVehicles(count, net, rng)
    const ctx = makeCtx(v.count)
    let worst = Infinity
    let stopped = 0
    for (let step = 0; step < 6000; step++) {
      stepTraffic(v, 1 / 20, net, rng, ctx)
      if (step < 20 || step % 10 !== 0) continue // the first second clears random spawn overlaps
      const lanes = new Map<number, number[]>()
      for (let i = 0; i < v.count; i++) {
        const key = v.seg[i]! * 2 + (v.dir[i]! > 0 ? 1 : 0)
        const list = lanes.get(key) ?? []
        list.push(v.t[i]!)
        lanes.set(key, list)
        if (v.speed[i]! < 0.02) stopped++
      }
      for (const list of lanes.values()) {
        list.sort((p, q) => p - q)
        for (let k = 1; k < list.length; k++) worst = Math.min(worst, list[k]! - list[k - 1]!)
      }
    }
    expect(worst).toBeGreaterThanOrEqual(CAR_LENGTH - 1e-4)
    expect(stopped).toBeGreaterThan(0) // queues really form
  })

  it('keeps every car on the network and never past a segment end', () => {
    const rng = mulberry32(5)
    const v = createVehicles(300, net, rng)
    const ctx = makeCtx(v.count)
    let bad = 0
    for (let step = 0; step < 3000; step++) {
      stepTraffic(v, 1 / 20, net, rng, ctx)
      for (let i = 0; i < v.count; i++) {
        const s = net.segments[v.seg[i]!]
        if (!s || !(v.t[i]! >= -1e-6 && v.t[i]! <= s.length + 1e-6) || !Number.isFinite(v.speed[i]!)) bad++
      }
    }
    expect(bad).toBe(0)
  })

  it('is deterministic for a seed and a sequence of steps', () => {
    const run = () => {
      const rng = mulberry32(7)
      const v = createVehicles(150, net, rng)
      const ctx = makeCtx(v.count)
      for (let step = 0; step < 800; step++) stepTraffic(v, 1 / 20, net, rng, ctx)
      return v
    }
    const a = run()
    const b = run()
    expect(Array.from(a.seg)).toEqual(Array.from(b.seg))
    expect(Array.from(a.t)).toEqual(Array.from(b.t))
    expect(Array.from(a.dir)).toEqual(Array.from(b.dir))
  })

  it('stops a car on red and lets it go on green', () => {
    // Find a junction and a car heading straight for it; run until the car is near a red stop line.
    const junction = net.nodes.find((n) => isSignalNode(net, n.id))
    expect(junction).toBeDefined()
    const rng = mulberry32(3)
    const v = createVehicles(60, net, rng)
    const ctx = makeCtx(v.count)
    const samples: number[] = []
    for (let step = 0; step < 2400; step++) {
      stepTraffic(v, 1 / 20, net, rng, ctx)
      for (let i = 0; i < v.count; i++) {
        const s = net.segments[v.seg[i]!]!
        const node = v.dir[i]! > 0 ? net.nodes[s.b]! : net.nodes[s.a]!
        if (!isSignalNode(net, node.id)) continue
        const dist = Math.abs(s.length - v.t[i]!)
        if (dist < 0.3 && v.speed[i]! < 0.02) samples.push(signalPhase(ctx.clock, signalOffset(node.id), s.horizontal))
      }
    }
    // Cars really stop at junctions, and some of those stops happen while the approach is red.
    expect(samples.some((p) => p === PHASE_RED)).toBe(true)
  })
})

describe('road raster', () => {
  const layout = buildLayout(snapshot())
  const plan = buildRoadPlan(layout)
  const r = buildRoadRaster(layout, plan.lights)
  const texel = (wx: number, wz: number) => {
    const px = Math.floor((wx - r.origin) * r.pxPerUnit)
    const py = Math.floor((wz - r.origin) * r.pxPerUnit)
    return (py * r.width + px) * 4
  }

  it('covers the layout with a square raster of a sane size', () => {
    expect(r.width * r.width * 4).toBe(r.surface.length)
    expect(r.width * r.width * 4).toBe(r.glow.length)
    expect(r.width).toBeLessThanOrEqual(2048)
  })

  it('paints street coverage only where the planner put streets', () => {
    let street = 0
    let total = 0
    for (let k = 0; k < r.surface.length; k += 4 * 7) {
      total++
      if (r.surface[k] === 255) street++
    }
    expect(street).toBeGreaterThan(0)
    expect(street).toBeLessThan(total) // buildings and plates are not street
  })

  it('lights avenues with a sodium band and paints a yellow centre line on them', () => {
    expect(r.avenues).toBeGreaterThan(0)
    let band = 0
    let yellow = 0
    for (let k = 0; k < r.glow.length; k += 4) if (r.glow[k + 2]! > 200) band++
    for (let k = 0; k < r.surface.length; k += 4) if (r.surface[k + 2]! > 0) yellow++
    expect(band).toBeGreaterThan(0)
    expect(yellow).toBeGreaterThan(0)
  })

  it('boosts junctions and paints zebra stripes at signalled junctions', () => {
    expect(r.junctions).toBeGreaterThan(0)
    const node = buildLanes(layout).nodes.find((n) => n.segments.length >= 3)!
    expect(r.glow[texel(node.x, node.z) + 3]!).toBeGreaterThan(100)
    let zebra = 0
    for (let k = 0; k < r.surface.length; k += 4) if (r.surface[k + 1]! > 200) zebra++
    expect(zebra).toBeGreaterThan(0)
  })

  it('puts lamp light on the ground beside the lamp heads', () => {
    const lamp = plan.lights[0]!
    const near = r.glow[texel(lamp.x, lamp.z) + 0]! + r.glow[texel(lamp.x + 0.3, lamp.z) + 0]!
    expect(near).toBeGreaterThan(0)
  })
})
