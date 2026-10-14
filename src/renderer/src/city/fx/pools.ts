// Shared, pooled GPU objects for the FX: one Points object for every particle (sparks, bursts, fireworks)
// and one instanced mesh for every ground ring (shockwaves, test sweeps). Each is a module singleton, so the
// whole FX layer costs one draw call each, whatever runs at once.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, Matrix4, Points, Quaternion, RingGeometry, ShaderMaterial, Vector3
} from 'three'
import { registerFx, type FxCtx, type FxSystem } from './core'
import { easeOutCubic } from './model'

export const MAX_PARTICLES = 1000
export const MAX_RINGS = 32

const PARTICLE_VERT = `
attribute vec3 aColor;
attribute float aSize;
uniform float uPx;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(64.0, aSize * uPx / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`

const PARTICLE_FRAG = `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float f = clamp(1.0 - d, 0.0, 1.0);
  gl_FragColor = vec4(vColor * f * f, 1.0);
}`

const RING_VERT = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vC;
varying float vA;
varying vec2 vUv;
void main() {
  vC = aColor;
  vA = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const RING_FRAG = `
varying vec3 vC;
varying float vA;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float band = smoothstep(0.84, 0.95, r) * (1.0 - smoothstep(0.97, 1.0, r));
  gl_FragColor = vec4(vC * vA * band * 1.6, 1.0);
}`

const FLAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
const scratchM = new Matrix4()
const scratchP = new Vector3()
const scratchS = new Vector3()

export class ParticleSystem implements FxSystem {
  readonly object: Points
  private readonly geo = new BufferGeometry()
  private readonly mat: ShaderMaterial
  private readonly pos = new Float32Array(MAX_PARTICLES * 3)
  private readonly vel = new Float32Array(MAX_PARTICLES * 3)
  private readonly col = new Float32Array(MAX_PARTICLES * 3)
  private readonly tint = new Float32Array(MAX_PARTICLES * 3)
  private readonly size = new Float32Array(MAX_PARTICLES)
  private readonly baseSize = new Float32Array(MAX_PARTICLES)
  private readonly life = new Float32Array(MAX_PARTICLES)
  private readonly span = new Float32Array(MAX_PARTICLES)
  private readonly grav = new Float32Array(MAX_PARTICLES)
  private next = 0
  private readonly colAttr: BufferAttribute
  private readonly sizeAttr: BufferAttribute
  private readonly posAttr: BufferAttribute
  private readonly uPx = { value: 600 }

  constructor() {
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage)
    this.colAttr = new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage)
    this.sizeAttr = new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage)
    this.geo.setAttribute('position', this.posAttr)
    this.geo.setAttribute('aColor', this.colAttr)
    this.geo.setAttribute('aSize', this.sizeAttr)
    this.mat = new ShaderMaterial({
      uniforms: { uPx: this.uPx },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.object = new Points(this.geo, this.mat)
    this.object.frustumCulled = false
    registerFx(this)
  }

  activeCount(): number {
    let n = 0
    for (let i = 0; i < MAX_PARTICLES; i++) if ((this.life[i] ?? 0) > 0) n++
    return n
  }

  /** Emits one particle into the ring buffer (overwrites the oldest slot when full). Allocation-free. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: Color, size: number, life: number, gravity: number): void {
    const i = this.next
    this.next = (i + 1) % MAX_PARTICLES
    const k = i * 3
    this.pos[k] = x
    this.pos[k + 1] = y
    this.pos[k + 2] = z
    this.vel[k] = vx
    this.vel[k + 1] = vy
    this.vel[k + 2] = vz
    this.tint[k] = color.r
    this.tint[k + 1] = color.g
    this.tint[k + 2] = color.b
    this.baseSize[i] = size
    this.life[i] = life
    this.span[i] = life
    this.grav[i] = gravity
  }

  /** Sparks or a burst from a point: count particles spread over a cone of directions. */
  burst(x: number, y: number, z: number, count: number, speed: number, up: number, color: Color, life: number, gravity: number, rnd: () => number): void {
    for (let n = 0; n < count; n++) {
      const a = rnd() * Math.PI * 2
      const b = (rnd() * 2 - 1) * 0.9 + up
      const s = speed * (0.5 + rnd() * 0.7)
      const cb = Math.cos(b)
      this.emit(x, y, z, Math.cos(a) * cb * s, Math.sin(b) * s, Math.sin(a) * cb * s, color, 0.35 + rnd() * 0.25, life * (0.7 + rnd() * 0.5), gravity)
    }
  }

  update(dt: number, ctx: FxCtx): void {
    if (ctx.camera && 'fov' in ctx.camera) {
      const fov = ((ctx.camera as { fov: number }).fov * Math.PI) / 360
      this.uPx.value = ctx.pxHeight / 2 / Math.tan(fov)
    }
    const drag = Math.exp(-dt * 0.8)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const l = this.life[i] ?? 0
      if (l <= 0) continue
      const left = l - dt
      const k = i * 3
      if (left <= 0) {
        this.life[i] = 0
        this.size[i] = 0
        this.col[k] = 0
        this.col[k + 1] = 0
        this.col[k + 2] = 0
        continue
      }
      this.life[i] = left
      const vy = (this.vel[k + 1] ?? 0) + (this.grav[i] ?? 0) * dt
      this.vel[k + 1] = vy
      this.vel[k] = (this.vel[k] ?? 0) * drag
      this.vel[k + 2] = (this.vel[k + 2] ?? 0) * drag
      this.pos[k] = (this.pos[k] ?? 0) + (this.vel[k] ?? 0) * dt
      this.pos[k + 1] = (this.pos[k + 1] ?? 0) + vy * dt
      this.pos[k + 2] = (this.pos[k + 2] ?? 0) + (this.vel[k + 2] ?? 0) * dt
      const f = Math.min(1, left / (this.span[i] || 1))
      const fade = f * f
      this.col[k] = (this.tint[k] ?? 0) * fade * 2.2
      this.col[k + 1] = (this.tint[k + 1] ?? 0) * fade * 2.2
      this.col[k + 2] = (this.tint[k + 2] ?? 0) * fade * 2.2
      this.size[i] = (this.baseSize[i] ?? 0) * (0.35 + 0.65 * f)
    }
    this.posAttr.needsUpdate = true
    this.colAttr.needsUpdate = true
    this.sizeAttr.needsUpdate = true
  }
}

