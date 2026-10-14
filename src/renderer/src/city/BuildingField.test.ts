import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, MeshStandardMaterial, Ray, Vector3, type Texture } from 'three'
import type { CityLayout } from '../../../shared/types'
import { BuildingField, COLOR_FADE_S, CROSSFADE_S } from './BuildingField'
import type { BuildingMaterials } from './buildingShader'
import type { LoadedModel } from './assets/loader'
import { getModel } from './assets/manifest'

const layout: CityLayout = {
  buildings: [
    { path: 'a.ts', x: 0, z: 0, w: 2, d: 2, h: 1, lang: 'ts', color: '#ff0000', district: '' },
    { path: 'b.ts', x: 4, z: 0, w: 2, d: 2, h: 1, lang: 'js', color: '#00ff00', district: '' }
  ],
  districts: [],
  size: 120
}
const gate = { mode: 'live' as const, gitTs: null, firstSeen: {} }

function mats(): BuildingMaterials {
  return { models: new MeshStandardMaterial(), boxes: new MeshStandardMaterial(), time: { value: 0 } }
}

/** A stand-in for a loaded model: a unit box in the model's own size, no textures. */
function fakeModel(id: string): LoadedModel {
  const def = getModel(id)
  const geometry = new BoxGeometry(def.size.x, def.size.y, def.size.z)
  geometry.translate(0, def.size.y / 2, 0)
  return { def, geometry, map: {} as Texture }
}

function fakeModels(ids: string[]): Map<string, LoadedModel> {
  return new Map(ids.map((id) => [id, fakeModel(id)]))
}

describe('BuildingField colors', () => {
  it('starts each building at its layout color', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    const red = new Color('#ff0000')
    expect(f.colorOf('a.ts')).toEqual([red.r, red.g, red.b])
  })

  it('eases a recolored building over COLOR_FADE_S and leaves unmapped ones alone', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    const red = new Color('#ff0000')
    const blue = new Color('#0000ff')
    f.setColors(new Map([['a.ts', '#0000ff']]))
    f.step(COLOR_FADE_S / 2)
    const mid = f.colorOf('a.ts')
    expect(mid[0]).toBeGreaterThan(0)
    expect(mid[0]).toBeLessThan(red.r)
    expect(mid[2]).toBeGreaterThan(0)
    expect(mid[2]).toBeLessThan(blue.b)

    f.step(COLOR_FADE_S)
    expect(f.colorOf('a.ts')).toEqual([blue.r, blue.g, blue.b])
    const green = new Color('#00ff00')
    expect(f.colorOf('b.ts')).toEqual([green.r, green.g, green.b])
  })

  it('applies colors at once when not animating', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    const blue = new Color('#0000ff')
    f.setColors(new Map([['a.ts', '#0000ff']]), false)
    expect(f.colorOf('a.ts')).toEqual([blue.r, blue.g, blue.b])
  })
})

describe('BuildingField models', () => {
  it('starts with the boxes when no model is loaded, one mesh and no models', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    expect(f.hasModels).toBe(false)
    expect(f.meshes.length).toBe(1)
  })

  it('places every building with a model that fits its footprint and is not stretched out of range', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    for (const path of ['a.ts', 'b.ts']) {
      const p = f.placementOf(path)!
      expect(p).toBeDefined()
      expect(p.stretch).toBeGreaterThanOrEqual(0.5)
      expect(p.stretch).toBeLessThanOrEqual(3)
    }
    // Footprint: the model's x and z never exceed the file's footprint.
    const a = f.placementOf('a.ts')!
    expect(a.sx * getModel(a.modelId).size.x).toBeLessThanOrEqual(2)
    expect(a.sz * getModel(a.modelId).size.z).toBeLessThanOrEqual(2)
  })

  it('crossfades into the models: boxes shrink away and the model meshes take over', () => {
    const ids = new BuildingField(layout, mats(), null, gate).modelIds()
    const f = new BuildingField(layout, mats(), null, gate)
    expect(f.adoptModels(fakeModels(ids))).toBe(true)
    expect(f.hasModels).toBe(true)
    expect(f.meshes.length).toBe(ids.length + 1) // boxes still there during the crossfade
    f.step(CROSSFADE_S + 0.01)
    expect(f.meshes.length).toBe(ids.length)
    expect(f.meshes.every((m) => m.count > 0)).toBe(true)
  })

  it('refuses to adopt when a model is missing, and keeps the boxes', () => {
    const f = new BuildingField(layout, mats(), null, gate)
    const ids = f.modelIds()
    expect(f.adoptModels(new Map())).toBe(false)
    expect(f.hasModels).toBe(false)
    expect(ids.length).toBeGreaterThan(0)
  })

  it('starts with the models when they are already loaded', () => {
    const ids = new BuildingField(layout, mats(), null, gate).modelIds()
    const f = new BuildingField(layout, mats(), null, { ...gate, models: fakeModels(ids) })
    expect(f.hasModels).toBe(true)
    expect(f.meshes.length).toBe(ids.length)
  })
})

describe('BuildingField picking', () => {
  it('reports the building under the ray, and only through the mesh that owns it', () => {
    const ids = new BuildingField(layout, mats(), null, gate).modelIds()
    const f = new BuildingField(layout, mats(), null, { ...gate, models: fakeModels(ids) })
    f.step(5) // heights grow from the ground on their springs
    // a.ts sits at x 0..2, z 0..2. A ray from above at its centre hits it.
    const ray = new Ray(new Vector3(1, 200, 1), new Vector3(0, -1, 0))
    const hit = f.pickRay(ray)
    expect(hit).not.toBeNull()
    expect(f.slots[hit!.slot]!.path).toBe('a.ts')
    expect(hit!.point.y).toBeGreaterThan(0)
    // A ray in the gap between the two buildings misses.
    expect(f.pickRay(new Ray(new Vector3(3, 200, 1), new Vector3(0, -1, 0)))).toBeNull()
  })

  it('pathAt maps a mesh instance back to its path', () => {
    const ids = new BuildingField(layout, mats(), null, gate).modelIds()
    const f = new BuildingField(layout, mats(), null, { ...gate, models: fakeModels(ids) })
    f.step(5)
    const paths = f.meshes.flatMap((m) => Array.from({ length: m.count }, (_, i) => f.pathAt(m, i)))
    expect(paths.filter((p) => p === 'b.ts').length).toBe(1)
  })
})
