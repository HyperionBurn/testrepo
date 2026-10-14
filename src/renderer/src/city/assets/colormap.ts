import { DataTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Texture } from 'three'
import { loadColormap } from './loader'

/**
 * Kenney atlas windows. The colormap is a palette: every texel is a flat colour strip, and the
 * lit-window strips are the saturated blues (blue-dominant, not purple, not grey-blue walls).
 * Measured on the stacked atlas: mid blues such as #6794d9 / #595cbf / #739edd match; pale
 * #d0e8ff, grey-blue walls #a0a8c9 and purples #a878e8 / #6340bd do not.
 */
export function isWindowTexel(r: number, g: number, b: number): boolean {
  return b - r >= 60 && g >= r && b >= g
}

/**
 * Pure: RGBA pixels in -> emissive RGBA out. Window texels are lifted towards white (they glow),
 * everything else is black so the emissive map adds nothing there. Alpha is always 255.
 */
export function emissiveFromPixels(src: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i], g = src[i + 1], b = src[i + 2]
    if (isWindowTexel(r, g, b)) {
      out[i] = Math.round(r + (255 - r) * 0.45)
      out[i + 1] = Math.round(g + (255 - g) * 0.45)
      out[i + 2] = Math.round(b + (255 - b) * 0.45)
    }
    out[i + 3] = 255
  }
  return out
}

let emissive: Promise<Texture> | null = null

/**
 * Emissive atlas, same size as the colormap: window texels bright, the rest black. Generated once
 * from the colormap pixels. Use as `material.emissiveMap` with `emissive = white` and bloom.
 */
export function loadEmissiveAtlas(): Promise<Texture> {
  if (!emissive) {
    emissive = loadColormap().then((cm) => {
      const img = cm.image as HTMLImageElement | ImageBitmap
      const w = img.width, h = img.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('2d canvas unavailable for emissive atlas')
      ctx.drawImage(img, 0, 0)
      const px = emissiveFromPixels(ctx.getImageData(0, 0, w, h).data)
      const tex = new DataTexture(px, w, h, RGBAFormat, UnsignedByteType)
      tex.colorSpace = SRGBColorSpace
      tex.flipY = false
      tex.minFilter = NearestFilter
      tex.magFilter = NearestFilter
      tex.generateMipmaps = false
      tex.needsUpdate = true
      return tex
    }).catch((err) => {
      emissive = null
      throw err
    })
  }
  return emissive
}
