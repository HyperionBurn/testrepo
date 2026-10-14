// Signage for the city: LED billboards that show live agent activity, neon blades and ground-floor marquees, placed by
// signs.ts. The billboards draw from two 1024 by 1024 canvas atlases (eight 512 by 256 slots each), redrawn at 2 Hz
// from the store: agent name in its colour, what it is doing, running cost, tokens, and a one-minute sparkline. The
// LED ticker and the animated colour bars are shader work, so they run smoothly without redrawing the canvas.
// Neon blades and marquees share one material. Three draw calls in all. Reduced motion freezes the animation and
// keeps the data at a slower refresh.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferAttribute, CanvasTexture, Color, DoubleSide, InstancedBufferAttribute, InstancedMesh, LinearFilter, Matrix4,
  PlaneGeometry, Quaternion, ShaderMaterial, SRGBColorSpace, Vector3, Euler, type Texture
} from 'three'
import type { AgentInfo, AgentEvent } from '@shared/types'
import { useSky } from '../state/store'
import { signsFor, skylineCounts } from './roofs'
import { ATLAS_COUNT, SLOTS_PER_ATLAS, type SignPlan, type SignSpec } from './signs'

declare global {
  interface Window {
    /** Re-draws the billboard atlases now, from the current store (tests). */
    __skylineSignsRedraw?: () => void;
    /** The planned signs of the current city (tests and debugging). */
    __skylineSignList?: () => SignSpec[];
  }
}

const ATLAS_PX = 1024
const SLOT_W = 512
const SLOT_H = 256
/** The bottom of each slot is the LED ticker band, drawn by the shader. Canvas content stays above it. */
const TICKER_FRAC = 0.2
const SPARK_BUCKETS = 24
const SPARK_WINDOW_MS = 60_000
const LIVE_MS = 500
const IDLE_MS = 2000

interface Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: CanvasTexture;
}

function makeAtlas(): Atlas {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ATLAS_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas unavailable')
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.generateMipmaps = false
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  return { canvas, ctx, tex }
}

/** Texture-space rectangle (u0, v0, u1, v1) of a slot. Canvas rows run top-down; texture v runs bottom-up. */
export function slotUv(slot: number): [number, number, number, number] {
  const col = slot % 2
  const row = Math.floor(slot / 2)
  const x0 = col * SLOT_W
  const y0 = row * SLOT_H
  return [x0 / ATLAS_PX, 1 - (y0 + SLOT_H) / ATLAS_PX, (x0 + SLOT_W) / ATLAS_PX, 1 - y0 / ATLAS_PX]
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Shortens text with an ellipsis until it fits in maxW pixels. */
function fit(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/** Per-agent event counts in SPARK_BUCKETS buckets over the last minute, from the store's events. */
export function sparklines(events: readonly AgentEvent[], now: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  const since = now - SPARK_WINDOW_MS
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k]!
    if (e.ts < since) break
    if (e.ts > now) continue
    let arr = out.get(e.agentId)
    if (!arr) {
      arr = new Float32Array(SPARK_BUCKETS)
      out.set(e.agentId, arr)
    }
    const i = Math.min(SPARK_BUCKETS - 1, Math.floor(((e.ts - since) / SPARK_WINDOW_MS) * SPARK_BUCKETS))
    arr[i] = arr[i]! + 1
  }
  return out
}

