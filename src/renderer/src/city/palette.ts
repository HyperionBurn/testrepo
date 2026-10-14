// Shared colour constants for the city look (hex, sRGB). Other city files import these so lights, windows,
// haze and signals match the sky. Pure: no three.js import, so the tests can check contrast without a renderer.

// Sky, blue hour (the default look). Zenith to horizon, as in the NYC dusk reference.
export const ZENITH = '#0b1636'
export const MID_BLUE = '#1d3a6b'
export const TEAL_DUSK = '#2c5b7a'
export const HORIZON = '#f08a5d'
export const HORIZON_PINK = '#d96a7a'

// Sky, night (light-pollution reference): near-black zenith, warm brown-orange band.
export const NIGHT_ZENITH = '#040508'
export const NIGHT_BROWN = '#2e1f16'
export const NIGHT_GLOW = '#e8924a'

// Sky, dawn: cool lilac up top, peach at the horizon.
export const DAWN_LILAC = '#4a4f96'
export const DAWN_PEACH = '#ffc49a'

// Light sources.
export const SODIUM = '#ffb056' // street lamps, sodium-orange avenues
export const WINDOW_WARM = '#ffc27a' // 2400 to 3200 K lit windows
export const WINDOW_COOL = '#cfe3ff' // the occasional cool-white or TV-blue window
export const SIGNAL_RED = '#ff3b30' // tail lights, aviation beacons
export const SIGNAL_GREEN = '#34d07a'
export const HEADLIGHT = '#fff4e0'

// Atmosphere.
export const HAZE_WARM = '#ff9a4a' // street-lit haze and light-pollution scatter
export const FOG_BLUE = '#3a4c74' // distant haze at blue hour
export const FOG_NIGHT = '#2e1f16' // distant haze at night
export const FOG_DAWN = '#b7a0c0' // distant haze at dawn

/** Parses #rrggbb into sRGB components in 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** WCAG relative luminance of an sRGB hex colour (0 black .. 1 white). */
export function relativeLuminance(hex: string): number {
  const lin = hexToRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
