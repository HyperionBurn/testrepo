// Things drawn on top of the buildings: scaffolding for files being edited, the selection spotlight,
// and import arcs (outgoing cyan, incoming magenta) for the selected building.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { QuadraticBezierLine } from '@react-three/drei'
import {
  AdditiveBlending, BoxGeometry, ConeGeometry, DoubleSide, EdgesGeometry, LineBasicMaterial, Mesh,
  MeshBasicMaterial, ShaderMaterial, CircleGeometry, Color, type Object3D
} from 'three'
import type { CityBuilding, CityLayout, FileNode } from '@shared/types'
import { findBuilding } from '@shared/layout'
import { visCenter, visHeight } from './geom'
import { useSky } from '../state/store'
import { useDroneSources, type DroneSource } from './data'

// ---------------------------------------------------------------------------------------------
// Scaffolding: a wire cage around each building an agent is editing, with a scan line climbing it.

export function Scaffolding() {
  const layout = useSky((s) => s.layout)
  const sources = useDroneSources()
  const editing = sources.filter((s) => s.status === 'editing' && s.file)
  if (!layout) return null
  return (
    <>
      {editing.map((s) => (
        <Cage key={s.id} src={s} layout={layout} />
      ))}
    </>
  )
}

function Cage({ src, layout }: { src: DroneSource; layout: CityLayout }) {
  const b = useMemo(() => (src.file ? findBuilding(layout, src.file) : undefined), [layout, src.file])
  const scanRef = useRef<Mesh>(null)
  const phase = useMemo(() => (src.id.length * 0.37) % 1, [src.id])
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), [])
  const shell = useMemo(() => new BoxGeometry(1, 1, 1), [])
  const color = useMemo(() => new Color(src.color), [src.color])
  const lineMat = useMemo(() => new LineBasicMaterial({
    color, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false
  }), [color])
  const shellMat = useMemo(() => new MeshBasicMaterial({
    color, transparent: true, opacity: 0.07, blending: AdditiveBlending, depthWrite: false, toneMapped: false
  }), [color])
  const scanMat = useMemo(() => new MeshBasicMaterial({
    color, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, toneMapped: false
  }), [color])
  const scanGeo = useMemo(() => new BoxGeometry(1.02, 0.012, 1.02), [])

  useEffect(() => () => {
    edges.dispose()
    shell.dispose()
    lineMat.dispose()
    shellMat.dispose()
    scanMat.dispose()
    scanGeo.dispose()
  }, [edges, shell, lineMat, shellMat, scanMat, scanGeo])

  useFrame(({ clock }) => {
    const m = scanRef.current
    if (!m) return
    const t = (clock.elapsedTime * 0.35 + phase) % 1
    m.position.y = t - 0.5
  })

  if (!b) return null
  const c = visCenter(b)
  const H = visHeight(b)
  return (
    <group position={[c.x, c.y, c.z]} scale={[b.w * 1.06, H * 1.02, b.d * 1.06]}>
      <lineSegments geometry={edges} material={lineMat} />
      <mesh geometry={shell} material={shellMat} />
      <mesh ref={scanRef} geometry={scanGeo} material={scanMat} />
    </group>
  )
}

// ---------------------------------------------------------------------------------------------
// Selection: a soft spotlight cone from above and a glow pool on the ground.

