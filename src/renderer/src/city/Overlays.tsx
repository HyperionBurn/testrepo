// Things drawn on top of the buildings: scaffolding for files being edited (cages that rise from the ground
// and carry a scan line), the selection spotlight, and import arcs (outgoing cyan, incoming magenta) for the
// selected building. The cages are one line mesh and two instanced meshes, whatever the number of agents.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { QuadraticBezierLine } from '@react-three/drei'
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry, DoubleSide,
  DynamicDrawUsage, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, MeshBasicMaterial,
  Object3D, Quaternion, ShaderMaterial, Vector3
} from 'three'
import type { CityBuilding, CityLayout, FileNode } from '@shared/types'
import { findBuilding } from '@shared/layout'
import { visCenter, visHeight } from './geom'
import { useSky } from '../state/store'
import { useDroneSources } from './data'
import { fxCtx, registerFx, type FxCtx, type FxSystem } from './fx/core'
import { easeOutCubic, unitHash } from './fx/model'

// ---------------------------------------------------------------------------------------------
// Scaffolding: a wire cage around each building an agent is editing. The cage rises from the ground over
// CAGE_GROW_S, and a scan line climbs it. All cages share one line mesh and two instanced meshes.

const MAX_CAGES = 16
const CAGE_GROW_S = 1.2
const CUBE_EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]
]

interface Cage {
  used: boolean
  file: string
  color: Color
  phase: number
  born: number
  b: CityBuilding | undefined
  bLayout: CityLayout | null
}

export class CageSystem implements FxSystem {
  readonly root = new Group()
  private readonly lines: LineSegments
  private readonly shell: InstancedMesh
  private readonly scan: InstancedMesh
  private readonly linePos = new Float32Array(MAX_CAGES * CUBE_EDGES.length * 2 * 3)
  private readonly lineCol = new Float32Array(MAX_CAGES * CUBE_EDGES.length * 2 * 3)
  private readonly cages: Cage[] = []
  private readonly lineGeo = new BufferGeometry()
  private readonly lineMat: LineBasicMaterial
  private readonly boxGeo = new BoxGeometry(1, 1, 1)
  private readonly shellMat: MeshBasicMaterial
  private readonly scanMat: MeshBasicMaterial
  private readonly m = new Matrix4()
  private readonly v = new Vector3()
  private readonly s = new Vector3()
  private readonly q = new Quaternion()
  private readonly tmp = new Color()
  private unreg: (() => void) | null = null

