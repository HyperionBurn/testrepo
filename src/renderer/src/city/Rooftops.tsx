// Rooftop clutter for the city: water tanks on stilts, AC boxes, bulkheads and parapet lips, vent stacks, masts,
// spires, satellite dishes, rooftop gardens, helipads, lit crowns and the red aviation beacons on the spires.
// The plan is pure (roofs.ts) and cached per layout. Everything is instanced, one InstancedMesh per part, and the
// beacons are one Points object, so the whole set costs 10 draw calls. Blinking runs in the shader: no per-frame JS
// beyond the time uniform. Reduced motion freezes the blinks on.
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, BoxGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
  DoubleSide, Euler, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry,
  Points, Quaternion, ShaderMaterial, SRGBColorSpace, Vector3, type Material
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useSky } from '../state/store'
import { rooftopsFor, skylineCounts, type Beacon, type RoofItem, type RooftopPlan } from './roofs'
import { NIGHT_MIX_GLSL, lightingUniforms } from './lighting'

declare global {
  interface Window {
    /** Counts of the rooftop, sign and steam instances in the current city (tests and debugging). */
    __skylineRooftops?: () => { tanks: number; ac: number; beacons: number; signs: number; steamEmitters: number };
  }
}

const TANK_TONES = ['#6b5440', '#4a4d52', '#7a6a58', '#5b4a3e']
const BOX_LO = new Color('#2c3138')
const BOX_HI = new Color('#4b5058')
const LIP = new Color('#23272d')
const VENT = new Color('#3b3f46')
const MAST = new Color('#2a2e35')
const DISH = new Color('#c9ccd2')
const GARDEN_LO = new Color('#2f5b2c')
const GARDEN_HI = new Color('#44763a')
const BEACON_COLORS = { red: new Color('#ff2a1a'), white: new Color('#fff4e0'), green: new Color('#7dff9a') } as const

// ---- Unit geometry: every part has its base at y = 0 and a footprint of about 1 unit, so the instance scale sets
// its real size. ---------------------------------------------------------------------------------------------------

/** Water tank: four stilts, a wooden drum and a conical roof. Unit radius 1, height 1.2. */
function tankGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const stilt = new CylinderGeometry(0.035, 0.035, 0.3, 4).translate(0, 0.15, 0)
  for (const [x, z] of [[0.62, 0.62], [-0.62, 0.62], [0.62, -0.62], [-0.62, -0.62]] as const) {
    parts.push(stilt.clone().translate(x, 0, z))
  }
  parts.push(new CylinderGeometry(1, 1, 0.6, 12).translate(0, 0.6, 0))
  parts.push(new ConeGeometry(1.08, 0.3, 12).translate(0, 1.05, 0))
  return mergeGeometries(parts, false) ?? new BufferGeometry()
}

function boxGeometry(): BufferGeometry {
  return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
}

/** Vent stack: a flared pipe, unit radius, unit height. */
function ventGeometry(): BufferGeometry {
  return new CylinderGeometry(0.8, 1, 1, 8, 1).translate(0, 0.5, 0)
}

/** Antenna mast: a four-sided lattice column with a cross arm. Its thickness is set by the 0.07 radius. */
function mastGeometry(): BufferGeometry {
  const parts = [
    new CylinderGeometry(0.07, 0.11, 1, 4).translate(0, 0.5, 0),
    new BoxGeometry(0.5, 0.04, 0.04).translate(0, 0.7, 0)
  ]
  return mergeGeometries(parts, false) ?? new BufferGeometry()
}

/** Spire: a square tapering tower with a thin antenna. Unit base radius, unit height (the antenna tip is at 1.4). */
function spireGeometry(): BufferGeometry {
  const tower = new CylinderGeometry(0.2, 1, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)
  const antenna = new CylinderGeometry(0.03, 0.03, 0.4, 4).translate(0, 1.2, 0)
  return mergeGeometries([tower, antenna], false) ?? new BufferGeometry()
}

/** Satellite dish: an open bowl with a short stub. Unit radius, base at 0, opening upward. */
function dishGeometry(): BufferGeometry {
  const bowl = new CylinderGeometry(0.5, 0.06, 0.25, 14, 1, true).translate(0, 0.125, 0)
  const stub = new CylinderGeometry(0.05, 0.05, 0.3, 6).translate(0, -0.15, 0)
  return mergeGeometries([bowl, stub], false) ?? new BufferGeometry()
}

/** Lit crown: an open cone of warm light, wide at the roof and fading upward. Unit base radius, unit height. */
function crownGeometry(): BufferGeometry {
  return new CylinderGeometry(0.35, 1, 1, 16, 1, true).translate(0, 0.5, 0)
}

