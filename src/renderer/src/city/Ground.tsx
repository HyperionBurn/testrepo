// Ground: a dark plane with a fine grid that fades into the fog, district plates (stacked glass
// slabs, 0.08 units per depth) with luminous outlines, and neighborhood names lying on their plates.
import { useEffect, useMemo } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute,
  InstancedMesh, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Quaternion, ShaderMaterial, SRGBColorSpace, Vector3
} from 'three'
import type { CityDistrict } from '@shared/types'
import type { NeighborhoodIndex } from '@shared/layout'
import { useSky } from '../state/store'
import { isClick } from './registry'
import { FOG_DENSITY, FOG_HEX } from './Sky'
import { placeLabels, type LabelCandidate, type PlacedLabel } from './labelLayout'

const PLATE_HEIGHT_PER_DEPTH = 0.08

const GROUND_VERT = `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const GROUND_FRAG = `
uniform vec3 uBase;
uniform vec3 uGrid;
uniform vec3 uFog;
uniform float uDensity;
varying vec3 vW;
float gridLine(vec2 p, float s) {
  vec2 c = p / s;
  vec2 fw = max(fwidth(c), vec2(1e-5));
  vec2 g = abs(fract(c - 0.5) - 0.5) / fw;
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vW.xz;
  float glow = exp(-length(p) * 0.02);
  float fine = gridLine(p, 4.0);
  float major = gridLine(p, 20.0);
  vec3 col = uBase;
  col += uGrid * (fine * 0.10 + major * 0.26) * (0.12 + 0.88 * glow);
  col += vec3(0.02, 0.05, 0.13) * glow;
  // Beyond the city the plate is faintly mottled, so the ground reads as terrain, not a black void.
  float mott = sin(p.x * 0.013 + sin(p.y * 0.021)) * sin(p.y * 0.011 + 1.3) * 0.5 + 0.5;
  col *= 0.8 + 0.4 * mott;
  float dist = length(vW - cameraPosition);
  float fog = 1.0 - exp(-pow(dist * uDensity, 2.0));
  gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
}`

export function Ground() {
  const material = useMemo(() => new ShaderMaterial({
    uniforms: {
      uBase: { value: new Color('#03050b') },
      uGrid: { value: new Color('#3d6bff') },
      uFog: { value: new Color(FOG_HEX) },
      uDensity: { value: FOG_DENSITY }
    },
    vertexShader: GROUND_VERT,
    fragmentShader: GROUND_FRAG
  }), [])
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.01, 0]}
      material={material}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (isClick(e.clientX, e.clientY)) useSky.getState().select(null)
      }}
      onPointerOut={() => useSky.getState().hover(null)}
    >
      <planeGeometry args={[3200, 3200]} />
    </mesh>
  )
}

/** District plates, outlines and neighborhood labels for one layout. */
export function Districts({
  districts,
  hoods,
  areaColors
}: {
  districts: readonly CityDistrict[];
  hoods: NeighborhoodIndex | null;
  areaColors: ReadonlyMap<string, string> | null;
}) {
  const plateGeo = useMemo(() => {
    const g = new BoxGeometry(1, 1, 1)
    g.translate(0, 0.5, 0)
    return g
  }, [])
  const plateMat = useMemo(() => new MeshStandardMaterial({
    color: '#ffffff', roughness: 0.4, metalness: 0.3, envMapIntensity: 0.7
  }), [])

  const plates = useMemo(() => {
    const m = new InstancedMesh(plateGeo, plateMat, Math.max(1, districts.length))
    const mat = new Matrix4()
    const pos = new Vector3()
    const scale = new Vector3()
    const quat = new Quaternion()
    const c = new Color()
    districts.forEach((d, i) => {
      const hgt = PLATE_HEIGHT_PER_DEPTH * d.depth
      pos.set(d.x + d.w / 2, 0, d.z + d.d / 2)
      scale.set(d.w, hgt, d.d)
      mat.compose(pos, quat, scale)
      m.setMatrixAt(i, mat)
      c.setHSL(0.6, 0.45, 0.04 + Math.min(d.depth, 6) * 0.009)
      m.setColorAt(i, c)
    })
    m.count = districts.length
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    return m
  }, [districts, plateGeo, plateMat])

  const outlineGeo = useMemo(() => {
    const pos: number[] = []
    const col: number[] = []
    const c = new Color()
    for (const d of districts) {
      const y = PLATE_HEIGHT_PER_DEPTH * d.depth + 0.015
      const x0 = d.x, x1 = d.x + d.w, z0 = d.z, z1 = d.z + d.d
      const edges = [x0, z0, x1, z0, x1, z0, x1, z1, x1, z1, x0, z1, x0, z1, x0, z0]
      const k = d.depth === 1 ? 1.5 : d.depth === 2 ? 0.5 : 0.2
      c.setHSL((0.56 + d.depth * 0.04) % 1, 0.9, 0.6).multiplyScalar(k)
      for (let i = 0; i < edges.length; i += 2) {
        pos.push(edges[i] ?? 0, y, edges[i + 1] ?? 0)
        col.push(c.r, c.g, c.b)
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new Float32BufferAttribute(col, 3))
    return g
  }, [districts])

  const outlineMat = useMemo(() => new LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false
  }), [])

  useEffect(() => () => plates.dispose(), [plates])
  useEffect(() => () => {
    plateGeo.dispose()
    plateMat.dispose()
  }, [plateGeo, plateMat])
  useEffect(() => () => {
    outlineGeo.dispose()
    outlineMat.dispose()
  }, [outlineGeo, outlineMat])

  return (
    <>
      <primitive object={plates} />
      <lineSegments geometry={outlineGeo} material={outlineMat} />
      <NeighborhoodLabels districts={districts} hoods={hoods} areaColors={areaColors} />
    </>
  )
}

interface Label { mesh: Mesh; mat: MeshBasicMaterial; tex: CanvasTexture; geo: PlaneGeometry; pos: Vector3; h: number }

const LABEL_CANVAS_H = 128
const LABEL_PAD_PX = 28
const LABEL_FONT = '800 96px "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif'

let measureCtx: CanvasRenderingContext2D | null | undefined

function setLabelFont(ctx: CanvasRenderingContext2D): void {
  ctx.font = LABEL_FONT
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px'
}

/** Width of a label's canvas in pixels: the text plus padding. Falls back to a rough estimate without a canvas. */
function labelWidthPx(text: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return text.length * 58 + 2 * LABEL_PAD_PX
  setLabelFont(measureCtx)
  return Math.ceil(measureCtx.measureText(text).width) + 2 * LABEL_PAD_PX
}

/** Canvas aspect (width over height) of a label, as the placement sees it. */
function labelAspect(text: string): number {
  return labelWidthPx(text) / LABEL_CANVAS_H
}

/** Canvas-rendered label (system font, no network). Lies flat on its plate, centred on it. */
function makeLabel(p: PlacedLabel, glow: string): Label | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  canvas.width = labelWidthPx(p.key)
  canvas.height = LABEL_CANVAS_H
  setLabelFont(ctx)
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  // A dark halo keeps the name readable over towers, a hue glow ties it to its neighborhood.
  ctx.strokeStyle = 'rgba(3, 4, 10, 0.9)'
  ctx.lineWidth = 9
  ctx.shadowColor = glow
  ctx.shadowBlur = 26
  ctx.strokeText(p.key, LABEL_PAD_PX, LABEL_CANVAS_H / 2 + 4)
  ctx.fillStyle = '#f1f6ff'
  ctx.fillText(p.key, LABEL_PAD_PX, LABEL_CANVAS_H / 2 + 4)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  const width = p.w
  const geo = new PlaneGeometry(width, p.h)
  // Labels ignore depth so towers in front do not hide the names; they fade with distance and size instead.
  // Fog off: at framing distance the scene fog would wash a name into the sky color. Distance fades instead.
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 0 })
  const mesh = new Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(p.cx, 0.1, p.cz)
  mesh.raycast = () => {}
  mesh.renderOrder = 5
  return { mesh, mat, tex, geo, pos: mesh.position.clone(), h: p.h }
}

/**
 * Names for neighborhoods (the directories chosen by neighborhoodIndex), sized by plate area and placed without
 * overlaps (see placeLabels). Each glows in its neighborhood's hue.
 */
function NeighborhoodLabels({
  districts,
  hoods,
  areaColors
}: {
  districts: readonly CityDistrict[];
  hoods: NeighborhoodIndex | null;
  areaColors: ReadonlyMap<string, string> | null;
}) {
  const labels = useMemo<Label[]>(() => {
    if (!hoods) return []
    const plates = new Map(districts.map((d) => [d.name, d] as const))
    const cands: LabelCandidate[] = []
    for (const g of hoods.groups) {
      if (g.key === '') continue // root-level files have no plate
      const d = plates.get(g.key)
      if (!d) continue
      cands.push({ key: g.key, x: d.x, z: d.z, w: d.w, d: d.d, aspect: labelAspect(g.key) })
    }
    const out: Label[] = []
    for (const p of placeLabels(cands)) {
      const l = makeLabel(p, areaColors?.get(p.key) ?? '#5b9bff')
      if (l) out.push(l)
    }
    return out
  }, [districts, hoods, areaColors])

  useEffect(() => () => {
    for (const l of labels) {
      l.tex.dispose()
      l.geo.dispose()
      l.mat.dispose()
    }
  }, [labels])

  useFrame(({ camera, size }) => {
    // On-screen label height in pixels, from the camera's vertical field of view.
    const pxPerUnit = size.height / (2 * Math.tan(((camera as PerspectiveCamera).fov * Math.PI) / 360))
    for (const l of labels) {
      const dist = Math.max(1e-3, camera.position.distanceTo(l.pos))
      const legible = smooth(7, 13, (l.h * pxPerUnit) / dist)
      const near = smooth(10, 28, dist)
      const far = 1 - smooth(380, 520, dist)
      l.mat.opacity = 0.92 * near * far * legible
    }
  })

  return (
    <>
      {labels.map((l, i) => (
        <primitive key={i} object={l.mesh} />
      ))}
    </>
  )
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
