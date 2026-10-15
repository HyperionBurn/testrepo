import { describe, expect, it } from 'vitest'
import {
  BRIDGES, EXCLUSION_MARGIN, GRID_ANGLE, LANDMARK_CORE, LANDMARK_DECO_MAX, LANDMARK_SPACING, LOT_DEPTH, MAX_LOTS, METRO_RADIUS, RIVERS,
  bridgeSpan, buildMetro, coreMask, footprintBox, hashName, lotHeight, metroCores, nearCap, overlaps, touchesRiver, type LotSet, type MetroPlan
} from './metro'
import { KIT_BUILDINGS, type KitBuilding } from './kit/kitManifest'

const KIT_BY_ID = (id: string): KitBuilding => {
  const k = KIT_BUILDINGS.find((d) => d.id === id)
  if (!k) throw new Error(`no kit ${id}`)
  return k
}

const HALF = 60 // half the repo city square (CITY_SIZE 120)
const NAME = 'skyline'

interface Lot { x: number; z: number; w: number; h: number; d: number; rot: number; band: string; massing: string; style: number[] }

function allLots(plan: MetroPlan): Lot[] {
  const out: Lot[] = []
  for (const g of plan.groups) {
    const s: LotSet = g.set
    for (let i = 0; i < s.count; i++) {
      out.push({
        x: s.pos[i * 3]!, z: s.pos[i * 3 + 2]!, w: s.size[i * 3]!, h: s.size[i * 3 + 1]!, d: s.size[i * 3 + 2]!,
        rot: s.rot[i]!, band: g.band, massing: g.massing, style: Array.from(s.style.subarray(i * 4, i * 4 + 4))
      })
    }
  }
  return out
}

const lotBox = (l: Lot) => footprintBox(l.x, l.z, l.w, l.d, l.rot)
const gapTo = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - HALF), Math.max(0, Math.abs(z) - HALF))

