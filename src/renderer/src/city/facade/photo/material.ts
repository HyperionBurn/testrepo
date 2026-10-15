import { Color, DataTexture, MeshStandardMaterial, RGBAFormat, UnsignedByteType, Vector4, type Texture } from 'three'
import { ATLAS_LAYOUT, type FacadeAtlas } from './layout'
import { FACADE_SETS } from './sets'
import { PHOTO_MAX_SETS, PHOTO_UNIFORM_NAMES, FRAGMENT_REPLACEMENTS, VERTEX_REPLACEMENTS, applyReplacements } from './shader'

export interface PhotoLighting {
  /** Night ambient multiplier on the albedo (0 = black, 1 = full). */
  ambient: number
  /** Warm city-light tint applied with the ambient. */
  ambientTint: Color
  /** Gain on emissive windows, shopfronts. */
  emissiveGain: number
  /** Shopfront band brightness. */
  shopGain: number
  /** Scale on the normal map slope. */
  normalScale: number
  /** Colour of roof faces (dark tar). */
  roofColor: Color
}

export const DEFAULT_PHOTO_LIGHTING: Readonly<Omit<PhotoLighting, 'ambientTint' | 'roofColor'>> = {
  ambient: 0.35,
  emissiveGain: 1.4,
  shopGain: 0.9,
  normalScale: 1.0,
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function placeholderTexture(rgba: [number, number, number, number]): DataTexture {
  const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat, UnsignedByteType)
  t.needsUpdate = true
  return t
}

/** Uniform objects shared by every material made from this module (one set of values per material). */
export function createPhotoUniforms() {
  const rect: Vector4[] = []
  const tile: Vector4[] = []
  const farAlb: Vector4[] = []
  const farEmi: Vector4[] = []
  for (let i = 0; i < PHOTO_MAX_SETS; i++) {
    rect.push(new Vector4(0, 0, 0, 0))
    tile.push(new Vector4(1, 1, 1, 1))
    farAlb.push(new Vector4(0, 0, 0, 0))
    farEmi.push(new Vector4(0, 0, 0, 0))
  }
  for (const cell of ATLAS_LAYOUT.cells) {
    if (cell.index >= PHOTO_MAX_SETS) continue
    const [u0, v0, du, dv] = cell.uvRect
    rect[cell.index].set(u0, v0, du, dv)
    const set = FACADE_SETS[cell.index]
    tile[cell.index].set(set.tileWidthM, set.tileHeightM, set.floors, set.bays)
    const a = cell.farAlbedo.map(srgbToLinear)
    const e = cell.farEmissive.map(srgbToLinear)
    farAlb[cell.index].set(a[0], a[1], a[2], 1)
    farEmi[cell.index].set(e[0], e[1], e[2], 1)
  }
  const lighting = DEFAULT_PHOTO_LIGHTING
  return {
    tPhotoAlbedo: { value: placeholderTexture([128, 128, 128, 255]) as Texture },
    tPhotoEmissive: { value: placeholderTexture([0, 0, 0, 255]) as Texture },
    tPhotoNormal: { value: placeholderTexture([128, 128, 255, 255]) as Texture },
    tPhotoOrm: { value: placeholderTexture([255, 180, 0, 255]) as Texture },
    uPhotoRect: { value: rect },
    uPhotoTile: { value: tile },
    uPhotoFarAlb: { value: farAlb },
    uPhotoFarEmi: { value: farEmi },
    uPhotoAmbient: { value: lighting.ambient },
    uPhotoAmbientTint: { value: new Color(1.0, 0.72, 0.46) },
    uPhotoEmissiveGain: { value: lighting.emissiveGain },
    uPhotoTime: { value: 0 },
    uPhotoNormalScale: { value: lighting.normalScale },
    uPhotoShopGain: { value: lighting.shopGain },
    uPhotoRoofColor: { value: new Color(0.035, 0.036, 0.04) },
  }
}

export type PhotoUniforms = ReturnType<typeof createPhotoUniforms>

export interface PhotoFacadeMaterial extends MeshStandardMaterial {
  userData: MeshStandardMaterial['userData'] & { photo: { uniforms: PhotoUniforms; instanced: boolean } }
}

/**
 * Photographic facade material. Per-vertex / per-instance inputs: aFacade (set index into
 * FACADE_SETS), aFacadeUV (x metres along the wall, y metres up from grade), aLit (0..1), aSeed (0..1).
 * With `instanced`, pass those as InstancedBufferAttributes; the shader is the same.
 * Bind the atlas with setFacadeAtlas() once loadFacadeAtlas() resolves; until then a neutral
 * placeholder is used.
 */
export function createPhotoFacadeMaterial(opts: { instanced: boolean; atlas?: FacadeAtlas }): PhotoFacadeMaterial {
  const uniforms = createPhotoUniforms()
  const material = new MeshStandardMaterial({
    color: new Color(0xffffff),
    roughness: 1,
    metalness: 1,
  }) as PhotoFacadeMaterial
  material.userData.photo = { uniforms, instanced: opts.instanced }
  material.customProgramCacheKey = () => `skyline-photo-facade-v1${opts.instanced ? '-instanced' : ''}`
  material.onBeforeCompile = (shader) => {
    for (const name of PHOTO_UNIFORM_NAMES) shader.uniforms[name] = uniforms[name]
    shader.vertexShader = applyReplacements(shader.vertexShader, VERTEX_REPLACEMENTS)
    shader.fragmentShader = applyReplacements(shader.fragmentShader, FRAGMENT_REPLACEMENTS)
  }
  if (opts.atlas) setFacadeAtlas(material, opts.atlas)
  return material
}

/** Binds the loaded atlas textures to a facade material. Textures keep their own mip/anisotropy settings. */
export function setFacadeAtlas(material: PhotoFacadeMaterial, atlas: FacadeAtlas): void {
  const u = material.userData.photo.uniforms
  u.tPhotoAlbedo.value = atlas.albedo
  u.tPhotoEmissive.value = atlas.emissive
  u.tPhotoNormal.value = atlas.normal
  u.tPhotoOrm.value = atlas.rough
  material.needsUpdate = true
}

/** Time-of-day and lighting knobs. The sky package drives these; partial updates are fine. */
export function setPhotoLighting(material: PhotoFacadeMaterial, p: Partial<PhotoLighting>): void {
  const u = material.userData.photo.uniforms
  if (p.ambient !== undefined) u.uPhotoAmbient.value = p.ambient
  if (p.ambientTint !== undefined) u.uPhotoAmbientTint.value.copy(p.ambientTint)
  if (p.emissiveGain !== undefined) u.uPhotoEmissiveGain.value = p.emissiveGain
  if (p.shopGain !== undefined) u.uPhotoShopGain.value = p.shopGain
  if (p.normalScale !== undefined) u.uPhotoNormalScale.value = p.normalScale
  if (p.roofColor !== undefined) u.uPhotoRoofColor.value.copy(p.roofColor)
}

/** Seconds, for the slow window flicker. */
export function setPhotoTime(material: PhotoFacadeMaterial, seconds: number): void {
  material.userData.photo.uniforms.uPhotoTime.value = seconds
}
