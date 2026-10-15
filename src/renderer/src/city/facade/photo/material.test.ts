import { ShaderChunk } from 'three'
import { describe, expect, it } from 'vitest'
import { createPhotoFacadeMaterial, setPhotoLighting, type PhotoFacadeMaterial } from './material'
import { FRAGMENT_REPLACEMENTS, PHOTO_UNIFORM_NAMES, VERTEX_REPLACEMENTS, applyReplacements } from './shader'

function compile(m: PhotoFacadeMaterial) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: ShaderChunk.meshphysical_vert,
    fragmentShader: ShaderChunk.meshphysical_frag,
  }
  m.onBeforeCompile(shader as never, null as never)
  return shader
}

describe('createPhotoFacadeMaterial', () => {
  it('is a MeshStandardMaterial with the photo program key', () => {
    const m = createPhotoFacadeMaterial({ instanced: false })
    expect(m.type).toBe('MeshStandardMaterial')
    expect(m.customProgramCacheKey()).toContain('skyline-photo-facade')
    expect(createPhotoFacadeMaterial({ instanced: true }).customProgramCacheKey()).not.toBe(m.customProgramCacheKey())
  })

  it('patches every chunk it names (throws otherwise)', () => {
    expect(() => applyReplacements(ShaderChunk.meshphysical_frag, FRAGMENT_REPLACEMENTS)).not.toThrow()
    expect(() => applyReplacements(ShaderChunk.meshphysical_vert, VERTEX_REPLACEMENTS)).not.toThrow()
  })

  it('only names chunks that exist in three.js', () => {
    const names = [...FRAGMENT_REPLACEMENTS, ...VERTEX_REPLACEMENTS].map(([from]) => from.replace(/#include <(.*)>/, '$1'))
    for (const n of names.filter((x) => !x.startsWith('#') && !x.includes(' '))) {
      expect(ShaderChunk, n).toHaveProperty(n)
    }
  })

  it('leaves no unpatched photo-chunk includes and no undefined text', () => {
    const shader = compile(createPhotoFacadeMaterial({ instanced: false }))
    for (const src of [shader.vertexShader, shader.fragmentShader]) {
      expect(src).not.toMatch(/undefined/)
      expect(src).not.toMatch(/#include <normal_fragment_maps>/)
      expect(src).not.toMatch(/#include <emissivemap_fragment>/)
      expect(src).not.toMatch(/#include <roughnessmap_fragment>/)
    }
  })

  it('declares every photo uniform and attribute it reads', () => {
    const shader = compile(createPhotoFacadeMaterial({ instanced: false }))
    for (const name of PHOTO_UNIFORM_NAMES) {
      expect(shader.fragmentShader, name).toContain(name)
      expect(shader.uniforms, name).toHaveProperty(name)
    }
    for (const attr of ['aFacade', 'aFacadeUV', 'aLit', 'aSeed']) {
      expect(shader.vertexShader, attr).toMatch(new RegExp(`attribute \\w+ ${attr};`))
    }
  })

  it('declares every varying the vertex shader writes', () => {
    const shader = compile(createPhotoFacadeMaterial({ instanced: false }))
    for (const v of ['vFacade', 'vLit', 'vSeed', 'vFUV', 'vWorldN']) {
      expect(shader.vertexShader, v).toMatch(new RegExp(`varying \\w+ ${v};`))
      expect(shader.fragmentShader, v).toMatch(new RegExp(`varying \\w+ ${v};`))
    }
  })

  it('every helper the fragment calls is defined', () => {
    const shader = compile(createPhotoFacadeMaterial({ instanced: false }))
    for (const fn of ['photoSample', 'photoNormal']) {
      expect(shader.fragmentShader).toMatch(new RegExp(`void ${fn}\\(\\)|vec3 ${fn}\\(`))
      expect(shader.fragmentShader).toContain(`${fn}(`)
    }
  })

  it('exposes time-of-day knobs that update the uniforms', () => {
    const m = createPhotoFacadeMaterial({ instanced: false })
    setPhotoLighting(m, { ambient: 0.1, emissiveGain: 2 })
    const u = m.userData.photo.uniforms
    expect(u.uPhotoAmbient.value).toBeCloseTo(0.1)
    expect(u.uPhotoEmissiveGain.value).toBe(2)
  })

  it('sets one uv rectangle and tile size per FACADE_SETS entry', () => {
    const u = createPhotoFacadeMaterial({ instanced: false }).userData.photo.uniforms
    expect(u.uPhotoRect.value[0].z).toBeGreaterThan(0.2)
    expect(u.uPhotoTile.value[0].x).toBeCloseTo(21)
    expect(u.uPhotoTile.value[0].z).toBe(6)
  })
})
