// Generates resources/icon.png (512x512) and resources/icon.ico (single 256x256 PNG entry).
// Design: dark navy rounded square with five glowing cyan skyline bars. Pure Node, no image libs.
// Usage: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'resources')

// ---- PNG encoding -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // Each scanline is prefixed with filter byte 0 (None).
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- Rendering ----------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const mix = (a, b, t) => a + (b - a) * t
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

// Signed distance to a rounded rectangle (units: fraction of icon size). Negative inside.
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - r
}

const BG_TOP = hex('#16224a')
const BG_BOTTOM = hex('#05070f')
const GLOW = hex('#22d3ee')
const BAR_TOP = hex('#a5f3fc')
const BAR_BOTTOM = hex('#0e7490')

// Five bars: normalized x-centers, heights (fraction of icon) with a shared baseline.
const BAR_W = 0.085
const BAR_GAP = 0.045
const BASELINE = 0.8
const BAR_HEIGHTS = [0.24, 0.38, 0.29, 0.48, 0.33]
const barsLeft = (1 - (5 * BAR_W + 4 * BAR_GAP)) / 2
const BARS = BAR_HEIGHTS.map((h, i) => {
  const left = barsLeft + i * (BAR_W + BAR_GAP)
  const top = BASELINE - h
  return {
    cx: left + BAR_W / 2,
    cy: (top + BASELINE) / 2,
    hx: BAR_W / 2,
    hy: (BASELINE - top) / 2,
    r: 0.022,
    top,
    bottom: BASELINE
  }
})

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const aa = 1 / size // one pixel in normalized units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size

      // Rounded-square background, anti-aliased edge.
      const dBg = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.2)
      const bgA = clamp01(0.5 - dBg / aa)
      const bgT = clamp01(v * 0.8 + u * 0.2)
      let r = mix(BG_TOP[0], BG_BOTTOM[0], bgT)
      let g = mix(BG_TOP[1], BG_BOTTOM[1], bgT)
      let b = mix(BG_TOP[2], BG_BOTTOM[2], bgT)

      // Soft glow from every bar, clipped to the background shape.
      let glow = 0
      for (const bar of BARS) {
        const d = sdRoundRect(u, v, bar.cx, bar.cy, bar.hx, bar.hy, bar.r)
        glow += Math.exp(-Math.max(d, 0) / 0.045) * 0.55
      }
      glow = Math.min(glow, 1) * bgA
      r += GLOW[0] * glow * 0.9
      g += GLOW[1] * glow * 0.9
      b += GLOW[2] * glow * 0.9

      // Bars on top, vertical gradient, anti-aliased.
      for (const bar of BARS) {
        const d = sdRoundRect(u, v, bar.cx, bar.cy, bar.hx, bar.hy, bar.r)
        const barA = clamp01(0.5 - d / aa)
        if (barA <= 0) continue
        const t = clamp01((v - bar.top) / (bar.bottom - bar.top))
        const br = mix(BAR_TOP[0], BAR_BOTTOM[0], t)
        const bg2 = mix(BAR_TOP[1], BAR_BOTTOM[1], t)
        const bb = mix(BAR_TOP[2], BAR_BOTTOM[2], t)
        r = mix(r, br, barA)
        g = mix(g, bg2, barA)
        b = mix(b, bb, barA)
      }

      const i = (y * size + x) * 4
      px[i] = Math.round(clamp01(r) * 255)
      px[i + 1] = Math.round(clamp01(g) * 255)
      px[i + 2] = Math.round(clamp01(b) * 255)
      px[i + 3] = Math.round(bgA * 255)
    }
  }
  return px
}

// ---- ICO container (single PNG entry) ------------------------------------
function encodeIcoWithPng(size, png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // image count
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size // width (0 means 256)
  entry[1] = size >= 256 ? 0 : size // height
  entry[2] = 0 // palette colors
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8) // image data size
  entry.writeUInt32LE(header.length + entry.length, 12) // offset of image data
  return Buffer.concat([header, entry, png])
}

// ---- Main ---------------------------------------------------------------
mkdirSync(outDir, { recursive: true })

const png512 = encodePng(512, 512, renderIcon(512))
writeFileSync(resolve(outDir, 'icon.png'), png512)

const png256 = encodePng(256, 256, renderIcon(256))
writeFileSync(resolve(outDir, 'icon.ico'), encodeIcoWithPng(256, png256))

console.log('wrote resources/icon.png (512x512) and resources/icon.ico (256x256 PNG entry)')
