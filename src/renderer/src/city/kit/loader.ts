// Loads the city kit: the GLB (Low-poly City Buildings, CC-BY-4.0, smooth998) baked into one geometry per building,
// plus the textures this package derives from its atlas (see scripts/kit/build_night.py).
import {
  BufferGeometry, Group, LinearFilter, LinearMipmapLinearFilter, Matrix4, Mesh, NoColorSpace, SRGBColorSpace,
  Material, Texture, TextureLoader, type Object3D
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import glbUrl from './models/city-kit.glb?url'
import albedoUrl from './textures/kit-albedo.jpg?url'
import albedoNightUrl from './textures/kit-albedo-night.jpg?url'
import emissiveUrl from './textures/kit-emissive.png?url'
import metalRoughUrl from './textures/kit-metalrough.png?url'
import groundUrl from './textures/kit-ground.jpg?url'
import { KIT_BUILDINGS, KIT_GROUND, KIT_METERS_PER_UNIT, type KitBuilding } from './kitManifest'

/** World unit = 10 m. A model unit is KIT_METERS_PER_UNIT (160) m, so it scales by 16. */
export const KIT_SCALE = KIT_METERS_PER_UNIT / 10

export interface KitTextures {
  /** Day albedo, the 1024 atlas of photographed facades and roofs (sRGB). Used as `map`. */
  albedo: Texture
  /** Night albedo: walls dimmed and cooled, glass dark (sRGB). */
  albedoNight: Texture
  /** RGB = lit-window colour (sRGB), A = per-pane lit rank 0..1 (linear). */
  emissive: Texture
  /** Roughness in G, metalness in B; read from TEXCOORD_1 (the source's own mapping). */
  metalRough: Texture
  /** Aerial photo for the ground plane (sRGB). */
  ground: Texture
}

export interface KitBuildingGeometry {
  def: KitBuilding
  /** Base at y = 0, centred on x and z, in world units (heightM / 10 tall). Keeps uv and uv1. */
  geometry: BufferGeometry
}

export interface KitData {
  buildings: Map<string, KitBuildingGeometry>
  /** The flat ground plane, in world units. */
  ground: BufferGeometry
  textures: KitTextures
}

/**
 * Bakes one mesh's world geometry into the package's frame: applies the world matrix (normals follow), reverses the
 * winding when the transform mirrors, moves the base to y = 0, centres x and z, and scales to world units.
 * Pure: returns a new geometry; the source is not touched.
 */
export function bakeKitGeometry(source: BufferGeometry, world: Matrix4, scale = KIT_SCALE): BufferGeometry {
  const g = source.clone()
  g.applyMatrix4(world)
  if (world.determinant() < 0) flipWinding(g)
  g.computeBoundingBox()
  const bb = g.boundingBox!
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
  g.scale(scale, scale, scale)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

function flipWinding(g: BufferGeometry): void {
  const index = g.getIndex()
  if (index) {
    const a = index.array
    for (let t = 0; t < a.length; t += 3) {
      const tmp = a[t + 1]!
      a[t + 1] = a[t + 2]!
      a[t + 2] = tmp
    }
    index.needsUpdate = true
    return
  }
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name)
    const itemSize = attr.itemSize
    const arr = attr.array as Float32Array
    for (let v = 0; v + 2 < attr.count; v += 3) {
      for (let k = 0; k < itemSize; k++) {
        const tmp = arr[(v + 1) * itemSize + k]!
        arr[(v + 1) * itemSize + k] = arr[(v + 2) * itemSize + k]!
        arr[(v + 2) * itemSize + k] = tmp
      }
    }
    attr.needsUpdate = true
  }
}

/**
 * Parses the GLB and returns the baked buildings and ground. Embedded images are skipped (the package uses its own
 * textures), so this runs in node tests as well as in the renderer.
 */
export async function parseKitScene(bytes: ArrayBuffer): Promise<{ buildings: Map<string, KitBuildingGeometry>; ground: BufferGeometry }> {
  const loader = new GLTFLoader()
  loader.register(() => ({
    name: 'skyline-kit-skip-images',
    loadTexture: () => Promise.resolve(new Texture())
  }))
  const gltf = await loader.parseAsync(bytes, '')
  gltf.scene.updateMatrixWorld(true)

  const byNode = new Map(KIT_BUILDINGS.map((def) => [def.node, def]))
  const buildings = new Map<string, KitBuildingGeometry>()
  const found: { ground?: BufferGeometry } = {}
  gltf.scene.traverse((o: Object3D) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    if (mesh.name === KIT_GROUND.node) {
      found.ground = bakeKitGeometry(mesh.geometry, mesh.matrixWorld)
      return
    }
    const def = byNode.get(mesh.name)
    if (def) buildings.set(def.id, { def, geometry: bakeKitGeometry(mesh.geometry, mesh.matrixWorld) })
  })
  if (!found.ground) throw new Error(`kit ground ${KIT_GROUND.node} missing from city-kit.glb`)
  for (const def of KIT_BUILDINGS) if (!buildings.has(def.id)) throw new Error(`kit building ${def.node} missing from city-kit.glb`)
  return { buildings, ground: found.ground }
}

function atlasTexture(url: string, colorSpace: typeof SRGBColorSpace | typeof NoColorSpace): Promise<Texture> {
  return new TextureLoader().loadAsync(url).then((tex) => {
    tex.colorSpace = colorSpace
    tex.flipY = false // glTF UV space: v = 0 is the top row of the image
    tex.minFilter = LinearMipmapLinearFilter
    tex.magFilter = LinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 8
    tex.needsUpdate = true
    return tex
  })
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok && res.status !== 0) throw new Error(`fetch ${url}: ${res.status}`)
  return res.arrayBuffer()
}

let kit: Promise<KitData> | null = null

/** Loads and caches the kit. Works in dev and in the packaged file:// app (Vite ?url imports). */
export function loadKit(): Promise<KitData> {
  if (!kit) {
    kit = (async () => {
      const [bytes, albedo, albedoNight, emissive, metalRough, ground] = await Promise.all([
        fetchBytes(glbUrl),
        atlasTexture(albedoUrl, SRGBColorSpace),
        atlasTexture(albedoNightUrl, SRGBColorSpace),
        atlasTexture(emissiveUrl, SRGBColorSpace),
        atlasTexture(metalRoughUrl, NoColorSpace),
        atlasTexture(groundUrl, SRGBColorSpace)
      ])
      const scene = await parseKitScene(bytes)
      return { buildings: scene.buildings, ground: scene.ground, textures: { albedo, albedoNight, emissive, metalRough, ground } }
    })()
    kit.catch(() => { kit = null })
  }
  return kit
}

/** A group with one Mesh per building, all sharing `material` (previews and tests). */
export function kitGroup(data: KitData, material: Material, name = 'skyline-kit'): Group {
  const group = new Group()
  group.name = name
  for (const { geometry, def } of data.buildings.values()) {
    const mesh = new Mesh(geometry, material)
    mesh.name = def.id
    group.add(mesh)
  }
  return group
}