describe('metro plan', () => {
  const plan = buildMetro({ name: NAME, half: HALF })
  const lots = allLots(plan)

  it('is deterministic per repo name', () => {
    const again = buildMetro({ name: NAME, half: HALF })
    expect(again.boxCount).toBe(plan.boxCount)
    expect(again.groups.length).toBe(plan.groups.length)
    expect(again.groups[0]!.set.pos).toEqual(plan.groups[0]!.set.pos)
    expect(again.groups[0]!.set.style).toEqual(plan.groups[0]!.set.style)
    expect(again.lines.xz).toEqual(plan.lines.xz)
    expect(again.parks.rects).toEqual(plan.parks.rects)
  })

  it('gives each repo its own skyline', () => {
    const other = buildMetro({ name: 'another-repo', half: HALF })
    expect(other.seed).not.toBe(plan.seed)
    expect(other.groups[0]!.set.pos.slice(0, 60)).not.toEqual(plan.groups[0]!.set.pos.slice(0, 60))
    expect(hashName('a')).not.toBe(hashName('b'))
  })

  it('keeps every building out of the repo city square with its margin', () => {
    for (const l of lots) {
      const b = lotBox(l)
      const inside = b.x1 > -HALF && b.x0 < HALF && b.z1 > -HALF && b.z0 < HALF
      expect(inside).toBe(false)
    }
  })

  it('hugs the repo plate: the nearest buildings sit within a few units of the margin', () => {
    const nearest = Math.min(...lots.map((l) => {
      const b = lotBox(l)
      return Math.max(0, Math.max(-HALF - b.x1, b.x0 - HALF, -HALF - b.z1, b.z0 - HALF))
    }))
    expect(nearest).toBeGreaterThanOrEqual(0)
    expect(nearest).toBeLessThanOrEqual(EXCLUSION_MARGIN + 1)
  })

  it('keeps lots off the rivers and the bridge corridors', () => {
    for (const l of lots) {
      const b = lotBox(l)
      expect(touchesRiver(b.x0, b.x1)).toBe(false)
      for (const br of BRIDGES) expect(overlaps(bridgeSpan(br), b)).toBe(false)
    }
  })

  it('keeps every lot inside the metro radius', () => {
    for (const l of lots) expect(Math.hypot(l.x, l.z)).toBeLessThanOrEqual(METRO_RADIUS + 60)
  })

  it('stays within the instance budget', () => {
    expect(plan.boxCount).toBeLessThanOrEqual(MAX_LOTS)
    expect(plan.boxCount).toBeGreaterThanOrEqual(40000)
    expect(plan.triangles).toBeLessThanOrEqual(1_200_000)
  })

  it('keeps the draw count small: one instanced draw per (band, massing) group', () => {
    expect(plan.groups.length).toBeLessThanOrEqual(16)
    for (const g of plan.groups) expect(g.set.count).toBeGreaterThan(0)
  })

  it('uses the richest massings and spires only in the near ring', () => {
    for (const l of lots) {
      if (l.massing === 'crown' || l.massing === 'spire') expect(Math.hypot(l.x, l.z)).toBeLessThan(250)
    }
    const massings = new Set(lots.filter((l) => l.band === 'near').map((l) => l.massing))
    expect(massings.size).toBeGreaterThanOrEqual(4)
  })

  it('varies the massing, the turn, the lit share and the palette from lot to lot', () => {
    const near = lots.filter((l) => l.band === 'near')
    expect(new Set(lots.map((l) => l.massing)).size).toBeGreaterThanOrEqual(5)
    const turned = lots.filter((l) => l.rot === 1).length / lots.length
    expect(turned).toBeGreaterThan(0.03)
    expect(turned).toBeLessThan(0.4)
    const dens = lots.map((l) => l.style[0]!)
    expect(Math.max(...dens) - Math.min(...dens)).toBeGreaterThan(0.5)
    expect(new Set(lots.map((l) => l.style[2])).size).toBe(4)
    expect(lots.some((l) => l.style[3] === 1)).toBe(true)
    // Neighbouring lots differ: the near band mixes massings, palettes and lit shares.
    expect(new Set(near.map((l) => `${l.massing}${l.style[2]}`)).size).toBeGreaterThanOrEqual(12)
    expect(new Set(near.map((l) => Math.round(l.style[0]! * 10))).size).toBeGreaterThan(4)
  })

  it('keeps the metropolis low next to the repo plate', () => {
    const near = lots.filter((l) => gapTo(l.x, l.z) < 150)
    expect(near.length).toBeGreaterThan(0)
    for (const l of near) expect(l.h).toBeLessThanOrEqual(nearCap(gapTo(l.x, l.z)) + 1e-3)
    for (const l of near) expect(l.h).toBeLessThanOrEqual(12 + 1e-3)
  })

  it('has spiky downtown cores and low edges', () => {
    const heightsWhere = (f: (r: number) => boolean) => lots.filter((l) => f(Math.hypot(l.x, l.z))).map((l) => l.h)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const core = heightsWhere((r) => r < 900)
    const edge = heightsWhere((r) => r > 1400)
    expect(Math.max(...core)).toBeGreaterThan(18)
    const p95 = [...core].sort((a, b) => a - b)[Math.floor(core.length * 0.95)]!
    expect(p95).toBeGreaterThan(mean(edge) * 2)
    expect(mean(edge)).toBeLessThan(60)
  })

  it('places 6 to 8 cores on the island and across the rivers', () => {
    const cores = metroCores(hashName(NAME))
    expect(cores.length).toBeGreaterThanOrEqual(6)
    expect(cores.length).toBeLessThanOrEqual(8)
    for (const c of cores) expect(Math.abs(c.x) < 250 || Math.abs(c.x) > 700).toBe(true)
    expect(cores.some((c) => Math.abs(c.x) < 250)).toBe(true)
    expect(cores.some((c) => Math.abs(c.x) > 700)).toBe(true)
  })

  it('lotHeight tops out in the cores and stays low at the rim', () => {
    const cores = metroCores(hashName(NAME))
    const core = cores[0]!
    const inCore = lotHeight(core.x, core.z, cores, hashName(NAME), 0.99).h
    const rim = lotHeight(1500, 1500, cores, hashName(NAME), 0.99).h
    expect(inCore).toBeGreaterThan(rim * 4)
    expect(rim).toBeLessThan(60)
  })

  it('keeps the light lines on land and out of the repo square', () => {
    const { lines } = plan
    expect(lines.quads).toBeGreaterThan(5000)
    for (let q = 0; q < lines.quads; q++) {
      for (let v = 0; v < 4; v++) {
        const x = lines.xz[q * 8 + v * 2]!
        const z = lines.xz[q * 8 + v * 2 + 1]!
        expect(Math.abs(x) < HALF - 0.01 && Math.abs(z) < HALF - 0.01).toBe(false)
      }
      // A light segment may end exactly at a river bank, but its interior never lies over the water.
      const xs = [0, 1, 2, 3].map((v) => lines.xz[q * 8 + v * 2]!)
      expect(touchesRiver(Math.min(...xs) + 0.5, Math.max(...xs) - 0.5)).toBe(false)
    }
  })

  it('exposes the rivers as the strips the buildings avoid', () => {
    expect(RIVERS.map((r) => r.side).sort()).toEqual(['east', 'west'])
    expect(RIVERS[0]!.x1).toBeLessThan(-200)
    expect(RIVERS[1]!.x0).toBeGreaterThan(200)
  })

  it('puts the bridges 450 to 700 units from the framed default view', () => {
    // The framed view sits about 250 units out on the +x, +z side of the plate (azimuth 40, elevation 24).
    const cam = { x: 147, y: 100, z: 175 }
    for (const b of BRIDGES) {
      const nearest = Math.min(...b.towers.map((tx) => Math.hypot(tx - cam.x, b.deckY - cam.y, b.deckZ - cam.z)))
      expect(nearest).toBeGreaterThan(450)
      expect(nearest).toBeLessThan(900)
    }
  })

  it('leaves no dead plain within 400 units: lots, streets, parks, rivers and bridges cover the ground', () => {
    const R = 400
    const N = 800 // 1 unit cells over [-400, 400]
    const cover = new Uint8Array(N * N) // 1 = lot, 2 = street or park, 4 = river, bridge, or the repo square
    const mark = (b: { x0: number; x1: number; z0: number; z1: number }, bit: number) => {
      const i0 = Math.max(0, Math.floor(b.x0 + R)), i1 = Math.min(N - 1, Math.floor(b.x1 + R))
      const k0 = Math.max(0, Math.floor(b.z0 + R)), k1 = Math.min(N - 1, Math.floor(b.z1 + R))
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) cover[k * N + i] |= bit
    }
    for (const l of lots) mark(lotBox(l), 1)
    for (let q = 0; q < plan.lines.quads; q++) {
      const xs = [0, 1, 2, 3].map((v) => plan.lines.xz[q * 8 + v * 2]!)
      const zs = [0, 1, 2, 3].map((v) => plan.lines.xz[q * 8 + v * 2 + 1]!)
      mark({ x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }, 2)
    }
    for (let p = 0; p < plan.parks.count; p++) {
      const r = plan.parks.rects
      mark({ x0: r[p * 4]!, x1: r[p * 4 + 1]!, z0: r[p * 4 + 2]!, z1: r[p * 4 + 3]! }, 2)
    }
    for (const rv of RIVERS) mark({ x0: rv.x0, x1: rv.x1, z0: -R, z1: R }, 4)
    for (const b of BRIDGES) mark(bridgeSpan(b), 4)
    mark({ x0: -HALF, x1: HALF, z0: -HALF, z1: HALF }, 4)

    let total = 0
    let dead = 0
    for (let k = 0; k < N; k++) {
      for (let i = 0; i < N; i++) {
        const x = i - R + 0.5
        const z = k - R + 0.5
        if (Math.hypot(x, z) > R) continue
        total++
        if (cover[k * N + i]) continue
        dead++
      }
    }
    // Alleys, vacant parcels and the joints between frontages are the only bare ground left.
    expect(dead / total).toBeLessThan(0.12)
  })

  it('uses a fixed avenue grid aligned to the repo streets', () => {
    expect(GRID_ANGLE).toBe(0)
    expect(LOT_DEPTH).toBeGreaterThan(8)
  })
})

