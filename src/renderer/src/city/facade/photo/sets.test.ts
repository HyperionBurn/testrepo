import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ATLAS_LAYOUT } from './layout'
import { FACADE_SETS, FLOOR_HEIGHT_M, bayWidthM } from './sets'

const TEX = (name: string) => fileURLToPath(new URL(`./textures/${name}`, import.meta.url))

describe('FACADE_SETS', () => {
  it('has 12-16 sets that fit one 4x4 atlas', () => {
    expect(FACADE_SETS.length).toBeGreaterThanOrEqual(12)
    expect(FACADE_SETS.length).toBeLessThanOrEqual(16)
  })

  it('has unique ids', () => {
    expect(new Set(FACADE_SETS.map((s) => s.id)).size).toBe(FACADE_SETS.length)
  })

  it('keeps 2-12 floors per tile at 2.8-4.2 m per floor', () => {
    for (const s of FACADE_SETS) {
      expect(s.floors, s.id).toBeGreaterThanOrEqual(2)
      expect(s.floors, s.id).toBeLessThanOrEqual(12)
      const perFloor = s.tileHeightM / s.floors
      expect(perFloor, s.id).toBeGreaterThanOrEqual(2.8)
      expect(perFloor, s.id).toBeLessThanOrEqual(4.2)
      expect(s.tileHeightM, s.id).toBeCloseTo(s.floors * FLOOR_HEIGHT_M, 6)
    }
  })

  it('has plausible bay widths (curtain walls may be narrower than 3 m)', () => {
    for (const s of FACADE_SETS) {
      const bay = bayWidthM(s)
      expect(bay, s.id).toBeGreaterThanOrEqual(1.5)
      expect(bay, s.id).toBeLessThanOrEqual(4.5)
      expect(s.tileWidthM, s.id).toBeCloseTo(s.bays * bay, 6)
    }
  })
})

describe('atlas layout JSON', () => {
  const { cells, atlasSize, cellSize, gutter, contentSize, grid } = ATLAS_LAYOUT

  it('is a 4x4 grid of 512^2 cells making a 2048^2 atlas with a 16 px wrap gutter', () => {
    expect(atlasSize).toBe(2048)
    expect(cellSize).toBe(512)
    expect(grid * cellSize).toBe(atlasSize)
    expect(contentSize + 2 * gutter).toBe(cellSize)
  })

  it('lists the same sets, in the same order, as FACADE_SETS', () => {
    expect(cells.length).toBe(FACADE_SETS.length)
    cells.forEach((c, i) => {
      const s = FACADE_SETS[i]
      expect(c.index).toBe(i)
      expect(c.id).toBe(s.id)
      expect(c.tileWidthM).toBeCloseTo(s.tileWidthM, 2)
      expect(c.tileHeightM).toBeCloseTo(s.tileHeightM, 2)
      expect(c.floors).toBe(s.floors)
      expect(c.bays).toBe(s.bays)
      expect(c.tone).toBe(s.tone)
    })
  })

  it('places every cell inside its grid slot, with the content inside the gutter', () => {
    for (const c of cells) {
      expect(c.cellPx).toEqual([c.col * cellSize, c.row * cellSize, cellSize, cellSize])
      const [x, y, w, h] = c.contentPx
      expect(w).toBe(contentSize)
      expect(h).toBe(contentSize)
      expect(x).toBe(c.col * cellSize + gutter)
      expect(y).toBe(c.row * cellSize + gutter)
      const [u0, v0, du, dv] = c.uvRect
      expect(u0).toBeGreaterThanOrEqual(0)
      expect(v0).toBeGreaterThanOrEqual(0)
      expect(u0 + du).toBeLessThanOrEqual(1 + 1e-9)
      expect(v0 + dv).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('has no two cells sharing a slot', () => {
    const slots = new Set(cells.map((c) => `${c.col},${c.row}`))
    expect(slots.size).toBe(cells.length)
  })

  it('keeps the far-field colours in range', () => {
    for (const c of cells) {
      for (const v of [...c.farAlbedo, ...c.farEmissive]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('texture files', () => {
  it('exist, match the layout file names and fit the 12 MB budget', () => {
    let total = 0
    for (const name of Object.values(ATLAS_LAYOUT.files)) {
      const size = statSync(TEX(name)).size
      expect(size, name).toBeGreaterThan(10_000)
      total += size
    }
    expect(total).toBeLessThanOrEqual(12 * 1024 * 1024)
  })

  it('ships a credit line for ambientCG (CC0)', () => {
    const readme = readFileSync(TEX('README.md'), 'utf8')
    expect(readme).toMatch(/ambientCG/)
    expect(readme).toMatch(/CC0/)
  })
})