function drawSlot(g: CanvasRenderingContext2D, x0: number, y0: number, a: AgentInfo | null, spark: Float32Array | null): void {
  g.clearRect(x0, y0, SLOT_W, SLOT_H)
  const liveH = SLOT_H * (1 - TICKER_FRAC)
  if (!a) {
    g.textAlign = 'center'
    g.fillStyle = '#8fa0c0'
    g.font = 'bold 60px Arial, sans-serif'
    g.fillText('STANDBY', x0 + SLOT_W / 2, y0 + 112)
    g.font = '26px Arial, sans-serif'
    g.fillStyle = '#5d6b88'
    g.fillText('no agents on the wire', x0 + SLOT_W / 2, y0 + 156)
    return
  }
  g.textAlign = 'left'
  g.font = 'bold 20px Arial, sans-serif'
  g.fillStyle = '#ff4d5e'
  g.textAlign = 'right'
  g.fillText('LIVE', x0 + SLOT_W - 26, y0 + 34)
  g.textAlign = 'left'
  g.fillStyle = a.color || '#ffffff'
  g.font = 'bold 42px Arial, sans-serif'
  g.fillText(fit(g, a.name, 400), x0 + 28, y0 + 56)
  const file = a.currentFile ?? a.lastAction ?? ''
  g.font = '28px Arial, sans-serif'
  g.fillStyle = '#e6edff'
  g.fillText(fit(g, `${a.status} ${file}`.trim(), 456), x0 + 28, y0 + 104)
  g.font = 'bold 58px Arial, sans-serif'
  g.fillStyle = '#ffb347'
  g.fillText(`$${(a.costUsd || 0).toFixed(2)}`, x0 + 28, y0 + 170)
  g.font = '28px Arial, sans-serif'
  g.fillStyle = '#9fb0d0'
  g.fillText(`${fmtTokens((a.tokens?.input ?? 0) + (a.tokens?.output ?? 0))} tok`, x0 + 240, y0 + 166)
  // Sparkline: events per bucket over the last minute.
  if (spark) {
    const sx = x0 + 340, sy = y0 + 118, sw = 146, sh = 58
    let max = 1
    for (const v of spark) if (v > max) max = v
    g.beginPath()
    for (let i = 0; i < SPARK_BUCKETS; i++) {
      const px = sx + (i / (SPARK_BUCKETS - 1)) * sw
      const py = sy + sh - (spark[i]! / max) * sh
      if (i === 0) g.moveTo(px, py)
      else g.lineTo(px, py)
    }
    g.strokeStyle = a.color || '#ffffff'
    g.lineWidth = 3
    g.shadowColor = a.color || '#ffffff'
    g.shadowBlur = 8
    g.stroke()
    g.shadowBlur = 0
  }
  g.font = '16px Arial, sans-serif'
  g.fillStyle = '#56627e'
  g.textAlign = 'right'
  g.fillText('LAST MINUTE', x0 + SLOT_W - 26, y0 + liveH - 6)
  g.textAlign = 'left'
}

/** Paints one atlas: each slot shows one agent, the most recently active first, cycling when there are fewer. */
export function drawAtlas(atlas: Atlas, index: number, agents: readonly AgentInfo[], events: readonly AgentEvent[], now: number): void {
  const g = atlas.ctx
  g.clearRect(0, 0, ATLAS_PX, ATLAS_PX)
  const spark = sparklines(events, now)
  for (let s = 0; s < SLOTS_PER_ATLAS; s++) {
    const k = index * SLOTS_PER_ATLAS + s
    const a = agents.length ? agents[k % agents.length]! : null
    const col = (s % 2) * SLOT_W
    const row = Math.floor(s / 2) * SLOT_H
    drawSlot(g, col, row, a, a ? spark.get(a.id) ?? null : null)
  }
  atlas.tex.needsUpdate = true
}

