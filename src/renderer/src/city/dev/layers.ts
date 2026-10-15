// Dev hooks for finding what draws where (window.__skylineLayers / __skylineHide / __skylineLighting). Every mesh gets a
// category tag: facade (photographic massing), kit, overlay (cages, FX, labels), road, ground (plates, water, sky),
// points, other-instanced, plain-mesh. __skylineHide(key, hide) toggles visibility by tag, uuid or name.
import { _roots } from '@react-three/fiber'
import type { Material, Object3D, Scene } from 'three'
import { lightingUniforms } from '../lighting'

export type LayerTag = 'facade' | 'kit' | 'overlay' | 'road' | 'ground' | 'points' | 'other-instanced' | 'plain-mesh' | 'other'

export interface LayerInfo {
  uuid: string;
  name: string;
  type: string;
  tag: LayerTag;
  materialType: string;
  visible: boolean;
  /** Instance count (instanced meshes) or vertex count (others). */
  count: number;
  /** World bounds of the object (from its geometry bounding box, transformed by its matrix when it has one). */
  min: [number, number, number];
  max: [number, number, number];
}

declare global {
  interface Window {
    __skylineLayers?: () => LayerInfo[];
    __skylineHide?: (key: string, hide?: boolean) => number;
    __skylineLighting?: () => { night: number };
  }
}

function sceneOf(): Scene | null {
  const canvas = document.querySelector('canvas')
  const root = canvas ? _roots.get(canvas) : undefined
  return root ? root.store.getState().scene : null
}

function ancestorNames(o: Object3D): string {
  const names: string[] = []
  for (let p: Object3D | null = o; p; p = p.parent) if (p.name) names.push(p.name)
  return names.join('/')
}

export function tagOf(o: Object3D): LayerTag {
  const anyO = o as Object3D & { isInstancedMesh?: boolean; isPoints?: boolean; isLine?: boolean; isLineSegments?: boolean; isMesh?: boolean; material?: Material | Material[] }
  const m = Array.isArray(anyO.material) ? anyO.material[0] : anyO.material
  const ud = (m?.userData ?? {}) as Record<string, unknown>
  if (ud.photo) return 'facade'
  if (ud.kitUniforms) return 'kit'
  const path = ancestorNames(o)
  if (/overlay|cage|scaff|constr|fx|sign|label|popup|tag|marker/i.test(path)) return 'overlay'
  if (/road|lane|street|marking|traffic|vehicle|bridge/i.test(path)) return 'road'
  if (/ground|plate|district|water|park|horizon|sky|backdrop|atmos|env/i.test(path)) return 'ground'
  if (anyO.isPoints || anyO.isLine || anyO.isLineSegments) return 'points'
  if (anyO.isInstancedMesh) return 'other-instanced'
  if (anyO.isMesh) return 'plain-mesh'
  return 'other'
}

function boundsOf(o: Object3D): { min: [number, number, number]; max: [number, number, number] } {
  const g = (o as Object3D & { geometry?: { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null } }).geometry
  if (!g) return { min: [0, 0, 0], max: [0, 0, 0] }
  const bb = g.boundingBox
  if (!bb) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] }
}

function list(): LayerInfo[] {
  const scene = sceneOf()
  if (!scene) return []
  const out: LayerInfo[] = []
  scene.traverse((o) => {
    const anyO = o as Object3D & { isMesh?: boolean; isInstancedMesh?: boolean; isPoints?: boolean; isLine?: boolean; isLineSegments?: boolean; count?: number; geometry?: { getAttribute: (n: string) => { count: number } | undefined }; material?: Material | Material[] }
    if (!anyO.isMesh && !anyO.isPoints && !anyO.isLine && !anyO.isLineSegments) return
    const mat = Array.isArray(anyO.material) ? anyO.material[0] : anyO.material
    const pos = anyO.geometry?.getAttribute('position')
    out.push({
      uuid: o.uuid,
      name: o.name,
      type: o.type,
      tag: tagOf(o),
      materialType: mat?.type ?? '',
      visible: o.visible,
      count: anyO.isInstancedMesh ? (anyO.count ?? 0) : (pos?.count ?? 0),
      ...boundsOf(o)
    })
  })
  return out
}

/** Sets visibility of every object whose uuid, name or tag matches key. Returns how many matched. */
function hide(key: string, hidden = true): number {
  const scene = sceneOf()
  if (!scene) return 0
  let n = 0
  scene.traverse((o) => {
    if (o.uuid === key || o.name === key || tagOf(o) === key) {
      o.visible = !hidden
      n++
    }
  })
  return n
}

if (typeof window !== 'undefined') {
  window.__skylineLayers = list
  window.__skylineHide = hide
  window.__skylineLighting = () => ({ night: lightingUniforms.uNight.value })
}
