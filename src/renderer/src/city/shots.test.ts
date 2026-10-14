import { describe, expect, it } from 'vitest'
import type { FramePose, Vec3 } from './framing'
import {
  busiestBox,
  chooseKind,
  COOLDOWN_S,
  districtBoxes,
  eligibleKinds,
  flyPair,
  lerpView,
  mulberry32,
  planShot,
  shotView,
  summarize,
  type ActiveAgent,
  type DistrictBox,
  type EventSample,
  type LiveInputs,
  type Memory,
  type Scene,
  type ShotKind,
  type ShotSpec
} from './shots'

const NOW = 1_000_000
const frame: FramePose = { radius: 300, phi: (55 * Math.PI) / 180, theta: Math.PI / 4, target: { x: 0, y: 12, z: 0 } }
const live = (over: Partial<LiveInputs> = {}): LiveInputs => ({ back: { x: 1, z: 0 }, frame, ...over })

const box = (key: string, cx: number, cz: number, count = 10, half = 12): DistrictBox => ({ key, cx, cz, half, top: 20, count })
const agent = (id: string, status: ActiveAgent['status'], building?: Vec3): ActiveAgent => ({ id, status, building, top: 10 })
const ev = (agentId: string, ts: number, file?: string, type = 'read'): EventSample => ({ agentId, type, ts, file })

function scene(over: Partial<Scene> = {}): Scene {
  return {
    now: NOW,
    summary: { total: 0, counts: new Map(), streakAgent: null },
    boxes: [box('src/a', -30, -30), box('src/b', 30, 30, 4)],
    agents: [],
    ...over
  }
}

/** Runs a sequence of cuts, feeding each choice back into the history, and returns the kinds. */
function run(s: Scene, cuts: number, seed = 1, gap = 9): ShotKind[] {
  const rand = mulberry32(seed)
  const history: Memory[] = []
  const out: ShotKind[] = []
  let clock = 0
  for (let i = 0; i < cuts; i++) {
    const kind = chooseKind(s, history, clock, rand)
    out.push(kind)
    history.push({ kind, at: clock })
    clock += gap
  }
  return out
}

describe('summarize', () => {
  const byId = (f?: string) => (f ? (f.startsWith('src/a') ? 'src/a' : 'src/b') : undefined)

  it('counts only events inside the activity window, per neighbourhood', () => {
    const events = [
      ev('x', NOW - 30_000, 'src/a/old.ts'),
      ev('x', NOW - 19_000, 'src/a/one.ts'),
      ev('y', NOW - 5_000, 'src/a/two.ts'),
      ev('y', NOW - 2_000, 'src/b/three.ts'),
      ev('fs', NOW - 1_000)
    ]
    const s = summarize(events, NOW, byId)
    expect(s.total).toBe(4)
    expect(s.counts.get('src/a')).toBe(2)
    expect(s.counts.get('src/b')).toBe(1)
  })

  it('reports quiet when nothing happened in the window', () => {
    expect(summarize([ev('x', NOW - 25_000, 'src/a/x.ts')], NOW, byId).total).toBe(0)
  })

  it('finds an agent starting an edit streak, but not one that was already editing', () => {
    const starting = [ev('s', NOW - 2_000, 'src/a/x.ts', 'edit'), ev('s', NOW - 1_000, 'src/a/x.ts', 'edit')]
    expect(summarize(starting, NOW, byId).streakAgent).toBe('s')
    const continuing = [
      ev('c', NOW - 12_000, 'src/a/x.ts', 'edit'),
      ev('c', NOW - 6_000, 'src/a/x.ts', 'edit'),
      ev('c', NOW - 1_000, 'src/a/x.ts', 'edit')
    ]
    expect(summarize(continuing, NOW, byId).streakAgent).toBeNull()
  })
})