export class RingSystem implements FxSystem {
  readonly object: InstancedMesh
  private readonly geo: RingGeometry
  private readonly mat: ShaderMaterial
  private readonly active = new Uint8Array(MAX_RINGS)
  private readonly x = new Float32Array(MAX_RINGS)
  private readonly z = new Float32Array(MAX_RINGS)
  private readonly r0 = new Float32Array(MAX_RINGS)
  private readonly r1 = new Float32Array(MAX_RINGS)
  private readonly dur = new Float32Array(MAX_RINGS)
  private readonly age = new Float32Array(MAX_RINGS)
  private readonly strength = new Float32Array(MAX_RINGS)
  private readonly colors = new Float32Array(MAX_RINGS * 3)
  private readonly alphas = new Float32Array(MAX_RINGS)
  private next = 0

  constructor() {
    this.geo = new RingGeometry(0.8, 1, 96)
    this.geo.setAttribute('aColor', new InstancedBufferAttribute(this.colors, 3).setUsage(DynamicDrawUsage))
    this.geo.setAttribute('aAlpha', new InstancedBufferAttribute(this.alphas, 1).setUsage(DynamicDrawUsage))
    this.mat = new ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide
    })
    this.object = new InstancedMesh(this.geo, this.mat, MAX_RINGS)
    this.object.frustumCulled = false
    this.object.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < MAX_RINGS; i++) this.object.setMatrixAt(i, scratchM.makeScale(0, 0, 0))
    registerFx(this)
  }

  activeCount(): number {
    let n = 0
    for (let i = 0; i < MAX_RINGS; i++) n += this.active[i] ?? 0
    return n
  }

  /** A ground ring from radius r0 to r1 over dur seconds, fading out. Recycles the oldest when full. */
  spawn(x: number, z: number, r0: number, r1: number, dur: number, color: Color, strength: number): void {
    const i = this.next
    this.next = (i + 1) % MAX_RINGS
    this.active[i] = 1
    this.x[i] = x
    this.z[i] = z
    this.r0[i] = r0
    this.r1[i] = r1
    this.dur[i] = dur
    this.age[i] = 0
    this.strength[i] = strength
    this.colors[i * 3] = color.r
    this.colors[i * 3 + 1] = color.g
    this.colors[i * 3 + 2] = color.b
  }

  update(dt: number): void {
    let dirty = false
    for (let i = 0; i < MAX_RINGS; i++) {
      if (!this.active[i]) continue
      const age = (this.age[i] ?? 0) + dt
      this.age[i] = age
      const dur = this.dur[i] ?? 1
      const u = age / dur
      if (u >= 1) {
        this.active[i] = 0
        this.alphas[i] = 0
        this.object.setMatrixAt(i, scratchM.makeScale(0, 0, 0))
        dirty = true
        continue
      }
      const r = (this.r0[i] ?? 0) + ((this.r1[i] ?? 0) - (this.r0[i] ?? 0)) * easeOutCubic(u)
      const fade = (1 - u) * (1 - u)
      this.alphas[i] = (this.strength[i] ?? 1) * fade
      scratchP.set(this.x[i] ?? 0, 0.12, this.z[i] ?? 0)
      scratchS.set(r, r, r)
      scratchM.compose(scratchP, FLAT, scratchS)
      this.object.setMatrixAt(i, scratchM)
      dirty = true
    }
    if (dirty) {
      this.object.instanceMatrix.needsUpdate = true
      ;(this.geo.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true
      ;(this.geo.getAttribute('aColor') as InstancedBufferAttribute).needsUpdate = true
    }
  }
}

let particles: ParticleSystem | null = null
let rings: RingSystem | null = null

/** The shared particle system. Created on first use and registered with the FX registry. */
export function getParticles(): ParticleSystem {
  particles ??= new ParticleSystem()
  return particles
}

/** The shared ground-ring system. Created on first use and registered with the FX registry. */
export function getRings(): RingSystem {
  rings ??= new RingSystem()
  return rings
}
