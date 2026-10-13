// Ground: a dark plane with a fine grid that fades into the fog, district plates (stacked glass
// slabs, 0.08 units per depth) with luminous outlines, and top-level district names lying in the streets.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute,
  InstancedMesh, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, Quaternion, ShaderMaterial, SRGBColorSpace, Vector3
} from 'three'
import type { CityDistrict } from '@shared/types'
import { useSky } from '../state/store'
import { isClick } from './registry'
import { FOG_DENSITY, FOG_HEX } from './Sky'

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
      <planeGeometry args={[900, 900]} />
    </mesh>
  )
}

/** District plates, outlines and labels for one layout. */
export function Districts({ districts }: { districts: readonly CityDistrict[] }) {
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
      <DistrictLabels districts={districts} />
    </>
  )
}

interface Label { mesh: Mesh; mat: MeshBasicMaterial; tex: CanvasTexture; geo: PlaneGeometry; pos: Vector3 }

/** Canvas-rendered label (system font, no network). Lies flat in the street beside its district. */
function makeLabel(text: string, x: number, z: number): Label | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const font = '700 84px "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif'
  const label = text.toUpperCase()
  ctx.font = font
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '8px'
  const textW = Math.ceil(ctx.measureText(label).width)
  canvas.width = textW + 64
  canvas.height = 140
  ctx.font = font
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '8px'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#f1f6ff'
  ctx.shadowColor = '#5b9bff'
  ctx.shadowBlur = 28
  ctx.fillText(label, 32, 74)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  const height = 2.2
  const width = height * (canvas.width / canvas.height)
  const geo = new PlaneGeometry(width, height)
  // Labels ignore depth so towers in front do not hide the district names; they fade with distance instead.
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 })
  const mesh = new Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(x + width / 2, 0.1, z)
  mesh.raycast = () => {}
  mesh.renderOrder = 5
  return { mesh, mat, tex, geo, pos: mesh.position.clone() }
}

function DistrictLabels({ districts }: { districts: readonly CityDistrict[] }) {
  const labels = useMemo<Label[]>(() => {
    const out: Label[] = []
    for (const d of districts) {
      if (d.depth !== 1) continue
      // Centred in the 2.4 unit street just below the plate's min-z edge (its midline is 1.2 out).
      const l = makeLabel(d.name, d.x + 0.4, d.z - 1.2)
      if (l) out.push(l)
    }
    return out
  }, [districts])

  useEffect(() => () => {
    for (const l of labels) {
      l.tex.dispose()
      l.geo.dispose()
      l.mat.dispose()
    }
  }, [labels])

  useFrame(({ camera }) => {
    for (const l of labels) {
      const dist = camera.position.distanceTo(l.pos)
      const near = smooth(12, 30, dist)
      const far = 1 - smooth(200, 250, dist)
      l.mat.opacity = 0.8 * near * far
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
