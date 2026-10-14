import { BufferGeometry, Float32BufferAttribute, LinearMipmapLinearFilter, Mesh, NearestFilter, Object3D, SRGBColorSpace, Texture, TextureLoader } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { COLORMAP_URL, getModel, type ModelDef } from './manifest'
import { isWindowTexel, loadColormapPixels } from './colormap'
import { tagWindows } from './windows'

export interface LoadedModel {
  def: ModelDef
  /** One merged, normalised geometry: base at y=0, centred on x/z, native scale, uv into the shared atlas. */
  geometry: BufferGeometry
  /** The ONE colormap texture shared by every model. Materials use it as `map`. */
  map: Texture
}

export { getModel, modelsByClass, MODELS, type ModelDef, type ModelClass } from './manifest'

let colormap: Promise<Texture> | null = null

/**
 * Shared colormap (palette atlas): sRGB, no flip (glTF UV space). Mipmapped with linear-mip minification, so a
 * distant or close wall samples an average of its palette texels instead of one (the per-pixel speckle came from
 * nearest sampling of the dithered palette). Magnification stays nearest so close-ups keep their texel edges.
 */
export function loadColormap(): Promise<Texture> {
  if (!colormap) {
    colormap = new TextureLoader().loadAsync(COLORMAP_URL).then((tex) => {
      tex.colorSpace = SRGBColorSpace
      tex.flipY = false
      tex.minFilter = LinearMipmapLinearFilter
      tex.magFilter = NearestFilter
      tex.generateMipmaps = true
      tex.anisotropy = 4
      tex.needsUpdate = true
      return tex
    }).catch((err) => {
      colormap = null
      throw err
    })
  }
  return colormap
}

const models = new Map<string, Promise<LoadedModel>>()
let gltf: GLTFLoader | null = null

/** Bake node transforms, keep position/normal/uv, merge into one geometry, normalise the base. */
export function normaliseScene(scene: Object3D): BufferGeometry {
  scene.updateMatrixWorld(true)
  const parts: BufferGeometry[] = []
  scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    let g = mesh.geometry.clone()
    g.applyMatrix4(mesh.matrixWorld)
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
    }
    if (!g.attributes.uv) g.setAttribute('uv', new Float32BufferAttribute(g.attributes.position.count * 2, 2))
    if (!g.attributes.normal) g.computeVertexNormals()
    g = g.index ? g.toNonIndexed() : g
    parts.push(g)
  })
  if (parts.length === 0) throw new Error('model has no meshes')
  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error('could not merge model meshes')
  merged.computeBoundingBox()
  const bb = merged.boundingBox!
  merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

/** Parse a GLB from raw bytes (no network, no draco, no textures: the atlas is shared). */
export async function parseGlbBytes(bytes: ArrayBuffer): Promise<Object3D> {
  gltf ??= new GLTFLoader()
  const parsed = await gltf.parseAsync(bytes, '')
  return parsed.scene
}

/** Fetch the GLB bytes. Works in dev and packaged (file://) builds; see the note in manifest.ts. */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok && res.status !== 0) throw new Error(`fetch ${url}: ${res.status}`)
  return res.arrayBuffer()
}

/** Loads + caches one model. Rejects on unknown ids (getModel throws synchronously inside). */
export function loadModel(id: string): Promise<LoadedModel> {
  const def = getModel(id)
  let p = models.get(id)
  if (!p) {
    p = (async () => {
      const [bytes, map, px] = await Promise.all([fetchBytes(def.url), loadColormap(), loadColormapPixels()])
      const scene = await parseGlbBytes(bytes)
      const geometry = normaliseScene(scene)
      // Each window pane gets its own id (aWin), from the colormap texel under its UVs.
      tagWindows(geometry, (u, v) => {
        const x = Math.min(px.width - 1, Math.max(0, Math.floor(u * px.width)))
        const y = Math.min(px.height - 1, Math.max(0, Math.floor(v * px.height)))
        const i = (y * px.width + x) * 4
        return isWindowTexel(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!)
      })
      return { def, geometry, map }
    })()
    models.set(id, p)
    p.catch(() => models.delete(id))
  }
  return p
}

export function loadModels(ids: string[]): Promise<LoadedModel[]> {
  return Promise.all(ids.map((id) => loadModel(id)))
}

