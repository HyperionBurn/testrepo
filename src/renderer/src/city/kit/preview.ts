// Dev preview for screenshots: window.__skylineKitPreview('day' | 'night') puts every kit building in one row at the
// origin (and the ground plane under it), hides the rest of the city, and returns the building count.
// window.__skylineKitPreview('off') restores the city. The row is in world units (1 unit = 10 m).
import { _roots } from '@react-three/fiber'
import { Group, Light, Mesh, MeshStandardMaterial, type Object3D, PlaneGeometry, type Scene } from 'three'
import { KIT_BUILDINGS } from './kitManifest'
import { applyKitTextures, createKitMaterial, setKitLit, setKitNight, setKitTime } from './material'
import { loadKit } from './loader'

export type KitPreviewMode = 'day' | 'night' | 'off'

declare global {
  interface Window {
    __skylineKitPreview?: (mode: KitPreviewMode) => Promise<number>
  }
}

const GAP = 3 // world units (30 m) between buildings in the row
const hidden: Object3D[] = []
let group: Group | null = null

function sceneRoot(): Scene {
  const canvas = document.querySelector('canvas')
  const root = canvas ? _roots.get(canvas) : undefined
  if (!root) throw new Error('no R3F root: the city is not mounted')
  return root.store.getState().scene
}

function restore(): void {
  for (const o of hidden.splice(0)) o.visible = true
  if (group) {
    group.parent?.remove(group)
    group = null
  }
}

async function show(mode: 'day' | 'night'): Promise<number> {
  const scene = sceneRoot()
  const kit = await loadKit()
  restore()
  // Hide the city, keep lights (they set the time of day) and the preview itself.
  for (const child of scene.children) {
    if (child.visible && !(child as Light).isLight) {
      child.visible = false
      hidden.push(child)
    }
  }
  const mat = createKitMaterial({ instanced: false })
  applyKitTextures(mat, kit.textures)
  setKitNight(mat, mode === 'night' ? 1 : 0)
  setKitLit(mat, 0.4)
  setKitTime(mat, performance.now() / 1000)

  const root = new Group()
  root.name = 'skyline-kit-preview'
  const boxes = KIT_BUILDINGS.map((def) => {
    const { geometry } = kit.buildings.get(def.id)!
    return { def, geometry, box: geometry.boundingBox! }
  })
  const width = boxes.reduce((n, b) => n + (b.box.max.x - b.box.min.x), 0) + GAP * (boxes.length - 1)
  let x = -width / 2
  for (const { def, geometry, box } of boxes) {
    const mesh = new Mesh(geometry, mat)
    mesh.name = def.id
    const w = box.max.x - box.min.x
    mesh.position.x = x + w / 2
    x += w + GAP
    root.add(mesh)
  }
  const groundMat = new MeshStandardMaterial({ map: kit.textures.ground, roughness: 0.5, metalness: 0 })
  const ground = new Mesh(new PlaneGeometry(width + 40, 40), groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.set(0, -0.01, 0)
  root.add(ground)
  group = root
  scene.add(root)
  return boxes.length
}

window.__skylineKitPreview = async (mode: KitPreviewMode) => {
  if (mode === 'off') {
    restore()
    return 0
  }
  return show(mode)
}