describe('metro landmarks (kit towers in the cores)', () => {
  const plan = buildMetro({ name: NAME, half: HALF })
  const cores = metroCores(plan.seed)
  const coreLots = allLots(plan).filter((l) => coreMask(l.x, l.z, cores) >= LANDMARK_CORE).length

  it('places kit towers in the cores, at 2 to 3 % of the core lots', () => {
    expect(plan.landmarks.length).toBeGreaterThan(0)
    for (const lm of plan.landmarks) expect(coreMask(lm.x, lm.z, cores)).toBeGreaterThanOrEqual(LANDMARK_CORE)
    const share = plan.landmarks.length / (coreLots + plan.landmarks.length)
    expect(share).toBeGreaterThanOrEqual(0.02)
    expect(share).toBeLessThanOrEqual(0.03)
  })

  it('never puts the same kit tower twice within 120 units', () => {
    for (let i = 0; i < plan.landmarks.length; i++) {
      for (let j = i + 1; j < plan.landmarks.length; j++) {
        const a = plan.landmarks[i]!
        const b = plan.landmarks[j]!
        if (a.kit !== b.kit) continue
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(LANDMARK_SPACING)
      }
    }
  })

  it('the deco supertall stands at most twice in the whole metropolis', () => {
    const decos = plan.landmarks.filter((l) => l.kit.startsWith('deco'))
    expect(decos.length).toBeLessThanOrEqual(LANDMARK_DECO_MAX)
  })

  it('is sized by the real height and footprint of its kit tower (10 m per unit)', () => {
    for (const lm of plan.landmarks) {
      const k = KIT_BY_ID(lm.kit)
      expect(lm.h).toBeCloseTo(k.heightM / 10, 9)
      expect(lm.w).toBeCloseTo(k.footprintM.w / 10, 9)
      expect(lm.d).toBeCloseTo(k.footprintM.d / 10, 9)
    }
  })

  it('keeps out of the repo square, the rivers and the bridges', () => {
    for (const lm of plan.landmarks) {
      const b = footprintBox(lm.x, lm.z, lm.w, lm.d, lm.rot)
      expect(b.x1 <= -HALF - EXCLUSION_MARGIN || b.x0 >= HALF + EXCLUSION_MARGIN || b.z1 <= -HALF - EXCLUSION_MARGIN || b.z0 >= HALF + EXCLUSION_MARGIN).toBe(true)
      expect(touchesRiver(b.x0, b.x1)).toBe(false)
      expect(BRIDGES.some((br) => overlaps(bridgeSpan(br), b))).toBe(false)
    }
  })

  it('every lot carries its facade set, and the landmarks are counted in the triangles', () => {
    for (const g of plan.groups) {
      expect(g.set.facade.length).toBe(g.set.count)
      for (const f of g.set.facade) expect(f).toBeLessThan(14)
    }
    expect(plan.triangles).toBeGreaterThan(plan.landmarks.length)
  })

  it('stays under the metropolis budget: at most 4.5 M triangles in total', () => {
    expect(plan.triangles).toBeLessThanOrEqual(4_500_000)
  })
})