describe('districtBoxes', () => {
  it('groups buildings by neighbourhood, boxes them and sorts by building count', () => {
    const items = [
      { path: 'src/a/1.ts', x: -40, z: -40, w: 4, d: 4, top: 8 },
      { path: 'src/a/2.ts', x: -20, z: -30, w: 4, d: 4, top: 14 },
      { path: 'src/b/1.ts', x: 30, z: 30, w: 4, d: 4, top: 5 }
    ]
    const keys: Record<string, string> = { 'src/a/1.ts': 'src/a', 'src/a/2.ts': 'src/a', 'src/b/1.ts': 'src/b' }
    const boxes = districtBoxes(items, (p) => keys[p])
    expect(boxes.map((b) => b.key)).toEqual(['src/a', 'src/b'])
    const a = boxes[0]!
    expect(a.count).toBe(2)
    expect(a.top).toBe(14)
    expect(a.cx).toBeCloseTo((-40 + -16) / 2, 6)
    expect(a.half).toBeGreaterThanOrEqual(12)
  })

  it('skips buildings without a neighbourhood', () => {
    expect(districtBoxes([{ path: 'gone.ts', x: 0, z: 0, w: 2, d: 2, top: 3 }], () => undefined)).toEqual([])
  })
})

describe('chooseKind', () => {
  it('never repeats the shot just shown', () => {
    const s = scene({
      summary: { total: 20, counts: new Map([['src/a', 20]]), streakAgent: null },
      agents: [agent('a', 'editing', { x: 0, y: 5, z: 0 }), agent('b', 'reading'), agent('c', 'thinking')]
    })
    for (let seed = 1; seed <= 20; seed++) {
      const kinds = run(s, 60, seed)
      for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1])
    }
  })

  it('respects cooldowns: a fly-through does not come back within its cooldown', () => {
    const b = (x: number) => ({ x, y: 5, z: 0 })
    const s = scene({
      summary: { total: 30, counts: new Map([['src/a', 30]]), streakAgent: null },
      agents: [agent('a', 'editing', b(-40)), agent('b', 'reading', b(40)), agent('c', 'running', b(0))]
    })
    const rand = mulberry32(3)
    const history: Memory[] = []
    let clock = 0
    for (let i = 0; i < 400; i++) {
      const kind = chooseKind(s, history, clock, rand)
      if (kind === 'flythrough') {
        const prev = [...history].reverse().find((m) => m.kind === 'flythrough')
        if (prev) expect(clock - prev.at).toBeGreaterThanOrEqual(COOLDOWN_S.flythrough)
      }
      history.push({ kind, at: clock })
      clock += 4
    }
  })

  it('with no agents only reveals and orbits', () => {
    const kinds = run(scene({ summary: { total: 9, counts: new Map([['src/a', 9]]), streakAgent: null } }), 80, 5)
    for (const k of kinds) expect(['reveal', 'orbit']).toContain(k)
    expect(new Set(kinds).has('orbit')).toBe(true)
  })

  it('with nothing happening for 20 s it mostly reveals', () => {
    const s = scene({ agents: [agent('a', 'editing', { x: 0, y: 5, z: 0 })] })
    const kinds = run(s, 200, 9)
    const reveals = kinds.filter((k) => k === 'reveal').length
    // No shot repeats back to back, so a reveal can take at most every other cut.
    expect(reveals / kinds.length).toBeGreaterThan(0.4)
    expect(kinds).not.toContain('follow')
    expect(kinds).not.toContain('flythrough')
  })

  it('biases to a follow shot when an agent starts an edit streak', () => {
    const target = { x: 10, y: 5, z: 10 }
    const base = {
      summary: { total: 6, counts: new Map([['src/a', 6]]), streakAgent: null },
      agents: [agent('a', 'editing', target), agent('b', 'reading')]
    }
    const without = run(scene(base), 400, 11)
    const withStreak = run(scene({ ...base, summary: { ...base.summary, streakAgent: 'a' } }), 400, 11)
    const share = (ks: ShotKind[]) => ks.filter((k) => k === 'follow').length / ks.length
    // The no-repeat rule caps follow at every other cut, so the lift is smaller than the raw weights suggest.
    expect(share(withStreak)).toBeGreaterThan(share(without) * 1.25)
  })

  it('only offers a fly-through with three drones and a long enough street', () => {
    const near = [agent('a', 'editing', { x: 0, y: 5, z: 0 }), agent('b', 'reading', { x: 4, y: 5, z: 0 }), agent('c', 'thinking', { x: 2, y: 5, z: 1 })]
    expect(eligibleKinds(scene({ agents: near }))).not.toContain('flythrough')
    const far = [agent('a', 'editing', { x: -40, y: 5, z: 0 }), agent('b', 'reading', { x: 40, y: 5, z: 0 }), agent('c', 'thinking', { x: 0, y: 5, z: 1 })]
    expect(eligibleKinds(scene({ agents: far }))).toContain('flythrough')
    expect(eligibleKinds(scene({ agents: far.slice(0, 2) }))).not.toContain('flythrough')
  })
})

