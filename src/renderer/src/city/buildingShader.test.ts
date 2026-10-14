import { describe, expect, it } from 'vitest'
import { MeshStandardMaterial, Texture } from 'three'
import { createBuildingMaterials, prepareModelMaterial } from './buildingShader'

// A stand-in for three's fragment shader: only the chunks the building patches replace.
const FRAGMENT = `#include <common>
#include <color_fragment>
#include <emissivemap_fragment>
#include <fog_fragment>
void main() {}`

function patched(): string {
  const { models } = createBuildingMaterials()
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: FRAGMENT }
  models.onBeforeCompile(shader as never, null as never)
  return shader.fragmentShader
}

describe('building materials and the emissive atlas', () => {
  it('the model fragment shader never reads the emissive atlas', () => {
    const src = patched()
    expect(src).not.toContain('#include <emissivemap_fragment>')
    expect(src).not.toMatch(/emissiveMap/)
  })

  it('window emission comes from the per-pane aWin path', () => {
    const src = patched()
    expect(src).toContain('vWin')
    expect(src).toMatch(/float lit = step\(hv, 0\.75\);/)
  })

  it('prepareModelMaterial binds only the colormap, never an emissive map', () => {
    const m = new MeshStandardMaterial()
    const map = new Texture()
    prepareModelMaterial(m, map)
    expect(m.map).toBe(map)
    expect(m.emissiveMap).toBeNull()
  })
})
