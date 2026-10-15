// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { KIT_BUILDINGS, KIT_EXCLUDED, KIT_GROUND, KIT_METERS_PER_UNIT, type KitStyle, type KitTier } from './kitManifest'
import { KIT_SCALE, bakeKitGeometry, parseKitScene } from './loader'
import { createKitMaterial } from './material'
import { KIT_EMISSIVE_GLSL } from './kitGlsl'
// The generator (pure JS, no deps). Same reader the import uses.
// @ts-expect-error - .mjs script without types
import { collect, tierFor } from '../../../../../scripts/kit/inspect_kit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GLB = resolve(HERE, 'models/city-kit.glb')
const STYLES: KitStyle[] = ['deco', 'glass', 'stone', 'concrete', 'brick', 'slab']
const TIERS: KitTier[] = ['supertall', 'tower', 'midrise', 'lowrise']

describe('kit manifest', () => {
  it('has unique ids and nodes, and one entry per real building', () => {
    expect(new Set(KIT_BUILDINGS.map((b) => b.id)).size).toBe(KIT_BUILDINGS.length)
    expect(new Set(KIT_BUILDINGS.map((b) => b.node)).size).toBe(KIT_BUILDINGS.length)
    expect(KIT_BUILDINGS.length).toBe(20)
    expect(KIT_BUILDINGS.map((b) => b.node)).not.toContain(KIT_GROUND.node)
  })

  it('keeps heights in the 30-450 m range with sensible tiers', () => {
    for (const b of KIT_BUILDINGS) {
      expect(b.heightM, b.id).toBeGreaterThanOrEqual(30)
      expect(b.heightM, b.id).toBeLessThanOrEqual(450)
      expect(tierFor(b.heightM), b.id).toBe(b.tier)
      expect(TIERS).toContain(b.tier)
      expect(STYLES).toContain(b.style)
    }
    const tallest = KIT_BUILDINGS.reduce((a, b) => (b.heightM > a.heightM ? b : a))
    expect(tallest.tier).toBe('supertall')
    expect(tallest.style).toBe('deco')
    expect(KIT_BUILDINGS.some((b) => b.tier === 'lowrise')).toBe(true)
  })

  it('derives height and footprint from the model size (1 unit = 160 m)', () => {
    for (const b of KIT_BUILDINGS) {
      expect(b.heightM).toBeCloseTo(b.size.y * KIT_METERS_PER_UNIT, 0)
      expect(b.footprintM.w).toBeCloseTo(b.size.x * KIT_METERS_PER_UNIT, 0)
      expect(b.footprintM.d).toBeCloseTo(b.size.z * KIT_METERS_PER_UNIT, 0)
      expect(b.tris).toBeGreaterThan(0)
    }
  })

  it('matches the GLB it was generated from (re-run the generator if this fails)', () => {
    const fresh = collect(GLB) as { buildings: { id: string; heightM: number; tris: number }[]; skipped: { node: string }[] }
    expect(KIT_BUILDINGS.map((b) => [b.id, b.heightM, b.tris])).toEqual(
      fresh.buildings.map((b) => [b.id, b.heightM, b.tris])
    )
    expect(KIT_EXCLUDED.map((e) => e.node)).toEqual(fresh.skipped.map((s) => s.node))
    expect(KIT_EXCLUDED.map((e) => e.node)).toContain('Object_44')
  })
})

describe('kit geometry', () => {
  const bytes = readFileSync(GLB)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

  it('bakes every building to base y=0, centred on x/z, heightM/10 tall', async () => {
    const { buildings, ground } = await parseKitScene(arrayBuffer)
    expect(buildings.size).toBe(KIT_BUILDINGS.length)
    for (const def of KIT_BUILDINGS) {
      const g = buildings.get(def.id)!.geometry
      g.computeBoundingBox()
      const bb = g.boundingBox!
      expect(Math.abs(bb.min.y), def.id).toBeLessThan(1e-4)
      expect((bb.min.x + bb.max.x) / 2, def.id).toBeLessThan(1e-3)
      expect((bb.min.z + bb.max.z) / 2, def.id).toBeLessThan(1e-3)
      expect(bb.max.y, def.id).toBeCloseTo(def.heightM / 10, 1)
      expect(bb.max.x - bb.min.x, def.id).toBeCloseTo(def.footprintM.w / 10, 1)
      expect(g.getAttribute('uv'), def.id).toBeDefined()
      expect(g.getAttribute('uv1'), def.id).toBeDefined()
      expect(g.getAttribute('normal'), def.id).toBeDefined()
    }
    expect(ground.getAttribute('uv')).toBeDefined()
    expect(KIT_SCALE).toBe(16)
  })

  it('keeps the winding outward when a transform mirrors', () => {
    const src = new BufferGeometry()
    src.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    src.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
    src.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2))
    const mirror = new Matrix4().makeScale(-1, 1, 1)
    const out = bakeKitGeometry(src, mirror, 1)
    const p = out.getAttribute('position')
    const a = new Vector3().fromBufferAttribute(p, 0)
    const b = new Vector3().fromBufferAttribute(p, 1)
    const c = new Vector3().fromBufferAttribute(p, 2)
    const n = b.clone().sub(a).cross(c.clone().sub(a))
    // source normal (0,0,1) mirrored in x stays +z; the mirrored triangle's geometric normal must agree with it
    expect(n.z).toBeGreaterThan(0)
  })
})

describe('kit material', () => {
  it('patches the day/night albedo and the lit-window emissive into the shader', () => {
    const mat = createKitMaterial({ instanced: true })
    expect(mat.defines?.KIT_INSTANCED).toBeDefined()
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <emissivemap_fragment>\n'
    }
    mat.onBeforeCompile(shader as never, null as never)
    expect(shader.fragmentShader).toContain('kitAlbedoNight')
    expect(shader.fragmentShader).toContain('kitEmissive')
    expect(shader.fragmentShader).toContain('uEmissiveGain')
    expect(shader.fragmentShader).not.toContain('#include <emissivemap_fragment>')
    expect(shader.fragmentShader).toContain('metalnessFactor *=')
    expect(shader.vertexShader).toContain('attribute float aLit')
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['uNight', 'uLit', 'uTime']))
    expect(KIT_EMISSIVE_GLSL).toContain('step( kitEm.a, vKitLit )')
  })
})
