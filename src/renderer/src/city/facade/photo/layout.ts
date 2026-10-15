import type { Texture } from 'three'
import layoutJson from './textures/facade-layout.json'

/** One atlas cell, as written by scripts/facades/build_atlas.py. */
export interface AtlasCell {
  index: number
  id: string
  tone: string
  mode: string
  col: number
  row: number
  cellPx: [number, number, number, number]
  contentPx: [number, number, number, number]
  /** Content rectangle in texture uv (flipY convention): u0, v0, du, dv. */
  uvRect: [number, number, number, number]
  floors: number
  bays: number
  tileWidthM: number
  tileHeightM: number
  bayWidthM: number
  floorHeightM: number
  /** Mip-averaged sRGB colours used beyond the clamped lod. */
  farAlbedo: [number, number, number]
  farEmissive: [number, number, number]
  notes: string
}

export interface AtlasLayout {
  version: number
  atlasSize: number
  cellSize: number
  gutter: number
  contentSize: number
  grid: number
  files: { albedo: string; emissive: string; normal: string; orm: string }
  source: string
  cells: AtlasCell[]
}

export const ATLAS_LAYOUT: AtlasLayout = layoutJson as AtlasLayout

export interface FacadeAtlas {
  /** sRGB albedo, wrapped gutters, 2048^2. */
  albedo: Texture
  /** sRGB emissive RGB; alpha is the per-window lit rank (255 = never lit). */
  emissive: Texture
  /** Tangent-space normal (OpenGL convention), linear. */
  normal: Texture
  /** R = ambient occlusion, G = roughness, B = metalness, linear. */
  rough: Texture
  layout: AtlasLayout
}
