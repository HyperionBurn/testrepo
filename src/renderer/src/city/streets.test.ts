import { describe, expect, it } from 'vitest'
import { buildLayout, CITY_SIZE } from '../../../shared/layout'
import type { FileNode, RepoSnapshot } from '../../../shared/types'
import {
  LAMP_MODELS,
  ROAD_PIECES,
  SIDE_BIT,
  buildRoadPlan,
  lampTransform,
  lampTurnFor,
  openingMask,
  pieceForMask,
  rotateMask,
  rotateSide,
  type RoadPlan,
  type Side
} from './streets'

const file = (path: string, loc = 40): FileNode => ({ path, lang: 'ts', loc, bytes: loc * 30, mtime: 0, imports: [] })
const snap = (paths: string[]): RepoSnapshot => ({
  root: '/x', name: 'x', files: paths.map((p) => file(p)), scannedAt: 0
})

describe('rotation and piece table', () => {
  it('turns sides so that E goes to N, N to W, W to S (three.js rotation.y, quarter turns)', () => {
    expect(rotateSide('E', 1)).toBe('N')
    expect(rotateSide('N', 1)).toBe('W')
    expect(rotateSide('W', 1)).toBe('S')
    expect(rotateSide('S', 1)).toBe('E')
    expect(rotateSide('E', 2)).toBe('W')
  })

  it('rotates opening masks as sets', () => {
    expect(rotateMask(SIDE_BIT.E | SIDE_BIT.W, 1)).toBe(SIDE_BIT.N | SIDE_BIT.S)
    expect(rotateMask(SIDE_BIT.S | SIDE_BIT.W, 1)).toBe(SIDE_BIT.E | SIDE_BIT.S)
  })

  it('has a piece for every non-empty mask, and the piece opens exactly that mask', () => {
    for (let m = 1; m < 16; m++) {
      const piece = pieceForMask(m)
      expect(piece, `mask ${m}`).toBeDefined()
      expect(rotateMask(openingMask(ROAD_PIECES[piece!.kind].open), piece!.k), `mask ${m}`).toBe(m)
    }
    expect(pieceForMask(0)).toBeUndefined()
  })

  it('classifies masks by the number and shape of openings', () => {
    const kind = (sides: Side[]) => pieceForMask(openingMask(sides))?.kind
    for (const s of ['N', 'E', 'S', 'W'] as Side[]) expect(kind([s])).toBe('end')
    expect(kind(['E', 'W'])).toBe('straight')
    expect(kind(['N', 'S'])).toBe('straight')
    for (const pair of [['N', 'E'], ['E', 'S'], ['S', 'W'], ['W', 'N']] as Side[][]) expect(kind(pair)).toBe('bend')
    for (const three of [['N', 'E', 'S'], ['E', 'S', 'W'], ['S', 'W', 'N'], ['W', 'N', 'E']] as Side[][]) expect(kind(three)).toBe('tee')
    expect(kind(['N', 'E', 'S', 'W'])).toBe('cross')
  })

  it('uses the native openings measured from the GLBs', () => {
    expect(openingMask(ROAD_PIECES.straight.open)).toBe(SIDE_BIT.E | SIDE_BIT.W)
    expect(openingMask(ROAD_PIECES.bend.open)).toBe(SIDE_BIT.S | SIDE_BIT.W)
    expect(openingMask(ROAD_PIECES.end.open)).toBe(SIDE_BIT.E)
    expect(openingMask(ROAD_PIECES.tee.open)).toBe(SIDE_BIT.S | SIDE_BIT.E | SIDE_BIT.W)
    expect(openingMask(ROAD_PIECES.cross.open)).toBe(15)
  })

  it('turns lamp arms toward any side', () => {
    for (const s of ['N', 'E', 'S', 'W'] as Side[]) expect(rotateSide('N', lampTurnFor(s))).toBe(s)
  })

  it('puts the lamp head on the arm side of the pole after rotation', () => {
    const east = lampTransform('light-square', 10, 10, lampTurnFor('E') * (Math.PI / 2))
    expect(east.bulb.x).toBeGreaterThan(10.05)
    expect(Math.abs(east.bulb.z - 10)).toBeLessThan(1e-9)
    const north = lampTransform('light-square', 10, 10, 0)
    expect(north.bulb.z).toBeLessThan(10)
    // The model origin sits the pole offset away from the pole, so the pole lands on (10, 10).
    expect(north.origin.z).toBeCloseTo(10 - LAMP_MODELS['light-square'].pole.z, 9)
  })
})

describe('buildRoadPlan', () => {
  const paths = [
    'a/x/one.ts', 'a/x/two.ts', 'a/y/three.ts', 'a/y/four.ts',
    'b/one.ts', 'b/two.ts', 'b/three.ts',
    'c.ts'
  ]
  const layout = buildLayout(snap(paths))

  it('lays tiles only in streets: no tile centre is inside a leaf plate or a building', () => {
    const plan = buildRoadPlan(layout)
    expect(plan.tiles.length).toBeGreaterThan(0)
    const leaves = layout.districts.filter((d) => !layout.districts.some((o) => o.name.startsWith(d.name + '/')))
    for (const t of plan.tiles) {
      for (const d of leaves) {
        const inside = t.x > d.x && t.x < d.x + d.w && t.z > d.z && t.z < d.z + d.d
        expect(inside, `tile ${t.x},${t.z} in ${d.name}`).toBe(false)
      }
      for (const b of layout.buildings) {
        const inside = t.x > b.x && t.x < b.x + b.w && t.z > b.z && t.z < b.z + b.d
        expect(inside).toBe(false)
      }
    }
  })

  it('uses only road models, unit scale on the fine grid, and tiles lie inside the city', () => {
    const plan = buildRoadPlan(layout)
    const models = new Set(['road-straight', 'road-bend', 'road-end', 'road-intersection', 'road-crossroad'])
    const half = CITY_SIZE / 2
    for (const t of plan.tiles) {
      expect(models.has(t.model)).toBe(true)
      expect(t.scale).toBe(1)
      expect(Math.abs(t.x)).toBeLessThan(half)
      expect(Math.abs(t.z)).toBeLessThan(half)
    }
    for (const l of plan.lights) expect(['light-square', 'light-curved']).toContain(l.model)
  })

  it('is deterministic for the same layout', () => {
    expect(buildRoadPlan(layout)).toEqual(buildRoadPlan(buildLayout(snap(paths))))
  })

  it('caps the tile count for a 20k-file layout and stays fast', () => {
    const big: string[] = []
    for (let i = 0; i < 20000; i++) big.push(`pkg${i % 40}/mod${Math.floor(i / 40) % 25}/f${i}.ts`)
    const bigLayout = buildLayout(snap(big))
    const t0 = performance.now()
    const plan: RoadPlan = buildRoadPlan(bigLayout)
    const ms = performance.now() - t0
    expect(plan.tiles.length).toBeLessThanOrEqual(6000)
    expect(plan.tiles.length).toBeGreaterThan(0)
    console.log(`buildRoadPlan 20k files: ${ms.toFixed(1)} ms, ${plan.tiles.length} tiles, ${plan.lights.length} lights`)
    expect(ms).toBeLessThan(500)
  })
})
