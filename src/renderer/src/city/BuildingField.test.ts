import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, Ray, Vector3, type Texture } from 'three'
import type { CityLayout } from '../../../shared/types'
import { BuildingField, COLOR_FADE_S, CROSSFADE_S } from './BuildingField'
import { createBuildingMaterials } from './buildingShader'
import type { LoadedModel } from './assets/loader'
import { getModel } from './assets/manifest'
import { templateById } from './facade/templates'
import { visHeight } from './geom'
import { KIT_BUILDINGS, type KitBuilding } from './kit/kitManifest'
import type { KitData } from './kit/loader'

const layout: CityLayout = {
  buildings: [
    { path: 'a.ts', x: 0, z: 0, w: 2, d: 2, h: 1, lang: 'ts', color: '#ff0000', district: '' },
    { path: 'b.ts', x: 4, z: 0, w: 2, d: 2, h: 1, lang: 'js', color: '#00ff00', district: '' }
  ],
  districts: [],
  size: 120
}
/** The stylized gate: the Kenney model tests below exercise that path. The real style has its own block at the end. */
const gate = { style: 'stylized' as const, mode: 'live' as const, gitTs: null, firstSeen: {} }
const realGate = { mode: 'live' as const, gitTs: null, firstSeen: {} }

function mats() {
  return createBuildingMaterials()
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

/** A stand-in for the loaded kit: every kit model as a unit box in its own world size, no textures. */
function fakeKit(): KitData {
  const buildings = new Map<string, { def: KitBuilding; geometry: BoxGeometry }>()
  for (const def of KIT_BUILDINGS) {
    const g = new BoxGeometry(def.footprintM.w / 10, def.heightM / 10, def.footprintM.d / 10)
    g.translate(0, def.heightM / 20, 0)
    buildings.set(def.id, { def, geometry: g })
  }
  return { buildings, ground: new BoxGeometry(1, 0, 1), textures: {} as KitData['textures'] } as KitData
}

/** The app steps at most 50 ms at a time (Buildings.tsx); the springs need small steps to settle. */
function settle(f: BuildingField): void {
  for (let i = 0; i < 400; i++) f.step(0.02)
}

describe('BuildingField real style (facades)', () => {
  it('is the default, with a facade layer and no model loading', () => {
    const f = new BuildingField(layout, mats(), null, realGate)
    expect(f.style).toBe('real')
    expect(f.hasModels).toBe(true)
    expect(f.modelIds()).toEqual([])
    const id = f.slotFor('a.ts')!.massing.modelId
    expect(templateById(id)).toBeDefined()
    // One mesh per template in use, each with the per-instance facade attributes the photo material reads.
    for (const m of f.meshes) {
      for (const name of ['aFacade', 'aLit', 'aSeed', 'aSize']) expect(m.geometry.getAttribute(name)).toBeDefined()
      expect(m.castShadow).toBe(true)
      expect(m.receiveShadow).toBe(true)
    }
  })

  it('draws each massing at its footprint times FILL, with the rendered height as its y scale', () => {
    const f = new BuildingField(layout, mats(), null, realGate)
    settle(f)
    const slot = f.slotFor('a.ts')!
    const p = slot.massing
    expect(p.sx).toBeCloseTo(slot.w * 0.97, 9)
    expect(p.sz).toBeCloseTo(slot.d * 0.97, 9)
    expect(p.invY).toBe(1)
    expect(slot.h).toBeCloseTo(visHeight(layout.buildings[0]!, layout), 6)
  })

  it('the picked top of a facade is its rendered height (visHeight)', () => {
    const f = new BuildingField(layout, mats(), null, realGate)
    settle(f)
    const slot = f.slotFor('a.ts')!
    const hit = f.pickRay(new Ray(new Vector3(1, 200, 1), new Vector3(0, -1, 0)))
    expect(hit).not.toBeNull()
    expect(f.slots[hit!.slot]!.path).toBe('a.ts')
    expect(hit!.point.y).toBeCloseTo(slot.h, 3)
    expect(f.pickRay(new Ray(new Vector3(3, 200, 1), new Vector3(0, -1, 0)))).toBeNull()
  })

  it('a kit tower stands where the kit fits, and its massing gives way to it when the kit is adopted', () => {
    const tall: CityLayout = {
      buildings: [
        { path: 'k.ts', x: -3, z: -3, w: 6, d: 6, h: 10, lang: 'ts', color: '#ff0000', district: '' },
        { path: 's.ts', x: 4, z: 0, w: 2, d: 2, h: 1, lang: 'ts', color: '#00ff00', district: '' }
      ],
      districts: [],
      size: 120
    }
    const loc = new Map([['k.ts', 5000], ['s.ts', 20]])
    const f = new BuildingField(tall, mats(), null, { ...realGate, loc })
    const k = f.slotFor('k.ts')!
    expect(k.kit).toBe(true)
    expect(k.kitMix).toBe(0)
    expect(f.drawingOf('k.ts')!.kit).toBe(true)
    expect(f.slotFor('s.ts')!.kit).toBe(false)
    expect(f.hasKit).toBe(false)

    const kit = fakeKit()
    expect(f.adoptKit(kit)).toBe(true)
    expect(f.hasKit).toBe(true)
    expect(f.adoptKit(kit)).toBe(false)
    expect(f.meshes.length).toBeGreaterThan(1)
    // Mid-crossfade the two layers share the building; after CROSSFADE_S the tower is all there is.
    f.step(CROSSFADE_S / 2)
    expect(k.kitMix).toBeGreaterThan(0)
    expect(k.kitMix).toBeLessThan(1)
    f.step(CROSSFADE_S)
    expect(k.kitMix).toBe(1)
    // The kit tower is at its rendered height: the kit's own height scaled to visHeight.
    const kitDef = KIT_BUILDINGS.find((d) => d.id === f.drawingOf('k.ts')!.modelId)!
    expect(kitDef).toBeDefined()
    expect(k.place.invY * k.h * (kitDef.heightM / 10)).toBeCloseTo(k.h, 6)
    // Picking the kit building still returns its path.
    settle(f)
    const hit = f.pickRay(new Ray(new Vector3(0, 200, 0), new Vector3(0, -1, 0)))
    expect(hit && f.slots[hit.slot]!.path).toBe('k.ts')
  })

  it('a style change does not carry ghosts across (their models would not exist)', () => {
    const before = new BuildingField(layout, mats(), null, realGate)
    const gone: CityLayout = { ...layout, buildings: [layout.buildings[0]!] }
    const removed = new BuildingField(gone, mats(), before, realGate)
    expect(removed.slots.some((s) => s.ghost)).toBe(true)
    const restyled = new BuildingField(layout, mats(), removed, { ...realGate, style: 'stylized' })
    expect(restyled.slots.some((s) => s.ghost)).toBe(false)
  })
})

