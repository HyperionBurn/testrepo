import { describe, expect, it } from 'vitest'
import { Color, MeshStandardMaterial, Texture } from 'three'
import { createBuildingMaterials, createFacadeMaterial, prepareModelMaterial } from './buildingShader'
import { lightingUniforms } from './lighting'
import { PHOTO_UNIFORM_NAMES } from './facade/photo/shader'
import { MASSING_UV_GLSL } from './facade/massing'

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

/** Stand-ins for three's vertex and fragment shaders: only the chunks the building patches replace. */
const VERTEX = '#include <common>\n#include <begin_vertex>\n#include <defaultnormal_vertex>\nvoid main() {}'
const FRAG_FULL = `#include <common>
#include <map_fragment>
#include <color_fragment>
#include <roughnessmap_fragment>
#include <metalnessmap_fragment>
#include <normal_fragment_maps>
#include <emissivemap_fragment>
#include <lights_physical_fragment>
#include <opaque_fragment>
void main() {}`

function compiled(mat: MeshStandardMaterial): { uniforms: Record<string, unknown>; vertex: string; fragment: string } {
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: VERTEX, fragmentShader: FRAG_FULL }
  mat.onBeforeCompile(shader as never, null as never)
  return { uniforms: shader.uniforms, vertex: shader.vertexShader, fragment: shader.fragmentShader }
}

describe('facade material (photographic massing with the building overlay)', () => {
  it('takes its UVs in metres from the instance scale, not from a stored attribute', () => {
    const { vertex } = compiled(createBuildingMaterials().facade)
    expect(vertex).toContain(MASSING_UV_GLSL.trim().split('\n')[1]!.trim())
    expect(vertex).not.toContain('vFUV = aFacadeUV;')
  })

  it('reads day and night, and the window gain, from the shared lighting by reference', () => {
    const { uniforms } = compiled(createBuildingMaterials().facade)
    expect(uniforms.uNight).toBe(lightingUniforms.uNight)
    expect(uniforms.uPhotoEmissiveGain).toBe(lightingUniforms.uEmissiveGain)
    // The photo's own uniforms are all still bound.
    for (const name of PHOTO_UNIFORM_NAMES) expect(uniforms[name]).toBeDefined()
  })

  it('carries the overlay: heat, selection, hover, scanline, colour tint', () => {
    const { uniforms, fragment } = compiled(createBuildingMaterials().facade)
    expect(uniforms.uBldTime).toBeDefined()
    expect(uniforms.uBldTint).toBeDefined()
    expect(fragment).toContain('totalEmissiveRadiance += vOvGlowCol * ovGlow')
    expect(fragment).toContain('ovSel')
    expect(fragment).toContain('ovScan')
    expect(fragment).toContain('0.25 * uBldTint')
  })

  it('applies the night albedo through uNight (dim at night, full in day)', () => {
    const { fragment } = compiled(createBuildingMaterials().facade)
    expect(fragment).toContain('mix(vec3(1.0), uPhotoAmbientTint * uPhotoAmbient, uNight)')
    expect(fragment).not.toContain('gAlb = alb * orm.r * uPhotoAmbient * uPhotoAmbientTint;')
  })

  it('the metropolis haze is only in the far city materials', () => {
    const near = compiled(createBuildingMaterials().facade).fragment
    expect(near).not.toContain('uBldHazeK')
    const far = createFacadeMaterial({ time: { value: 0 }, tint: { value: 0 } }, { color: new Color('#442200'), k: 0.001 })
    const { uniforms, fragment } = compiled(far)
    expect(fragment).toContain('uBldHazeK')
    expect(uniforms.uBldHazeK).toBeDefined()
    expect(far.fog).toBe(false)
  })

  it('the fragment stage is balanced in braces and parentheses', () => {
    const { fragment } = compiled(createBuildingMaterials().facade)
    const count = (ch: string) => fragment.split(ch).length - 1
    expect(count('{')).toBe(count('}'))
    expect(count('(')).toBe(count(')'))
  })
})

describe('kit material (overlay and lighting)', () => {
  it('reads the shared night and emission by reference, and carries the overlay', () => {
    const { kit } = createBuildingMaterials()
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '#include <common>\n#include <begin_vertex>\nvoid main(){}', fragmentShader: FRAG_FULL }
    kit.onBeforeCompile(shader as never, null as never)
    expect(shader.uniforms.uNight).toBe(lightingUniforms.uNight)
    expect(shader.uniforms.uEmissiveGain).toBe(lightingUniforms.uEmissiveGain)
    expect(shader.fragmentShader).toContain('uBldTime')
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += vec3(0.8, 0.94, 1.0) * ovSel')
  })
})


describe('vertex attribute budget (WebGL allows 16 per program)', () => {
  // three adds position, normal, uv, uv1 and the four instanceMatrix columns: 8. The building materials may declare 8 more.
  const declared = (src: string) => (src.match(/^\s*attribute\s/gm) ?? []).length

  it('the facade material declares at most 8 attributes of its own', () => {
    const { vertex, fragment } = compiled(createBuildingMaterials().facade)
    expect(declared(vertex)).toBeLessThanOrEqual(8)
    expect(declared(fragment)).toBe(0)
  })

  it('the kit material declares at most 8, and none in its fragment stage', () => {
    const { kit } = createBuildingMaterials()
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: VERTEX, fragmentShader: FRAG_FULL }
    kit.onBeforeCompile(shader as never, null as never)
    expect(declared(shader.vertexShader)).toBeLessThanOrEqual(8)
    expect(declared(shader.fragmentShader)).toBe(0)
  })
})