/** Helipad painted disc: a ring and an H on a transparent square. */
function helipadTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  if (g) {
    g.clearRect(0, 0, 256, 256)
    g.strokeStyle = 'rgba(235,240,255,0.92)'
    g.lineWidth = 14
    g.beginPath()
    g.arc(128, 128, 112, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = 'rgba(235,240,255,0.92)'
    g.font = 'bold 150px Arial, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('H', 128, 136)
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

const BEACON_VERT = `
uniform float uTime;
uniform float uPx;
uniform float uStatic;
uniform float uNight;
${NIGHT_MIX_GLSL}
attribute float aPhase;
attribute float aRate;
attribute float aKind;
attribute vec3 aColor;
varying vec3 vCol;
varying float vBlink;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = 0.5 + 0.5 * sin(6.2831853 * uTime * aRate + aPhase);
  // Aviation beacons: a sharp pulse, mostly dark. Helipad edge lights: a softer blink.
  float b = mix(pow(s, 6.0), smoothstep(0.1, 0.9, s), aKind);
  vBlink = (uStatic > 0.5 ? (aKind < 0.5 ? 0.9 : 0.6) : b) * mix(0.35, 1.0, nightMix(uNight));
  vCol = aColor;
  // By day a beacon is a small red point: smaller, and only faintly lit (see BEACON_FRAG).
  gl_PointSize = (aKind < 0.5 ? 9.0 : 4.5) * uPx * clamp(260.0 / -mv.z, 0.5, 3.0) * mix(0.45, 1.0, nightMix(uNight));
}`

const BEACON_FRAG = `
varying vec3 vCol;
varying float vBlink;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.0, 0.35, d);
  float halo = (1.0 - smoothstep(0.0, 1.0, d)) * 0.35;
  gl_FragColor = vec4(vCol * (core * 3.0 + halo) * vBlink, 1.0);
}`

const CROWN_VERT = `
varying float vY;
void main() {
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const CROWN_FRAG = `
uniform float uStrength;
varying float vY;
void main() {
  float a = pow(clamp(1.0 - vY, 0.0, 1.0), 1.6) * uStrength;
  gl_FragColor = vec4(vec3(1.0, 0.8, 0.5) * a, 1.0);
}`

/** Scratch objects reused across instances, so building the meshes allocates per mesh, not per instance. */
interface Scratch { m: Matrix4; c: Color; q: Quaternion; e: Euler; p: Vector3; s: Vector3 }

function instanced(
  geo: BufferGeometry, mat: Material, items: readonly RoofItem[], sc: Scratch,
  color: (it: RoofItem, out: Color) => void, orient: (it: RoofItem) => number = () => 0
): InstancedMesh | null {
  if (items.length === 0) return null
  const mesh = new InstancedMesh(geo, mat, items.length)
  items.forEach((it, i) => {
    sc.q.setFromEuler(sc.e.set(it.tilt, orient(it), 0, 'YXZ'))
    sc.m.compose(sc.p.set(it.x, it.y, it.z), sc.q, sc.s.set(it.sx, it.sy, it.sz))
    mesh.setMatrixAt(i, sc.m)
    color(it, sc.c)
    mesh.setColorAt(i, sc.c)
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
  return mesh
}

function lerpColor(a: Color, b: Color, t: number, out: Color): void {
  out.copy(a).lerp(b, t)
}

interface RooftopGroup {
  group: Group;
  beacons: Points | null;
  uniforms: { uTime: { value: number }; uPx: { value: number }; uStatic: { value: number }; uNight: { value: number } };
  dispose: () => void;
}

/** Builds the rooftop meshes for one plan. The caller keeps the result alive and disposes it when the plan changes. */
export function buildRooftopGroup(plan: RooftopPlan, pixelRatio: number, reduced: boolean): RooftopGroup {
  const group = new Group()
  const sc: Scratch = { m: new Matrix4(), c: new Color(), q: new Quaternion(), e: new Euler(), p: new Vector3(), s: new Vector3() }
  const solid = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.12 })
  const helipadMat = new MeshBasicMaterial({
    map: helipadTexture(), color: new Color(0.55, 0.6, 0.7), transparent: true, alphaTest: 0.2,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  })
  const crownMat = new ShaderMaterial({
    uniforms: { uStrength: { value: 0.32 } },
    vertexShader: CROWN_VERT,
    fragmentShader: CROWN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide
  })
  const uniforms = { uTime: { value: 0 }, uPx: { value: pixelRatio }, uStatic: { value: reduced ? 1 : 0 }, uNight: lightingUniforms.uNight }

  const tank = instanced(tankGeometry(), solid, plan.tanks, sc,
    (it, out) => out.set(TANK_TONES[Math.floor(it.tone * TANK_TONES.length)] ?? TANK_TONES[0]!))
  const boxes = instanced(boxGeometry(), solid, plan.boxes, sc, (it, out) => {
    if (it.kind === 'lip') out.copy(LIP)
    else lerpColor(BOX_LO, BOX_HI, it.tone, out)
  })
  const vents = instanced(ventGeometry(), solid, plan.vents, sc, (it, out) => lerpColor(VENT, BOX_HI, it.tone * 0.5, out))
  const masts = instanced(mastGeometry(), solid, plan.masts, sc, (_it, out) => out.copy(MAST))
  const spires = instanced(spireGeometry(), solid, plan.spires, sc, (_it, out) => out.copy(MAST))
  const dishes = instanced(dishGeometry(), solid, plan.dishes, sc, (it, out) => lerpColor(DISH, BOX_HI, it.tone * 0.3, out),
    (it) => it.rot)
  const gardens = instanced(boxGeometry(), solid, plan.gardens, sc,
    (it, out) => lerpColor(GARDEN_LO, GARDEN_HI, it.tone, out))
  const helipads = plan.helipads.length
    ? instanced(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), helipadMat, plan.helipads, sc, (_it, out) => out.set('#ffffff'))
    : null
  const crowns = instanced(crownGeometry(), crownMat, plan.crowns, sc, (_it, out) => out.set('#ffffff'))

  for (const m of [tank, boxes, vents, masts, spires, dishes, gardens, helipads, crowns]) {
    if (m) group.add(m)
  }

  const beacons = buildBeacons(plan.beacons, uniforms)
  if (beacons) group.add(beacons)

  return {
    group,
    beacons,
    uniforms,
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof InstancedMesh || o instanceof Mesh) o.geometry.dispose()
      })
      solid.dispose()
      helipadMat.dispose()
      crownMat.dispose()
      helipadMat.map?.dispose()
      if (beacons) {
        beacons.geometry.dispose()
        ;(beacons.material as ShaderMaterial).dispose()
      }
    }
  }
}

function buildBeacons(list: readonly Beacon[], uniforms: RooftopGroup['uniforms']): Points | null {
  if (list.length === 0) return null
  const n = list.length
  const pos = new Float32Array(n * 3)
  const phase = new Float32Array(n)
  const rate = new Float32Array(n)
  const kind = new Float32Array(n)
  const col = new Float32Array(n * 3)
  list.forEach((b, i) => {
    pos[i * 3] = b.x
    pos[i * 3 + 1] = b.y
    pos[i * 3 + 2] = b.z
    phase[i] = b.phase
    rate[i] = b.rate
    kind[i] = b.helipad ? 1 : 0
    const c = BEACON_COLORS[b.color]
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  })
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('aPhase', new BufferAttribute(phase, 1))
  geo.setAttribute('aRate', new BufferAttribute(rate, 1))
  geo.setAttribute('aKind', new BufferAttribute(kind, 1))
  geo.setAttribute('aColor', new BufferAttribute(col, 3))
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: BEACON_VERT,
    fragmentShader: BEACON_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
  const points = new Points(geo, mat)
  points.frustumCulled = false
  return points
}

export function Rooftops() {
  const layout = useSky((s) => s.layout)
  const reduced = useSky((s) => s.reducedMotion)
  const gl = useThree((s) => s.gl)
  const plan = useMemo(() => (layout ? rooftopsFor(layout) : null), [layout])
  const built = useMemo(
    () => (plan ? buildRooftopGroup(plan, gl.getPixelRatio(), reduced) : null),
    // The pixel ratio and motion setting are read from the store and the renderer when the plan changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan]
  )

  useEffect(() => () => built?.dispose(), [built])

  useEffect(() => {
    if (built) built.uniforms.uStatic.value = reduced ? 1 : 0
  }, [built, reduced])

  // Blinks run from the shared frame clock; reduced motion holds the time still, so the lights stay on.
  useFrame(({ clock }) => {
    if (built && !reduced) built.uniforms.uTime.value = clock.elapsedTime
  })

  useEffect(() => {
    if (!plan) return
    skylineCounts.tanks = plan.tanks.length
    skylineCounts.ac = plan.boxes.filter((b) => b.kind === 'ac').length
    skylineCounts.beacons = plan.beacons.length
    window.__skylineRooftops = () => ({
      tanks: plan.tanks.length,
      ac: plan.boxes.filter((b) => b.kind === 'ac').length,
      beacons: plan.beacons.length,
      signs: skylineCounts.signs,
      steamEmitters: skylineCounts.steamEmitters
    })
    return () => {
      if (window.__skylineRooftops) delete window.__skylineRooftops
    }
  }, [plan])

  if (!built) return null
  return <primitive object={built.group} />
}