const CONE_VERT = `
varying float vY;
uniform float uH;
void main() {
  vY = (position.y + uH * 0.5) / uH; // 0 at the base, 1 at the apex
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const CONE_FRAG = `
uniform vec3 uColor;
varying float vY;
void main() {
  float a = 0.008 + 0.045 * pow(1.0 - vY, 2.2);
  gl_FragColor = vec4(uColor * a, a);
}`

const POOL_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

const POOL_FRAG = `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 2.5) * 0.22;
  gl_FragColor = vec4(uColor * a, a);
}`

export function Spotlight() {
  const layout = useSky((s) => s.layout)
  const selectedPath = useSky((s) => s.selectedPath)
  const b = useMemo(() => (layout && selectedPath ? findBuilding(layout, selectedPath) : undefined), [layout, selectedPath])
  if (!b) return null
  return <SpotlightAt key={b.path} b={b} />
}

function SpotlightAt({ b }: { b: CityBuilding }) {
  const height = visHeight(b) + 26
  const radius = Math.max(b.w, b.d) * 0.7 + 3
  const coneGeo = useMemo(() => new ConeGeometry(radius, height, 40, 1, true), [radius, height])
  const coneMat = useMemo(() => new ShaderMaterial({
    uniforms: { uH: { value: height }, uColor: { value: new Color('#9fd3ff') } },
    vertexShader: CONE_VERT,
    fragmentShader: CONE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide
  }), [height])
  const poolGeo = useMemo(() => new CircleGeometry(radius * 1.4, 48), [radius])
  const poolMat = useMemo(() => new ShaderMaterial({
    uniforms: { uColor: { value: new Color('#9fd3ff') } },
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }), [])

  useEffect(() => () => {
    coneGeo.dispose()
    coneMat.dispose()
    poolGeo.dispose()
    poolMat.dispose()
  }, [coneGeo, coneMat, poolGeo, poolMat])

  const c = visCenter(b)
  return (
    <>
      <mesh geometry={coneGeo} material={coneMat} position={[c.x, height / 2, c.z]} />
      <mesh geometry={poolGeo} material={poolMat} rotation={[-Math.PI / 2, 0, 0]} position={[c.x, 0.05, c.z]} />
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Import arcs for the selected building.

const MAX_ARCS = 120
const OUT_COLOR = '#22d3ee'
const IN_COLOR = '#e879f9'

interface Arc { key: string; from: CityBuilding; to: CityBuilding; out: boolean }

export function ImportArcs() {
  const repo = useSky((s) => s.repo)
  const layout = useSky((s) => s.layout)
  const show = useSky((s) => s.showImports)
  const selectedPath = useSky((s) => s.selectedPath)

  const arcs = useMemo<Arc[]>(() => {
    if (!show || !repo || !layout || !selectedPath) return []
    const sel = findBuilding(layout, selectedPath)
    if (!sel) return []
    const out: Arc[] = []
    const self: FileNode | undefined = repo.files.find((f) => f.path === selectedPath)
    for (const p of self?.imports ?? []) {
      const to = findBuilding(layout, p)
      if (to && to.path !== sel.path) out.push({ key: `o:${p}`, from: sel, to, out: true })
      if (out.length >= MAX_ARCS) break
    }
    for (const f of repo.files) {
      if (out.length >= MAX_ARCS) break
      if (!f.imports.includes(selectedPath)) continue
      const from = findBuilding(layout, f.path)
      if (from && from.path !== sel.path) out.push({ key: `i:${f.path}`, from, to: sel, out: false })
    }
    return out
  }, [repo, layout, show, selectedPath])

  return (
    <>
      {arcs.map((a) => (
        <Arc key={a.key} arc={a} />
      ))}
    </>
  )
}

function Arc({ arc }: { arc: Arc }) {
  const ref = useRef<Object3D & { material?: { dashOffset?: number } }>(null)
  const a = visCenter(arc.from)
  const b = visCenter(arc.to)
  const dx = b.x - a.x
  const dz = b.z - a.z
  const dist = Math.hypot(dx, dz)
  const start: [number, number, number] = [a.x, visHeight(arc.from) + 0.4, a.z]
  const end: [number, number, number] = [b.x, visHeight(arc.to) + 0.4, b.z]
  const mid: [number, number, number] = [
    (a.x + b.x) / 2,
    Math.max(visHeight(arc.from), visHeight(arc.to)) + 4 + dist * 0.22,
    (a.z + b.z) / 2
  ]
  useFrame(({ clock }) => {
    const m = ref.current?.material
    if (m && typeof m.dashOffset === 'number') m.dashOffset = -clock.elapsedTime * 0.6
  })
  return (
    <QuadraticBezierLine
      ref={ref as never}
      start={start}
      end={end}
      mid={mid}
      color={arc.out ? OUT_COLOR : IN_COLOR}
      lineWidth={1.4}
      dashed
      dashSize={1.4}
      gapSize={1.0}
      transparent
      opacity={0.85}
    />
  )
}
