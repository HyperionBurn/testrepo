// The sun: one DirectionalLight that follows the shared lighting uniforms (lighting.ts) and casts the shadows of the
// city. The shadow camera is fitted tightly to the repo district plus a margin (sunShadow.ts) and refitted every frame
// the sun moves. Shadows are view independent, so they cost the same whatever the camera does.
//
// Which meshes cast and receive (set by a traversal, see flagShadows): every opaque mesh receives. Opaque meshes that
// are not road, ground or water cast, unless userData.noShadow is set. New building meshes do not need to set the
// flags by hand, because the traversal runs again every SCAN_EVERY frames and on each layout change. Setting
// castShadow and receiveShadow on a new mesh is still the explicit, preferred way.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DirectionalLight, Mesh, PCFShadowMap, ShaderMaterial, Vector3, type Material, type Object3D, type Scene } from 'three'
import { useSky } from '../state/store'
import { LightingTransition, applyLighting, type LightingState } from './lighting'
import { boxCorners, layoutBounds, type ShadowBox } from './sunShadow'

/** Shadow map resolution. Over the ~2.4 km shadow box that is about 0.6 m per texel. */
const MAP_SIZE = 4096
/** Distance from the shadow box centre to the light, in world units. Only the frustum matters for an ortho light. */
const SUN_DISTANCE = 400
/** Below this sun intensity the sun is off (blue hour, night) and its shadow map is not rendered. */
const SUN_ON = 0.02
/** The mesh traversal runs every this many frames, which picks up meshes that mount later. */
const SCAN_EVERY = 30
/** Objects whose name or an ancestor's name matches this stay receive-only (flat surfaces would shadow themselves). */
const FLAT_NAME = /road|ground|water|lane|marking/i

/** Sets castShadow and receiveShadow for every mesh in the scene (idempotent). */
export function flagShadows(scene: Scene): void {
  scene.traverse((o: Object3D) => {
    const m = o as Mesh
    if (!m.isMesh) return
    const mats: Material[] = Array.isArray(m.material) ? m.material : [m.material]
    // Sky domes, atmosphere shells and other shader or transparent layers never take part in the shadow pass.
    const opaque = mats.every((mt) => !mt.transparent && !(mt as ShaderMaterial).isShaderMaterial)
    m.receiveShadow = opaque
    m.castShadow = opaque && !m.userData.noShadow && !isFlat(m)
  })
}

function isFlat(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) {
    if (FLAT_NAME.test(p.name)) return true
  }
  return false
}

/**
 * Fits the orthographic shadow camera of `light` to `box`. The camera is placed along sunDir and the box corners are
 * projected into its view, so the frustum is exactly the box, seen from the sun.
 */
export function fitShadowCamera(light: DirectionalLight, sunDir: Vector3, box: ShadowBox, corner: Vector3): void {
  const center = new Vector3(
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2
  )
  light.target.position.copy(center)
  light.position.copy(center).addScaledVector(sunDir, SUN_DISTANCE)
  light.target.updateMatrixWorld()
  light.updateMatrixWorld()
  const shadow = light.shadow
  shadow.updateMatrices(light)
  const cam = shadow.camera
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity, near = Infinity, far = -Infinity
  for (const [x, y, z] of boxCorners(box)) {
    corner.set(x, y, z).applyMatrix4(cam.matrixWorldInverse)
    left = Math.min(left, corner.x)
    right = Math.max(right, corner.x)
    bottom = Math.min(bottom, corner.y)
    top = Math.max(top, corner.y)
    near = Math.min(near, -corner.z)
    far = Math.max(far, -corner.z)
  }
  // A small pad keeps the edge texels inside the frustum. Near and far get a unit (10 m) each.
  cam.left = left - 0.05
  cam.right = right + 0.05
  cam.bottom = bottom - 0.05
  cam.top = top + 0.05
  cam.near = Math.max(0.1, near - 1)
  cam.far = far + 1
  cam.updateProjectionMatrix()
}

export function Sun() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const layout = useSky((s) => s.layout)
  const box = useMemo(() => layoutBounds(layout), [layout])
  const boxRef = useRef(box)
  boxRef.current = box

  const light = useMemo(() => {
    const l = new DirectionalLight('#ffffff', 0)
    l.castShadow = true
    l.shadow.mapSize.set(MAP_SIZE, MAP_SIZE)
    // World units are 10 m, so these are small: 0.02 is 20 cm of normal offset, enough for tall thin towers.
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 0.02
    l.shadow.radius = 1.5
    return l
  }, [])
  const transition = useMemo(() => new LightingTransition(useSky.getState().timeOfDay), [])
  const corner = useMemo(() => new Vector3(), [])
  const frame = useRef(0)
  const scanNow = useRef(true)

  useEffect(() => {
    applyLighting(transition.current)
    scene.add(light)
    scene.add(light.target)
    return () => {
      scene.remove(light)
      scene.remove(light.target)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
  }, [scene, light, transition])

  // A new layout means new meshes and a new district: scan the scene again on the next frame.
  useEffect(() => {
    scanNow.current = true
  }, [layout])

  useFrame((_, dt) => {
    // react-three-fiber resets shadowMap.enabled from the Canvas `shadows` prop whenever the Canvas props change, and
    // the Canvas has none, so the shadow settings are asserted here every frame. PCFSoftShadowMap was removed in this
    // three.js version; PCFShadowMap with shadow.radius gives the softness.
    gl.shadowMap.enabled = true
    gl.shadowMap.type = PCFShadowMap
    const st = useSky.getState()
    transition.setTarget(st.timeOfDay, !st.reducedMotion)
    transition.step(dt)
    const s: LightingState = transition.current
    applyLighting(s)
    light.color.copy(s.sunColor)
    light.intensity = s.sunIntensity
    const on = s.sunIntensity > SUN_ON
    light.castShadow = on
    if (on) fitShadowCamera(light, s.sunDir, boxRef.current, corner)

    frame.current += 1
    if (scanNow.current || frame.current % SCAN_EVERY === 0) {
      scanNow.current = false
      flagShadows(scene)
    }
  })

  return null
}
