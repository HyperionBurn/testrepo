// The kit material: MeshStandardMaterial with the day/night albedo mix and the lit-window emissive, patched in
// onBeforeCompile (see kitGlsl.ts for the shader pieces). One material serves every kit building.
import {
  DoubleSide, InstancedBufferAttribute, MeshStandardMaterial, type BufferGeometry, type Texture, type WebGLProgramParametersWithUniforms
} from 'three'
import { KIT_ATTRIBUTES_GLSL, KIT_EMISSIVE_GLSL, KIT_MAP_GLSL, KIT_UNIFORMS_GLSL, KIT_VERTEX_MAIN_GLSL } from './kitGlsl'
import type { KitTextures } from './loader'

/** glTF metallic/roughness factors of the source material (the maps carry the per-texel values). */
const ROUGHNESS = 0.896
const METALNESS = 0.115

export interface KitMaterialOptions {
  /** true: per-instance aLit / aSeed / aTint are read (InstancedMesh with kitInstanceAttributes). false: uLit for all. */
  instanced: boolean
}

export interface KitUniforms {
  kitAlbedoNight: { value: Texture | null }
  kitEmissive: { value: Texture | null }
  /** 0 = day albedo and no windows, 1 = night albedo and windows. */
  uNight: { value: number }
  /** Fraction of lit panes (0..1). Ignored when instanced (aLit wins). */
  uLit: { value: number }
  /** Seconds. Drives the slow pane blink. */
  uTime: { value: number }
  /** Emissive multiplier for lit panes (linear, HDR-ish). */
  uEmissiveGain: { value: number }
}

export function createKitMaterial(opts: KitMaterialOptions): MeshStandardMaterial {
  const uniforms: KitUniforms = {
    kitAlbedoNight: { value: null },
    kitEmissive: { value: null },
    uNight: { value: 0 },
    uLit: { value: 0.28 },
    uTime: { value: 0 },
    uEmissiveGain: { value: 1.6 }
  }
  const mat = new MeshStandardMaterial({ side: DoubleSide, roughness: ROUGHNESS, metalness: METALNESS })
  mat.defines = opts.instanced ? { KIT_INSTANCED: '' } : {}
  mat.userData.kitUniforms = uniforms
  mat.customProgramCacheKey = () => (opts.instanced ? 'skyline-kit-instanced-v1' : 'skyline-kit-v1')
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${KIT_UNIFORMS_GLSL}${KIT_ATTRIBUTES_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${KIT_VERTEX_MAIN_GLSL}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${KIT_UNIFORMS_GLSL}${KIT_ATTRIBUTES_GLSL}`)
      .replace('#include <map_fragment>', KIT_MAP_GLSL)
      .replace('#include <emissivemap_fragment>', KIT_EMISSIVE_GLSL)
  }
  return mat
}

/** Binds the decoded textures to a kit material. The albedo is `map`; the metal/rough map reads TEXCOORD_1. */
export function applyKitTextures(mat: MeshStandardMaterial, textures: KitTextures): void {
  mat.map = textures.albedo
  mat.roughnessMap = textures.metalRough
  mat.metalnessMap = textures.metalRough
  textures.metalRough.channel = 1
  const u = kitUniforms(mat)
  u.kitAlbedoNight.value = textures.albedoNight
  u.kitEmissive.value = textures.emissive
  mat.needsUpdate = true
}

export function kitUniforms(mat: MeshStandardMaterial): KitUniforms {
  const u = mat.userData.kitUniforms as KitUniforms | undefined
  if (!u) throw new Error('not a kit material (use createKitMaterial)')
  return u
}

export function setKitNight(mat: MeshStandardMaterial, night: number): void {
  kitUniforms(mat).uNight.value = Math.min(1, Math.max(0, night))
}

export function setKitLit(mat: MeshStandardMaterial, lit: number): void {
  kitUniforms(mat).uLit.value = Math.min(1, Math.max(0, lit))
}

export function setKitTime(mat: MeshStandardMaterial, seconds: number): void {
  kitUniforms(mat).uTime.value = seconds
}

/**
 * Per-instance attributes for an InstancedMesh: aLit (fraction of lit panes for that building), aSeed (0..1, drives
 * blinking) and aTint (multiplies the albedo; white = none). Deterministic for a given seed.
 */
export function kitInstanceAttributes(count: number, seed = 1): {
  aLit: InstancedBufferAttribute
  aSeed: InstancedBufferAttribute
  aTint: InstancedBufferAttribute
} {
  let s = seed >>> 0
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const lit = new Float32Array(count)
  const sd = new Float32Array(count)
  const tint = new Float32Array(count * 3).fill(1)
  for (let i = 0; i < count; i++) {
    lit[i] = 0.28
    sd[i] = rnd()
  }
  return {
    aLit: new InstancedBufferAttribute(lit, 1),
    aSeed: new InstancedBufferAttribute(sd, 1),
    aTint: new InstancedBufferAttribute(tint, 3)
  }
}

/** Attaches the instance attributes to a geometry (the InstancedMesh reads them per instance). */
export function attachKitInstanceAttributes(geometry: BufferGeometry, attrs: ReturnType<typeof kitInstanceAttributes>): void {
  geometry.setAttribute('aLit', attrs.aLit)
  geometry.setAttribute('aSeed', attrs.aSeed)
  geometry.setAttribute('aTint', attrs.aTint)
}
