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

describe('facade shader (street-level anti-aliasing)', () => {
  function facadeFrag(): string {
    const { facade } = createBuildingMaterials()
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: FRAGMENT }
    facade.onBeforeCompile(shader as never, null as never)
    return shader.fragmentShader
  }

  it('fades panes to their average on screen-space derivatives, never a per-texel hash', () => {
    const src = facadeFrag()
    expect(src).toContain('fDetail = 1.0 - smoothstep(0.22, 0.45')
    expect(src).not.toMatch(/fhash\(vec3\(floor\(tex\)/)
  })

  it('takes the far average from one colour per building, not the colour of the pane under the pixel', () => {
    const src = facadeFrag()
    expect(src).toContain('fAvgWin')
    expect(src).not.toMatch(/fWinCol \* 0\.4/)
  })

  it('keeps pane emission under 1.2 intensity', () => {
    const src = facadeFrag()
    expect(src).toMatch(/mix\(fAvgWin, fWinCol, fDetail\) \* 0\.8 \* fMask/)
    expect(src).toMatch(/winCol \*= 0\.7 \+ 0\.6 \*/)
  })
})
