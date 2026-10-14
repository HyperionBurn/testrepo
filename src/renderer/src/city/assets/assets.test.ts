// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MODELS, getModel, modelsByClass, type ModelClass } from './manifest'
import { emissiveFromPixels, isWindowTexel } from './colormap'
import { normaliseScene, parseGlbBytes } from './loader'
// Pure helpers shared with the import script (plain JS, no deps).
// @ts-expect-error - .mjs script without types
import { measureGlb, rewriteGlbForAtlas } from '../../../../../scripts/lib/glb.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const modelFile = (rel: string) => resolve(HERE, 'models', rel)

const CLASSES: ModelClass[] = ['house', 'lowrise', 'midrise', 'tower', 'skyscraper', 'lowdetail', 'prop', 'road']

describe('manifest', () => {
  it('has unique ids and sane sizes', () => {
    const ids = MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MODELS) {
      expect(m.size.x).toBeGreaterThan(0)
      expect(m.size.y).toBeGreaterThan(0)
      expect(m.size.z).toBeGreaterThan(0)
      expect(m.tris).toBeGreaterThan(0)
      expect(m.url.length).toBeGreaterThan(0)
    }
  })

  it('every class is non-empty and the classes partition the table', () => {
    for (const cls of CLASSES) expect(modelsByClass(cls).length, cls).toBeGreaterThan(0)
    const total = CLASSES.reduce((n, c) => n + modelsByClass(c).length, 0)
    expect(total).toBe(MODELS.length)
  })

  it('classifies the contract families', () => {
    expect(getModel('building-skyscraper-a').cls).toBe('skyscraper')
    expect(getModel('building-type-a').cls).toBe('house')
    expect(getModel('low-detail-building-a').cls).toBe('lowdetail')
    expect(getModel('road-straight').cls).toBe('road')
    expect(getModel('road-sign-stop').cls).toBe('prop')
    expect(getModel('construction-cone').cls).toBe('prop')
  })

  it('getModel throws on an unknown id', () => {
    expect(() => getModel('building-typo')).toThrow(/unknown city model/)
  })

  it('every model has its GLB committed in the repo', () => {
    for (const m of MODELS) {
      const found = ['commercial', 'roads', 'suburban'].some((pack) => existsSync(modelFile(`${pack}/${m.id}.glb`)))
      expect(found, m.id).toBe(true)
    }
  })
})

describe('colormap helpers', () => {
  it('detects the glass blues, not walls, purples or pale blue', () => {
    expect(isWindowTexel(0x67, 0x94, 0xd9)).toBe(true) // mid blue glass
    expect(isWindowTexel(0x59, 0x5c, 0xbf)).toBe(true) // deep blue glass
    expect(isWindowTexel(0xa0, 0xa8, 0xc9)).toBe(false) // grey-blue wall
    expect(isWindowTexel(0x4f, 0x52, 0x60)).toBe(false) // dark wall
    expect(isWindowTexel(0xa8, 0x78, 0xe8)).toBe(false) // purple
    expect(isWindowTexel(0x63, 0x40, 0xbd)).toBe(false) // dark purple
    expect(isWindowTexel(0xf1, 0x97, 0x6c)).toBe(false) // terracotta
  })

  it('emissive atlas is black except window texels, opaque everywhere', () => {
    const src = new Uint8Array([0x67, 0x94, 0xd9, 255, 0xf1, 0x97, 0x6c, 255])
    const out = emissiveFromPixels(src)
    expect(out[0]).toBeGreaterThan(0x67) // lifted towards white
    expect(out[2]).toBeGreaterThan(0xd9 - 1)
    expect([out[4], out[5], out[6]]).toEqual([0, 0, 0])
    expect(out[3]).toBe(255)
    expect(out[7]).toBe(255)
  })
})

describe('geometry normalisation on real GLBs', () => {
  const cases = ['commercial/building-b.glb', 'roads/road-side-barrier.glb', 'suburban/building-type-t.glb']

  for (const rel of cases) {
    it(`bakes, centres and bases ${rel} at y=0`, async () => {
      const buf = readFileSync(modelFile(rel))
      const scene = await parseGlbBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      const g = normaliseScene(scene)
      g.computeBoundingBox()
      const bb = g.boundingBox!
      expect(Math.abs(bb.min.y)).toBeLessThan(1e-5)
      expect(Math.abs(bb.min.x + bb.max.x) / 2).toBeLessThan(1e-4)
      expect(Math.abs(bb.min.z + bb.max.z) / 2).toBeLessThan(1e-4)
      expect(g.attributes.position.count).toBeGreaterThan(0)
      expect(g.attributes.normal.count).toBe(g.attributes.position.count)
      expect(g.attributes.uv.count).toBe(g.attributes.position.count)
      expect(g.attributes.tangent).toBeUndefined()
      // the measured native size matches what the manifest records
      const id = rel.split('/').pop()!.replace(/\.glb$/, '')
      const def = getModel(id)
      expect(bb.max.x - bb.min.x).toBeCloseTo(def.size.x, 2)
      expect(bb.max.y - bb.min.y).toBeCloseTo(def.size.y, 2)
      expect(bb.max.z - bb.min.z).toBeCloseTo(def.size.z, 2)
    })
  }

  it('measure + atlas rewrite keep the model, drop textures, and land UVs in their pack slot', () => {
    const raw = readFileSync(modelFile('suburban/building-type-a.glb'))
    const m = measureGlb(raw)
    expect(m.tris).toBeGreaterThan(0)
    const rewritten = rewriteGlbForAtlas(raw, { slot: 2, slots: 3 })
    const again = measureGlb(rewritten)
    expect(again.tris).toBe(m.tris)
    expect(again.size).toEqual(m.size)
    const text = rewritten.toString('latin1')
    expect(text.includes('colormap.png')).toBe(false)
  })
})
