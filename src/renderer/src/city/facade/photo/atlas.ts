import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace, Texture, TextureLoader } from 'three'
import albedoUrl from './textures/facade-albedo.jpg?url'
import emissiveUrl from './textures/facade-emissive.png?url'
import normalUrl from './textures/facade-normal.jpg?url'
import ormUrl from './textures/facade-orm.jpg?url'
import { ATLAS_LAYOUT, type FacadeAtlas } from './layout'

let cached: Promise<FacadeAtlas> | null = null

function prepare(tex: Texture, space: string, maxAnisotropy: number): Texture {
  tex.colorSpace = space === 'srgb' ? SRGBColorSpace : NoColorSpace
  tex.flipY = true
  tex.generateMipmaps = true
  tex.minFilter = LinearMipmapLinearFilter
  tex.magFilter = LinearFilter
  tex.anisotropy = Math.max(1, Math.min(16, maxAnisotropy))
  tex.needsUpdate = true
  return tex
}

/**
 * Loads the four facade atlases once (shared by every caller). `maxAnisotropy` should be
 * renderer.capabilities.getMaxAnisotropy(); the default is 8.
 */
export function loadFacadeAtlas(opts: { maxAnisotropy?: number } = {}): Promise<FacadeAtlas> {
  if (!cached) {
    const loader = new TextureLoader()
    const aniso = opts.maxAnisotropy ?? 8
    const load = (url: string) => loader.loadAsync(url)
    cached = Promise.all([load(albedoUrl), load(emissiveUrl), load(normalUrl), load(ormUrl)])
      .then(([albedo, emissive, normal, orm]) => ({
        albedo: prepare(albedo, 'srgb', aniso),
        emissive: prepare(emissive, 'srgb', aniso),
        normal: prepare(normal, 'linear', aniso),
        rough: prepare(orm, 'linear', aniso),
        layout: ATLAS_LAYOUT,
      }))
      .catch((err) => {
        cached = null
        throw err
      })
  }
  return cached
}