  constructor() {
    for (let i = 0; i < MAX_CAGES; i++) {
      this.cages.push({ used: false, file: '', color: new Color(), phase: 0, born: 0, b: undefined, bLayout: null })
    }
    this.lineGeo.setAttribute('position', new BufferAttribute(this.linePos, 3).setUsage(DynamicDrawUsage))
    this.lineGeo.setAttribute('color', new BufferAttribute(this.lineCol, 3).setUsage(DynamicDrawUsage))
    this.lineMat = new LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false
    })
    this.lines = new LineSegments(this.lineGeo, this.lineMat)
    this.lines.frustumCulled = false
    this.shellMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
    this.shell = new InstancedMesh(this.boxGeo, this.shellMat, MAX_CAGES)
    this.shell.frustumCulled = false
    this.scanMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
    this.scan = new InstancedMesh(this.boxGeo, this.scanMat, MAX_CAGES)
    this.scan.frustumCulled = false
    for (let i = 0; i < MAX_CAGES; i++) {
      this.shell.setMatrixAt(i, this.m.makeScale(0, 0, 0))
      this.scan.setMatrixAt(i, this.m.makeScale(0, 0, 0))
      this.shell.setColorAt(i, this.tmp.set(0, 0, 0))
      this.scan.setColorAt(i, this.tmp.set(0, 0, 0))
    }
    this.root.add(this.lines, this.shell, this.scan)
  }

  start(): void {
    if (this.unreg) return
    this.unreg = registerFx(this)
  }

  dispose(): void {
    this.unreg?.()
    this.unreg = null
    this.lineGeo.dispose()
    this.lineMat.dispose()
    this.boxGeo.dispose()
    this.shellMat.dispose()
    this.scanMat.dispose()
  }

  /** Assigns one cage per file being edited. Cages of files no longer edited are released. */
  sync(files: readonly { file: string; color: string }[]): void {
    const now = fxCtx.time
    for (const c of this.cages) {
      if (c.used && !files.some((f) => f.file === c.file)) c.used = false
    }
    for (const f of files) {
      let c = this.cages.find((x) => x.used && x.file === f.file)
      if (!c) {
        c = this.cages.find((x) => !x.used)
        if (!c) break
        c.used = true
        c.file = f.file
        c.born = now
        c.phase = unitHash(f.file, 5)
        c.b = undefined
        c.bLayout = null
      }
      c.color.set(f.color)
    }
  }

  update(_dt: number, ctx: FxCtx): void {
    const t = ctx.time
    const reduced = ctx.reduced
    const L = ctx.layout
    for (let i = 0; i < MAX_CAGES; i++) {
      const c = this.cages[i]!
      if (c.bLayout !== L) {
        c.bLayout = L
        c.b = L && c.used ? findBuilding(L, c.file) : undefined
      }
      const b = c.used ? c.b : undefined
      if (!b || !L) {
        this.collapse(i)
        continue
      }
      const grow = reduced ? 1 : easeOutCubic((t - c.born) / CAGE_GROW_S)
      const cen = visCenter(b, L)
      const H = visHeight(b, L) * 1.02 * grow
      const sx = b.w * 1.06
      const sz = b.d * 1.06
      const cx = cen.x
      const cz = cen.z
      // Wire frame: the 8 corners of the box, 12 edges.
      const base = i * CUBE_EDGES.length * 2
      for (let e = 0; e < CUBE_EDGES.length; e++) {
        const [a, bi] = CUBE_EDGES[e]!
        for (let end = 0; end < 2; end++) {
          const corner = end === 0 ? a : bi
          const vi = (base + e * 2 + end) * 3
          const px = (corner & 1 ? 0.5 : -0.5) * sx
          const pz = (corner & 2 ? 0.5 : -0.5) * sz
          const py = (corner & 4 ? 1 : 0) * H
          this.linePos[vi] = cx + px
          this.linePos[vi + 1] = py
          this.linePos[vi + 2] = cz + pz
          this.lineCol[vi] = c.color.r
          this.lineCol[vi + 1] = c.color.g
          this.lineCol[vi + 2] = c.color.b
        }
      }
      // Shell: a faint fill inside the cage.
      this.v.set(cx, H / 2, cz)
      this.s.set(sx, H, sz)
      this.q.identity()
      this.shell.setMatrixAt(i, this.m.compose(this.v, this.q, this.s))
      this.shell.setColorAt(i, this.tmp.copy(c.color).multiplyScalar(0.07))
      // Scan line: climbs the cage.
      const scanY = reduced ? H * 0.5 : ((t * 0.35 + c.phase) % 1) * H
      this.v.set(cx, scanY, cz)
      this.s.set(sx * 1.02, 0.03, sz * 1.02)
      this.scan.setMatrixAt(i, this.m.compose(this.v, this.q, this.s))
      this.scan.setColorAt(i, this.tmp.copy(c.color).multiplyScalar(0.55))
    }
    this.lineGeo.getAttribute('position').needsUpdate = true
    this.lineGeo.getAttribute('color').needsUpdate = true
    this.shell.instanceMatrix.needsUpdate = true
    this.scan.instanceMatrix.needsUpdate = true
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true
    if (this.scan.instanceColor) this.scan.instanceColor.needsUpdate = true
  }

  private collapse(i: number): void {
    const base = i * CUBE_EDGES.length * 2 * 3
    this.linePos.fill(0, base, base + CUBE_EDGES.length * 2 * 3)
    this.lineCol.fill(0, base, base + CUBE_EDGES.length * 2 * 3)
    this.shell.setMatrixAt(i, this.m.makeScale(0, 0, 0))
    this.scan.setMatrixAt(i, this.m.makeScale(0, 0, 0))
  }
}

/** Cages around the buildings agents are editing right now. */
export function Scaffolding() {
  const sources = useDroneSources()
  const [sys] = useState(() => new CageSystem())
  useEffect(() => {
    sys.start()
    return () => sys.dispose()
  }, [sys])
  const files = useMemo(
    () => sources.filter((s) => s.status === 'editing' && s.file).map((s) => ({ file: s.file!, color: s.color })),
    [sources]
  )
  useEffect(() => {
    sys.sync(files)
  }, [sys, files])
  return <primitive object={sys.root} />
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
  if (!b || !layout) return null
  return <SpotlightAt key={b.path} b={b} layout={layout} />
}

function SpotlightAt({ b, layout }: { b: CityBuilding; layout: CityLayout }) {
  const height = visHeight(b, layout) + 26
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

  const c = visCenter(b, layout)
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
      {layout && arcs.map((a) => (
        <Arc key={a.key} arc={a} layout={layout} />
      ))}
    </>
  )
}

function Arc({ arc, layout }: { arc: Arc; layout: CityLayout }) {
  const ref = useRef<Object3D & { material?: { dashOffset?: number } }>(null)
  const a = visCenter(arc.from, layout)
  const b = visCenter(arc.to, layout)
  const dx = b.x - a.x
  const dz = b.z - a.z
  const dist = Math.hypot(dx, dz)
  const start: [number, number, number] = [a.x, visHeight(arc.from, layout) + 0.4, a.z]
  const end: [number, number, number] = [b.x, visHeight(arc.to, layout) + 0.4, b.z]
  const mid: [number, number, number] = [
    (a.x + b.x) / 2,
    Math.max(visHeight(arc.from, layout), visHeight(arc.to, layout)) + 4 + dist * 0.22,
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