const SHARED_VERT = `
attribute vec4 aSlot;
attribute float aSeed;
varying vec2 vUv;
varying vec4 vSlot;
varying float vSeed;
void main() {
  vUv = uv;
  vSlot = aSlot;
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const BILLBOARD_FRAG = `
uniform sampler2D uMap;
uniform float uTime;
uniform float uStatic;
varying vec2 vUv;
varying vec4 vSlot;
varying float vSeed;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 lu = vUv;
  vec2 tuv = mix(vSlot.xy, vSlot.zw, lu);
  vec4 tex = texture2D(uMap, tuv);
  vec3 col = vec3(0.025, 0.03, 0.045);
  float shift = uStatic > 0.5 ? 0.0 : uTime * 24.0;
  if (lu.y < ${TICKER_FRAC.toFixed(2)}) {
    // LED ticker: a 9-row dot matrix that scrolls, with lit runs of dots and a few amber and red ones.
    vec2 g = vec2(lu.x * 128.0 + shift + vSeed * 128.0, (lu.y / ${TICKER_FRAC.toFixed(2)}) * 9.0);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float on = step(0.45, h21(cell + vec2(vSeed * 71.0, 3.0)));
    float run = step(0.3, h21(vec2(floor(cell.x / 6.0), vSeed * 19.0)));
    float dot = 1.0 - smoothstep(0.28, 0.42, length(f));
    vec3 led = mix(vec3(1.0, 0.72, 0.28), vec3(1.0, 0.25, 0.25), step(0.72, h21(vec2(floor(cell.x / 9.0), 7.0 + vSeed))));
    col = mix(col, led * 2.2, dot * on * run);
  } else {
    col = col * (1.0 - tex.a) + tex.rgb * tex.a;
    // Animated colour bars at the right edge of the live area.
    float bx = (lu.x - 0.9) / 0.016;
    float bi = floor(bx);
    if (lu.x > 0.9 && lu.x < 0.98 && fract(bx) < 0.6) {
      float amp = uStatic > 0.5 ? 0.6 : 0.25 + 0.75 * abs(sin(uTime * (2.0 + bi * 0.7) + vSeed * 10.0 + bi));
      float on = step(lu.y, amp * 0.8 + 0.2);
      vec3 bar = mod(bi, 2.0) < 0.5 ? vec3(1.0, 0.7, 0.3) : vec3(0.35, 0.85, 1.0);
      col = mix(col, bar * 1.6, on * 0.9);
    }
  }
  // Bezel: a thin lit edge.
  float edge = min(min(lu.x, 1.0 - lu.x), min(lu.y, 1.0 - lu.y));
  col = mix(vec3(0.16, 0.2, 0.3), col, smoothstep(0.0, 0.025, edge));
  float fl = uStatic > 0.5 ? 1.0 : 0.95 + 0.05 * step(0.5, h21(vec2(floor(uTime * 9.0), vSeed * 100.0)));
  gl_FragColor = vec4(col * 1.35 * fl, 1.0);
}`

const NEON_VERT = `
attribute vec3 aColor;
attribute float aMode;
attribute vec2 aSize;
attribute float aSeed;
varying vec2 vUv;
varying vec3 vColor;
varying float vMode;
varying vec2 vSize;
varying float vSeed;
void main() {
  vUv = uv;
  vColor = aColor;
  vMode = aMode;
  vSize = aSize;
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const NEON_FRAG = `
uniform float uTime;
uniform float uStatic;
varying vec2 vUv;
varying vec3 vColor;
varying float vMode;
varying vec2 vSize;
varying float vSeed;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float t = uStatic > 0.5 ? 0.0 : uTime;
  vec3 col;
  if (vMode < 0.5) {
    // Neon blade: a lit tube around the edge, a bar across the upper third, a dark backing and a slight flicker.
    vec2 e = min(vUv, 1.0 - vUv);
    float edge = min(e.x, e.y);
    float tube = 1.0 - smoothstep(0.03, 0.07, edge);
    float bar = 1.0 - smoothstep(0.0, 0.025, abs(vUv.y - 0.74));
    float flick = 1.0;
    if (uStatic < 0.5) {
      float g = h21(vec2(floor(t * 5.0), vSeed * 50.0));
      flick = g < 0.04 ? 0.35 : 1.0;
    }
    col = vColor * (max(tube, bar * 0.8) * 2.4 + 0.04) * flick + vec3(0.02, 0.02, 0.03);
  } else {
    // Marquee: an LED dot matrix with lit runs that scroll left.
    float cols = max(4.0, floor(vSize.x * 7.0));
    float shift = uStatic > 0.5 ? 0.0 : floor(t * 14.0);
    vec2 g = vec2(vUv.x * cols + shift, vUv.y * 4.0);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float on = step(0.42, h21(cell + vec2(vSeed * 31.0, 1.0)));
    float dot = 1.0 - smoothstep(0.25, 0.42, length(f));
    col = vColor * (dot * on * 2.4 + 0.05);
  }
  gl_FragColor = vec4(col, 1.0);
}`

interface SignGroup {
  group: InstancedMesh[];
  atlases: { mesh: InstancedMesh; index: number }[];
  dispose: () => void;
}

/** Turns the plan into meshes: one billboard mesh per atlas, one neon mesh for blades and marquees. */
function buildSignMeshes(plan: SignPlan, atlases: Atlas[], shared: { uTime: { value: number }; uStatic: { value: number } }): SignGroup {
  const meshes: InstancedMesh[] = []
  const bindings: { mesh: InstancedMesh; index: number }[] = []
  const quat = new Quaternion()
  const euler = new Euler()
  const m = new Matrix4()
  const pos = new Vector3()
  const scl = new Vector3()

  for (let a = 0; a < ATLAS_COUNT; a++) {
    const list = plan.signs.filter((s): s is SignSpec & { slot: number } => s.kind === 'billboard' && s.atlas === a)
    if (list.length === 0) continue
    const geo = new PlaneGeometry(1, 1)
    const slot = new Float32Array(list.length * 4)
    const seed = new Float32Array(list.length)
    list.forEach((s, i) => {
      const [u0, v0, u1, v1] = slotUv(s.slot)
      slot.set([u0, v0, u1, v1], i * 4)
      seed[i] = s.seed
    })
    geo.setAttribute('aSlot', new InstancedBufferAttribute(slot, 4))
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seed, 1))
    const mat = new ShaderMaterial({
      uniforms: { uMap: { value: atlases[a]!.tex as Texture }, uTime: shared.uTime, uStatic: shared.uStatic },
      vertexShader: SHARED_VERT,
      fragmentShader: BILLBOARD_FRAG,
      side: DoubleSide
    })
    const mesh = new InstancedMesh(geo, mat, list.length)
    list.forEach((s, i) => {
      place(s, m, quat, euler, pos, scl)
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    meshes.push(mesh)
    bindings.push({ mesh, index: a })
  }

  const neon = plan.signs.filter((s) => s.kind !== 'billboard')
  if (neon.length) {
    const geo = new PlaneGeometry(1, 1)
    const color = new Float32Array(neon.length * 3)
    const mode = new Float32Array(neon.length)
    const size = new Float32Array(neon.length * 2)
    const seed = new Float32Array(neon.length)
    const c = new Color()
    neon.forEach((s, i) => {
      c.set(s.color)
      color.set([c.r, c.g, c.b], i * 3)
      mode[i] = s.kind === 'marquee' ? 1 : 0
      size.set([s.w, s.h], i * 2)
      seed[i] = s.seed
    })
    geo.setAttribute('aColor', new BufferAttribute(color, 3))
    geo.setAttribute('aMode', new BufferAttribute(mode, 1))
    geo.setAttribute('aSize', new BufferAttribute(size, 2))
    geo.setAttribute('aSeed', new BufferAttribute(seed, 1))
    const mat = new ShaderMaterial({
      uniforms: { uTime: shared.uTime, uStatic: shared.uStatic },
      vertexShader: NEON_VERT,
      fragmentShader: NEON_FRAG,
      side: DoubleSide
    })
    const mesh = new InstancedMesh(geo, mat, neon.length)
    neon.forEach((s, i) => {
      place(s, m, quat, euler, pos, scl)
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    meshes.push(mesh)
  }

  return {
    group: meshes,
    atlases: bindings,
    dispose: () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose()
        ;(mesh.material as ShaderMaterial).dispose()
      }
    }
  }
}

function place(s: SignSpec, m: Matrix4, q: Quaternion, e: Euler, p: Vector3, sc: Vector3): void {
  q.setFromEuler(e.set(0, s.yaw, 0))
  m.compose(p.set(s.x, s.y, s.z), q, sc.set(s.w, s.h, 1))
}

export function Signage() {
  const layout = useSky((s) => s.layout)
  const reduced = useSky((s) => s.reducedMotion)
  const plan = useMemo(() => (layout ? signsFor(layout) : null), [layout])
  const atlases = useMemo(() => [makeAtlas(), makeAtlas()], [])
  const shared = useMemo(() => ({ uTime: { value: 0 }, uStatic: { value: reduced ? 1 : 0 } }), [reduced])
  const built = useMemo(() => (plan ? buildSignMeshes(plan, atlases, shared) : null), [plan, atlases, shared])
  const lastDraw = useRef(0)

  useEffect(() => {
    shared.uStatic.value = reduced ? 1 : 0
  }, [reduced, shared])

  useEffect(() => () => {
    built?.dispose()
  }, [built])

  useEffect(() => () => {
    for (const a of atlases) a.tex.dispose()
  }, [atlases])

  const redraw = useMemo(() => () => {
    const st = useSky.getState()
    const now = Date.now()
    const agents = [...st.agents].sort((x, y) => y.lastActiveAt - x.lastActiveAt)
    for (let i = 0; i < atlases.length; i++) drawAtlas(atlases[i]!, i, agents, st.events, now)
    lastDraw.current = performance.now()
  }, [atlases])

  // Live text refreshes at 2 Hz (0.5 Hz with reduced motion). Animation runs from the frame clock.
  useFrame(({ clock }) => {
    if (!reduced) shared.uTime.value = clock.elapsedTime
    if (performance.now() - lastDraw.current >= (reduced ? IDLE_MS : LIVE_MS)) redraw()
  })

  useEffect(() => {
    redraw()
    window.__skylineSignsRedraw = redraw
    return () => {
      if (window.__skylineSignsRedraw === redraw) delete window.__skylineSignsRedraw
    }
  }, [redraw])

  useEffect(() => {
    skylineCounts.signs = plan?.signs.length ?? 0
    if (!plan) return
    window.__skylineSignList = () => plan.signs
    return () => {
      if (window.__skylineSignList) delete window.__skylineSignList
    }
  }, [plan])

  if (!built) return null
  return <>{built.group.map((mesh, i) => <primitive key={i} object={mesh} />)}</>
}