describe('flyPair and busiestBox', () => {
  it('picks the two buildings farthest apart', () => {
    const pair = flyPair([agent('a', 'reading', { x: 0, y: 0, z: 0 }), agent('b', 'reading', { x: 50, y: 0, z: 0 }), agent('c', 'reading', { x: 10, y: 0, z: 0 })])
    expect(pair).not.toBeNull()
    expect(Math.abs(pair![0].x - pair![1].x)).toBe(50)
  })

  it('takes the neighbourhood with the most recent events, else the largest', () => {
    const s = scene({ summary: { total: 5, counts: new Map([['src/b', 5]]), streakAgent: null } })
    expect(busiestBox(s)?.key).toBe('src/b')
    expect(busiestBox(scene())?.key).toBe('src/a')
  })
})

describe('planShot and shotView', () => {
  const rand = mulberry32(42)
  const s = scene({
    summary: { total: 8, counts: new Map([['src/a', 8]]), streakAgent: 'a' },
    agents: [agent('a', 'editing', { x: 20, y: 6, z: 8 }), agent('b', 'reading', { x: -40, y: 5, z: -10 }), agent('c', 'thinking', { x: 0, y: 5, z: 40 })]
  })

  it('gives every shot a duration between 6 and 12 seconds', () => {
    for (const k of ['orbit', 'follow', 'crane', 'reveal', 'flythrough'] as ShotKind[]) {
      for (let i = 0; i < 20; i++) {
        const spec = planShot(k, s, rand)
        expect(spec.dur).toBeGreaterThanOrEqual(6)
        expect(spec.dur).toBeLessThanOrEqual(12)
      }
    }
  })

  it('orbits at 35 to 45 degrees of elevation, at a steady distance', () => {
    for (let i = 0; i < 20; i++) {
      const spec = planShot('orbit', s, rand) as Extract<ShotSpec, { kind: 'orbit' }>
      const elevation = 90 - (spec.phi * 180) / Math.PI
      expect(elevation).toBeGreaterThanOrEqual(35 - 1e-9)
      expect(elevation).toBeLessThanOrEqual(45 + 1e-9)
      for (const t of [0, 3, 7, spec.dur]) {
        const v = shotView(spec, t, live())!
        const d = Math.hypot(v.pos.x - v.look.x, v.pos.y - v.look.y, v.pos.z - v.look.z)
        expect(d).toBeCloseTo(spec.radius, 6)
        expect(v.look).toEqual(spec.center)
      }
    }
  })

  it('follows a drone from behind and above, looking at the drone\'s building', () => {
    const spec = planShot('follow', s, rand)
    expect(spec.kind).toBe('follow')
    if (spec.kind !== 'follow') return
    expect(spec.agentId).toBe('a')
    const drone = { x: 22, y: 12, z: 9 }
    const v = shotView(spec, 2, live({ drone, back: { x: 0, z: 1 } }))!
    expect(v.pos.z).toBeGreaterThan(drone.z)
    expect(v.pos.y).toBeGreaterThan(drone.y)
    expect(v.look).toEqual(spec.building)
  })

  it('returns null for a follow shot whose drone is gone', () => {
    const spec = planShot('follow', s, rand)
    expect(shotView(spec, 1, live({ drone: undefined }))).toBeNull()
  })

  it('crane rises from street level to a high vantage', () => {
    const spec = planShot('crane', s, rand) as Extract<ShotSpec, { kind: 'crane' }>
    expect(spec.kind).toBe('crane')
    const low = shotView(spec, 0, live())!
    const high = shotView(spec, spec.dur, live())!
    expect(low.pos.y).toBeLessThan(15)
    expect(high.pos.y).toBeGreaterThan(40)
    expect(high.pos.y).toBeGreaterThan(low.pos.y)
  })

  it('reveal is the framed city pose, nudged slowly', () => {
    const spec = planShot('reveal', s, rand)
    const v0 = shotView(spec, 0, live())!
    expect(v0.look).toEqual(frame.target)
    expect(Math.hypot(v0.pos.x - v0.look.x, v0.pos.y - v0.look.y, v0.pos.z - v0.look.z)).toBeCloseTo(frame.radius, 6)
    const v1 = shotView(spec, spec.dur, live())!
    expect(v1.pos).not.toEqual(v0.pos)
  })

  it('fly-through travels along the street, widening the lens mid-shot', () => {
    const pair: ActiveAgent[] = [agent('a', 'editing', { x: -40, y: 5, z: 0 }), agent('b', 'reading', { x: 40, y: 5, z: 0 }), agent('c', 'thinking', { x: 0, y: 5, z: 1 })]
    const fs = planShot('flythrough', scene({ agents: pair }), mulberry32(7))
    expect(fs.kind).toBe('flythrough')
    if (fs.kind !== 'flythrough') return
    const start = shotView(fs, 0, live())!
    const mid = shotView(fs, fs.dur / 2, live())!
    const end = shotView(fs, fs.dur, live())!
    expect(Math.abs(end.pos.x - start.pos.x)).toBeGreaterThan(40)
    expect(start.fovBump).toBeCloseTo(0, 6)
    expect(mid.fovBump).toBeCloseTo(9, 6)
    expect(mid.pos.y).toBeLessThan(8)
  })

  it('every shot view stays finite and above the ground across its duration', () => {
    for (const k of ['orbit', 'follow', 'crane', 'reveal', 'flythrough'] as ShotKind[]) {
      const spec = planShot(k, s, rand)
      for (let t = 0; t <= spec.dur; t += 0.5) {
        const v = shotView(spec, t, live({ drone: { x: 22, y: 12, z: 9 } }))!
        for (const val of [v.pos.x, v.pos.y, v.pos.z, v.look.x, v.look.y, v.look.z, v.fovBump]) expect(Number.isFinite(val)).toBe(true)
        expect(v.pos.y).toBeGreaterThanOrEqual(2.5)
      }
    }
  })

  it('a fly-through without its pair falls back to reveal', () => {
    expect(planShot('flythrough', scene(), rand).kind).toBe('reveal')
  })
})

describe('lerpView', () => {
  it('blends positions, looks and fov bumps linearly', () => {
    const a = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, fovBump: 0 }
    const b = { pos: { x: 10, y: 4, z: -2 }, look: { x: 2, y: 2, z: 2 }, fovBump: 4 }
    const m = lerpView(a, b, 0.5)
    expect(m.pos).toEqual({ x: 5, y: 2, z: -1 })
    expect(m.look).toEqual({ x: 1, y: 1, z: 1 })
    expect(m.fovBump).toBe(2)
    expect(a.pos.x).toBe(0)
  })
})
