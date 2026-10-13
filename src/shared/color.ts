// Stable, vivid colors for agents, plus small hex/rgb helpers. Pure logic.

export interface Rgb { r: number; g: number; b: number }

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Parses #rgb or #rrggbb (the leading # is optional). Throws RangeError on anything else. */
export function hexToRgb(hex: string): Rgb {
  const m = HEX_RE.exec(hex.trim())
  const raw = m?.[1]
  if (!raw) throw new RangeError(`Invalid hex color: ${hex}`)
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const n = parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const to2 = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

/** HSL -> RGB. h in degrees [0,360), s and l in [0,1]. */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/** 32-bit FNV-1a over UTF-16 code units. Stable across runs and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Stable color for an agent id. The hash picks the hue; saturation and lightness are kept
 * high and in a narrow band so every agent glows instead of looking muddy.
 */
export function agentColor(id: string): string {
  const h = fnv1a(id)
  const hue = h % 360
  const sat = 0.82 + (((h >>> 9) % 10) / 100)  // 0.82..0.91
  const light = 0.6 + (((h >>> 17) % 8) / 100) // 0.60..0.67
  return rgbToHex(hslToRgb(hue, sat, light))
}
