import { Group, Mesh, MeshStandardMaterial, PlaneGeometry, Scene, type WebGLRenderer } from 'three'
import { buildFacadeBox } from './geometry'
import { loadFacadeAtlas } from './atlas'
import { createPhotoFacadeMaterial, setPhotoTime, type PhotoFacadeMaterial } from './material'
import { PREVIEW_TOWERS } from './previewTowers'

/** Preview geometry is built in metres and placed at 1 world unit = 10 m. */
const WORLD_PER_M = 0.1
const SPACING_M = 50
const FOOTPRINT_M = [40, 30] as const

export interface PhotoPreview {
  group: Group
  material: PhotoFacadeMaterial
  /** Advance the flicker clock. */
  setTime(seconds: number): void
  dispose(): void
}

/**
 * Adds the preview row to `scene` and returns handles. The atlas is loaded (once) first.
 * Lighting defaults are for a night scene; use setPhotoLighting() on `material` to change them.
 */
export async function buildPhotoPreview(scene: Scene, opts: { renderer?: WebGLRenderer } = {}): Promise<PhotoPreview> {
  const maxAnisotropy = opts.renderer?.capabilities.getMaxAnisotropy() ?? 8
  const atlas = await loadFacadeAtlas({ maxAnisotropy })
  const material = createPhotoFacadeMaterial({ instanced: false, atlas })
  const group = new Group()
  group.name = 'photo-facade-preview'
  group.scale.setScalar(WORLD_PER_M)
  PREVIEW_TOWERS.forEach((t, i) => {
    const geo = buildFacadeBox({
      width: FOOTPRINT_M[0],
      depth: FOOTPRINT_M[1],
      height: t.heightM,
      facade: t.facade,
      lit: t.lit,
      seed: (i * 0.618034) % 1,
      x: (i - (PREVIEW_TOWERS.length - 1) / 2) * SPACING_M,
    })
    const mesh = new Mesh(geo, material)
    mesh.name = `preview-tower-${i}`
    group.add(mesh)
  })
  const ground = new Mesh(
    new PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: 0x14171d, roughness: 0.95, metalness: 0 }),
  )
  ground.name = 'preview-ground'
  group.add(ground)
  scene.add(group)
  return {
    group,
    material,
    setTime: (s) => setPhotoTime(material, s),
    dispose: () => {
      scene.remove(group)
      group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose()
      })
      material.dispose()
      ground.geometry.dispose()
      ;(ground.material as MeshStandardMaterial).dispose()
    },
  }
}

declare global {
  interface Window {
    __skylinePhotoPreview?: () => Promise<PhotoPreview>
  }
}

/**
 * Dev hook: window.__skylinePhotoPreview() mounts the row into `scene` and resolves to its handles.
 * Call once from a harness that owns the scene; the hook is removed by `dispose()`.
 */
export function registerPhotoPreviewHook(scene: Scene, renderer?: WebGLRenderer): void {
  let current: PhotoPreview | null = null
  window.__skylinePhotoPreview = async () => {
    current?.dispose()
    current = await buildPhotoPreview(scene, { renderer })
    return current
  }
}

